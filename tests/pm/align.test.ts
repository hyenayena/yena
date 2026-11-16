import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {ModuleDataFile} from '../../src/api.js';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-align-')));
process.env.YENA_HOME = home;
delete process.env.YENA_DATA;
const {alignPinned, install, resolveModules, RefusedInstall} = await import('../../src/pm/manager.js');

const modulesDir = path.join(home, 'modules');
const lockFile = path.join(home, 'yena-modules.json');
const log = () => {};

function commitRepo(name: string, files: Record<string, string>): string {
	const dir = path.join(home, 'repos', name);
	execFileSync('mkdir', ['-p', dir]);
	for (const [rel, text] of Object.entries(files)) execFileSync('sh', ['-c', `cat > '${rel}'`], {cwd: dir, input: text});
	const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
	if (!existsSync(path.join(dir, '.git'))) git('init', '-q');
	git('add', '.');
	git('commit', '-q', '-m', 'c');
	return git('rev-parse', 'HEAD').trim();
}

const manifest = (name: string, version: string, extra: Record<string, unknown> = {}) => JSON.stringify({name, version, ...extra});
const repoUrl = (name: string) => `file://${path.join(home, 'repos', name)}`;
const installed = async () => Object.fromEntries((await resolveModules()).modules.map(m => [m.manifest.name, m.manifest.version]));
const readLock = async () => (existsSync(lockFile) ? JSON.parse(await readFile(lockFile, 'utf8')).modules : {});
const noop = async () => {};

const fileOf = (rel: string, text: string, mode = 0o644): ModuleDataFile => ({path: rel, mode, mtimeMs: 1, data: Buffer.from(text)});
const pack = (name: string, version: string, extra: Record<string, unknown> = {}, more: ModuleDataFile[] = []): ModuleDataFile[] => [
	fileOf('yena.json', manifest(name, version, extra)),
	...more,
];

const lib1 = commitRepo('lib', {'yena.json': manifest('lib', '1.0.0')});
const lib2 = commitRepo('lib', {'yena.json': manifest('lib', '1.1.0')});
const app1 = commitRepo('app', {'yena.json': manifest('app', '1.0.0', {dependencies: {lib: {source: repoUrl('lib'), version: '^1.1.0'}}})});

test('a pinned dependency is not replaced by a HEAD fetch', async () => {
	await alignPinned(
		[
			{name: 'lib', version: '1.0.0', spec: repoUrl('lib'), commit: lib1},
			{name: 'app', version: '1.0.0', spec: repoUrl('app'), commit: app1},
		],
		log,
		noop,
	).then(
		() => assert.fail('the set is inconsistent'),
		error => {
			assert.ok(error instanceof RefusedInstall);
			assert.match((error as Error).message, /Refused, nothing was changed:\n- app needs lib \^1\.1\.0, lib would be 1\.0\.0/);
		},
	);
	assert.deepEqual(await installed(), {});
	assert.deepEqual(await readLock(), {});

	await alignPinned([{name: 'lib', version: '1.1.0', spec: repoUrl('lib'), commit: lib2}, {name: 'app', version: '1.0.0', spec: repoUrl('app'), commit: app1}], log, noop);
	assert.deepEqual(await installed(), {app: '1.0.0', lib: '1.1.0'});
	const lock = await readLock();
	assert.equal(lock.lib.commit, lib2);
	assert.equal(lock.app.commit, app1);
	assert.equal(lock.lib.source, repoUrl('lib'));
});

test('aligning one module never stages its out-of-range dependency at HEAD', async () => {
	execFileSync('rm', ['-rf', path.join(modulesDir, 'lib'), path.join(modulesDir, 'app')]);
	await alignPinned([{name: 'lib', version: '1.0.0', spec: repoUrl('lib'), commit: lib1}], log, noop);
	const before = JSON.stringify(await readLock());
	await assert.rejects(
		alignPinned([{name: 'app', version: '1.0.0', spec: repoUrl('app'), commit: app1}], log, noop),
		/app needs lib \^1\.1\.0, lib would be 1\.0\.0/,
	);
	assert.deepEqual(await installed(), {lib: '1.0.0'});
	assert.equal(JSON.stringify(await readLock()), before);
});

test('a fetched commit with another version than the export says is refused', async () => {
	const c = commitRepo('ver', {'yena.json': manifest('ver', '1.0.0')});
	await assert.rejects(
		alignPinned([{name: 'ver', version: '2.0.0', spec: repoUrl('ver'), commit: c}], log, noop),
		new RegExp(`ver: commit ${c.slice(0, 7)} has version 1\\.0\\.0, the export says 2\\.0\\.0`),
	);
	assert.equal((await installed()).ver, undefined);
});

test('an after hook that throws rolls every swapped module back and leaves the lock', async () => {
	const c1 = commitRepo('roll', {'yena.json': manifest('roll', '1.0.0')});
	await alignPinned([{name: 'roll', version: '1.0.0', spec: repoUrl('roll'), commit: c1}], log, noop);
	const c2 = commitRepo('roll', {'yena.json': manifest('roll', '1.1.0')});
	const lockBefore = JSON.stringify(await readLock());
	await assert.rejects(
		alignPinned(
			[
				{name: 'roll', version: '1.1.0', spec: repoUrl('roll'), commit: c2},
				{name: 'carried', version: '1.0.0', files: pack('carried', '1.0.0')},
			],
			log,
			async staged => {
				assert.deepEqual([...staged.keys()].sort(), ['carried', 'roll']);
				throw new Error('data failed');
			},
		),
		/data failed/,
	);
	const state = await installed();
	assert.equal(state.roll, '1.0.0');
	assert.equal(state.carried, undefined);
	assert.equal(JSON.stringify(await readLock()), lockBefore);
	assert.ok(!existsSync(path.join(modulesDir, 'carried')));
});

