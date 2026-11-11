import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeEach, test} from 'node:test';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-ranges-')));
process.env.YENA_HOME = home;
process.env.YENA_DATA = path.join(home, 'data');
const {install, lockRoot, resolveModules, update} = await import('../../src/pm/manager.js');

const imageDir = path.join(home, 'modules');
const overlay = path.join(home, 'data', 'host', 'modules');
const overlayLock = path.join(home, 'data', 'host', 'yena-modules.json');
const out: string[] = [];
const log = (l: string) => void out.push(l);

type Deps = Record<string, {source: string; version: string; optional?: boolean}>;

async function writeModule(dir: string, name: string, version: string, extra: Record<string, unknown> = {}) {
	await mkdir(dir, {recursive: true});
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name, version, ...extra}));
	return dir;
}
const imageModule = (name: string, version: string, dependencies: Deps = {}) => writeModule(path.join(imageDir, name), name, version, {dependencies});
const source = (name: string, version: string, extra: Record<string, unknown> = {}) => writeModule(path.join(home, 'src', name), name, version, extra);
const dep = (name: string, version: string): Deps => ({[name]: {source: path.join(home, 'src', name), version}});
const versions = async () => Object.fromEntries((await resolveModules()).modules.map(m => [m.manifest.name, `${m.origin}@${m.manifest.version}`]));
const lockModules = async () => (JSON.parse(await readFile(overlayLock, 'utf8')) as {modules: Record<string, {version: string}>}).modules;

beforeEach(async () => {
	for (const dir of [imageDir, path.join(home, 'data'), path.join(home, 'src')]) await rm(dir, {recursive: true, force: true});
	out.length = 0;
});

test('a refused run leaves files and the lock untouched', async () => {
	await imageModule('lib', '1.0.0');
	await source('lib', '1.5.0');
	const app = await source('app', '1.0.0', {dependencies: dep('lib', '^2.0.0')});
	await assert.rejects(
		install([app], log),
		/Refused, nothing was changed: app needs lib \^2\.0\.0, lib would be 1\.5\.0\. Run "mod fix" to find compatible versions, or update them together \(mod update lib app\)/,
	);
	assert.ok(!existsSync(overlay) || (await readdir(overlay)).length === 0, 'overlay holds nothing, not even staging');
	assert.ok(!existsSync(overlayLock));
	assert.deepEqual(await versions(), {lib: 'image@1.0.0'});
});

test('updating a dependency and its dependent together passes, alone it is refused', async () => {
	await source('lib', '1.0.0');
	await source('app', '1.0.0', {dependencies: dep('lib', '^1.0.0')});
	await install([path.join(home, 'src', 'lib')], log);
	await install([path.join(home, 'src', 'app')], log);

	await source('lib', '2.0.0');
	await source('app', '2.0.0', {dependencies: dep('lib', '^2.0.0')});
	await assert.rejects(update(['lib'], log), /Refused, nothing was changed: app needs lib \^1\.0\.0, lib would be 2\.0\.0/);
	assert.deepEqual(await versions(), {app: 'overlay@1.0.0', lib: 'overlay@1.0.0'});

	await update(['lib', 'app'], log);
	assert.deepEqual(await versions(), {app: 'overlay@2.0.0', lib: 'overlay@2.0.0'});
	assert.deepEqual(await lockModules(), {app: {source: path.join(home, 'src', 'app'), version: '2.0.0'}, lib: {source: path.join(home, 'src', 'lib'), version: '2.0.0'}});
});

test('a present dependency outside the range is staged into the overlay', async () => {
	await imageModule('lib', '1.0.0');
	await source('lib', '2.0.0');
	const app = await source('app', '1.0.0', {dependencies: dep('lib', '^2.0.0')});
	await install([app], log);
	assert.deepEqual(await versions(), {app: 'overlay@1.0.0', lib: 'overlay@2.0.0'});
	assert.ok(existsSync(path.join(imageDir, 'lib', 'yena.json')), 'the image copy stays');
	assert.ok(out.includes('✓ lib@2.0.0') && out.includes('✓ app@1.0.0'));
});

test('a restore with an incompatible lock is refused', async () => {
	await imageModule('lib', '1.0.0');
	await source('lib', '1.5.0');
	const app = await source('app', '1.0.0', {dependencies: dep('lib', '^3.0.0')});
	await mkdir(path.dirname(overlayLock), {recursive: true});
	await writeFile(overlayLock, JSON.stringify({modules: {app: {source: app, version: '1.0.0'}}}));
	await assert.rejects(install([], log), /Refused, nothing was changed: app needs lib \^3\.0\.0, lib would be 1\.5\.0/);
	assert.ok(!existsSync(path.join(overlay, 'app')));
});

test('problems that were already there do not block an unrelated install', async () => {
	await imageModule('lib', '1.0.0');
	await imageModule('bad', '1.0.0', dep('lib', '^9.0.0'));
	const other = await source('other', '1.0.0', {dependencies: dep('lib', '^1.0.0')});
	await install([other], log);
	assert.equal((await versions()).other, 'overlay@1.0.0');
});

test('a failing install script rolls back every module swapped in the run', async () => {
	await source('base', '1.0.0');
	await install([path.join(home, 'src', 'base')], log);
	await source('base', '1.1.0', {install: 'touch ran'});
	const app = await source('app', '1.0.0', {install: 'exit 3', dependencies: dep('base', '^1.0.0')});
	out.length = 0;
	await assert.rejects(install([app, path.join(home, 'src', 'base')], log), /exited with code 3/);
	assert.deepEqual(await versions(), {base: 'overlay@1.0.0'});
	assert.ok(!existsSync(path.join(overlay, 'base', 'ran')));
	assert.deepEqual(Object.keys(await lockModules()), ['base']);
	assert.equal((await lockModules()).base!.version, '1.0.0');
	assert.ok(!out.some(l => l.startsWith('✓')));
	assert.deepEqual((await readdir(overlay)).sort(), ['base']);
});

test('mod lock refuses while the overlay is in use', async () => {
	await assert.rejects(lockRoot(log), /mod lock records the modules of a working copy; run it in dev mode \(mode dev\)/);
});
