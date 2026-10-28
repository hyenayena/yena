import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-overlay-')));
process.env.YENA_HOME = home;
process.env.YENA_DATA = path.join(home, 'data');
const {install, list, overlayDir, remove, resolveModules, update} = await import('../../src/pm/manager.js');
const {statusTags} = await import('../../src/pm/command.js');

const imageDir = path.join(home, 'modules');
const overlay = path.join(home, 'data', 'host', 'modules');
const overlayLock = path.join(home, 'data', 'host', 'yena-modules.json');
const out: string[] = [];
const log = (l: string) => void out.push(l);

async function writeModule(dir: string, name: string, version: string, extra: Record<string, unknown> = {}) {
	await mkdir(dir, {recursive: true});
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name, version, ...extra}));
	return dir;
}
const imageModule = (name: string, version: string, extra?: Record<string, unknown>) => writeModule(path.join(imageDir, name), name, version, extra);
const source = (name: string, version: string, extra?: Record<string, unknown>) => writeModule(path.join(home, 'src', `${name}-${version}`), name, version, extra);

const origins = async () => Object.fromEntries((await resolveModules()).modules.map(m => [m.manifest.name, `${m.origin}@${m.manifest.version}`]));

test('the overlay lives in the host state dir', () => {
	assert.equal(overlayDir, overlay);
});

test('install writes only to the overlay and its lock; the image stays untouched', async () => {
	await imageModule('core', '1.0.0');
	await install([await source('extra', '0.1.0')], log);
	assert.ok(existsSync(path.join(overlay, 'extra', 'yena.json')));
	assert.ok(!existsSync(path.join(imageDir, 'extra')));
	assert.ok(!existsSync(path.join(home, 'yena-modules.json')));
	assert.deepEqual(Object.keys(JSON.parse(await readFile(overlayLock, 'utf8')).modules), ['extra']);
	assert.deepEqual(await origins(), {core: 'image@1.0.0', extra: 'overlay@0.1.0'});
});

test('a newer or equal overlay copy shadows the image; an older one is skipped with a notice', async () => {
	await imageModule('kit', '0.4.0');
	await install([await source('kit', '0.3.0')], log);
	assert.ok(out.some(l => l.includes('The image has kit 0.4.0, newer than 0.3.0; the image copy stays in use')));
	let resolved = await resolveModules();
	assert.equal(resolved.modules.find(m => m.manifest.name === 'kit')?.origin, 'image');
	assert.deepEqual(resolved.skipped, [{name: 'kit', version: '0.3.0', imageVersion: '0.4.0'}]);

	await install([await source('kit', '0.4.0')], log);
	resolved = await resolveModules();
	assert.equal(resolved.modules.find(m => m.manifest.name === 'kit')?.dir, path.join(overlay, 'kit'));
	assert.deepEqual(resolved.skipped, []);
});

test('dependencies already in the image are not installed again', async () => {
	await install([await source('needs-core', '1.0.0', {dependencies: {core: 'core'}})], log);
	assert.ok(!existsSync(path.join(overlay, 'core')));
});

test('list shows a row per copy with its origin', async () => {
	const rows = (await list()).filter(r => r.name === 'kit');
	assert.deepEqual(rows.map(r => [r.origin, r.version, r.active]), [['image', '0.4.0', false], ['overlay', '0.4.0', true]]);
	assert.equal(statusTags(rows[0]!, true), ' [image, not used: the overlay is newer, not in lock file]');
	assert.equal(statusTags(rows[1]!, true), ' [overlay]');
	assert.equal(statusTags(rows[1]!, false), '');
});

test('remove: image-only modules refuse, an overlay copy goes and the image copy is used again', async () => {
	await assert.rejects(remove(['core'], log), /core is part of the image; remove it from \/workplace\/yena and rebuild/);
	await remove(['kit'], log);
	assert.ok(out.includes('✗ kit (the image copy is used again)'));
	assert.ok(!existsSync(path.join(overlay, 'kit')));
	assert.equal((await origins()).kit, 'image@0.4.0');
	await assert.rejects(remove(['nope'], log), /Module "nope" is not installed/);
});

function gitRepo(name: string, version: string): string {
	const dir = path.join(home, 'repos', name);
	execFileSync('mkdir', ['-p', dir]);
	execFileSync('sh', ['-c', `printf '%s' '${JSON.stringify({name, version})}' > yena.json`], {cwd: dir});
	const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: dir, stdio: 'ignore'});
	if (!existsSync(path.join(dir, '.git'))) git('init', '-q');
	git('add', '.');
	git('commit', '-q', '-m', version);
	return dir;
}
const head = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], {cwd: dir, encoding: 'utf8'}).trim();

test('update of an image module: unchanged commit installs nothing, a new one lands in the overlay', async () => {
	const repo = gitRepo('tool', '1.0.0');
	await imageModule('tool', '1.0.0');
	await writeFile(path.join(home, 'yena-modules.json'), JSON.stringify({modules: {tool: {source: `file://${repo}`, version: '1.0.0', commit: head(repo)}}}));

	out.length = 0;
	await update(['tool'], log);
	assert.ok(out.includes('  (no changes)'));
	assert.ok(!existsSync(path.join(overlay, 'tool')));

	gitRepo('tool', '1.1.0');
	await update(['tool'], log);
	assert.equal((await origins()).tool, 'overlay@1.1.0');
	assert.equal(JSON.parse(await readFile(overlayLock, 'utf8')).modules.tool.version, '1.1.0');
});

test('restore (install with no sources) brings back overlay modules from the overlay lock', async () => {
	execFileSync('rm', ['-rf', path.join(overlay, 'extra')]);
	await install([], log);
	assert.ok(existsSync(path.join(overlay, 'extra', 'yena.json')));
});