test('a files item is installed into the install dir, runs its install script, and gets no lock entry', async () => {
	await alignPinned(
		[{name: 'carried', version: '1.0.0', files: pack('carried', '1.0.0', {install: 'echo ran > install-ran.txt'}, [fileOf('bin/tool', '#!/bin/sh', 0o755)])}],
		log,
		noop,
	);
	assert.equal(await readFile(path.join(modulesDir, 'carried', 'install-ran.txt'), 'utf8'), 'ran\n');
	assert.equal((await stat(path.join(modulesDir, 'carried', 'bin', 'tool'))).mode & 0o777, 0o755);
	assert.equal((await installed()).carried, '1.0.0');
	assert.equal((await readLock()).carried, undefined);
	assert.ok(!(await import('node:fs')).readdirSync(modulesDir).some(n => n.startsWith('.staging-')));
});

test('a carried module replaces an old lock entry by deleting it', async () => {
	const c = commitRepo('old', {'yena.json': manifest('old', '1.0.0')});
	await alignPinned([{name: 'old', version: '1.0.0', spec: repoUrl('old'), commit: c}], log, noop);
	assert.ok((await readLock()).old);
	await alignPinned([{name: 'old', version: '1.2.0', files: pack('old', '1.2.0')}], log, noop);
	assert.equal((await installed()).old, '1.2.0');
	assert.equal((await readLock()).old, undefined);
	await install([], log);
	assert.equal((await installed()).old, '1.2.0');
});

test('a packed yena.json with another name or version is refused and nothing moves', async () => {
	await assert.rejects(alignPinned([{name: 'x', version: '1.0.0', files: pack('y', '1.0.0')}], log, noop), /x: the packed yena\.json says y@1\.0\.0/);
	await assert.rejects(alignPinned([{name: 'x', version: '1.0.0', files: pack('x', '2.0.0')}], log, noop), /x: the packed yena\.json says x@2\.0\.0/);
	await assert.rejects(alignPinned([{name: 'x', version: '1.0.0', files: [fileOf('yena.json', '{bad')]}], log, noop), /x: yena\.json is not valid JSON/);
	await assert.rejects(alignPinned([{name: 'x', version: '1.0.0', files: pack('x', '1.0.0', {}, [fileOf('../evil', 'e')])}], log, noop), /x: a file path in the export/);
	assert.equal((await installed()).x, undefined);
	assert.ok(!existsSync(path.join(home, 'evil')));
});

test('a packed host range the running yena cannot meet is refused', async () => {
	await assert.rejects(
		alignPinned([{name: 'hosted', version: '1.0.0', files: pack('hosted', '1.0.0', {host: '^9.0.0'})}], log, noop, {hostVersion: '0.9.0'}),
		/hosted 1\.0\.0 needs yena \^9\.0\.0, this yena is 0\.9\.0/,
	);
	assert.equal((await installed()).hosted, undefined);
});

test('a git checkout target is refused', async () => {
	await mkdir(path.join(modulesDir, 'checkout', '.git'), {recursive: true});
	await writeFile(path.join(modulesDir, 'checkout', 'yena.json'), manifest('checkout', '1.0.0'));
	await assert.rejects(alignPinned([{name: 'checkout', version: '1.1.0', files: pack('checkout', '1.1.0')}], log, noop), /modules\/checkout is a git checkout/);
	assert.equal((await installed()).checkout, '1.0.0');
});

test('a carried module with dependencies and no install script runs npm install once', async () => {
	const calls: {cmd: string; args: string[]; cwd?: string}[] = [];
	const exec = async (cmd: string, args: string[], options?: {cwd?: string}) => {
		calls.push({cmd, args, ...(options?.cwd && {cwd: options.cwd})});
		return '';
	};
	const withDeps = fileOf('package.json', JSON.stringify({dependencies: {left: '^1.0.0'}}));
	await alignPinned([{name: 'npmed', version: '1.0.0', files: pack('npmed', '1.0.0', {}, [withDeps])}], log, noop, {exec});
	assert.deepEqual(calls, [{cmd: 'npm', args: ['install', '--prefix', '.', '--omit=dev', '--no-audit', '--no-fund'], cwd: path.join(modulesDir, 'npmed')}]);

	calls.length = 0;
	await alignPinned([{name: 'noscript', version: '1.0.0', files: pack('noscript', '1.0.0', {}, [fileOf('package.json', JSON.stringify({dependencies: {}}))])}], log, noop, {exec});
	await alignPinned([{name: 'withscript', version: '1.0.0', files: pack('withscript', '1.0.0', {install: 'true'}, [withDeps])}], log, noop, {exec});
	await alignPinned([{name: 'nopkg', version: '1.0.0', files: pack('nopkg', '1.0.0')}], log, noop, {exec});
	assert.deepEqual(calls, []);
});

test('a failing npm install fails the whole run and rolls back', async () => {
	const exec = async () => {
		throw new Error('npm failed');
	};
	const withDeps = fileOf('package.json', JSON.stringify({dependencies: {left: '^1.0.0'}}));
	await assert.rejects(
		alignPinned([{name: 'brokennpm', version: '1.0.0', files: pack('brokennpm', '1.0.0', {}, [withDeps])}], log, noop, {exec}),
		/npm failed/,
	);
	assert.equal((await installed()).brokennpm, undefined);
	assert.ok(!existsSync(path.join(modulesDir, 'brokennpm')));
});
