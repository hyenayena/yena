import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {Logger, ModuleDataFile, ModuleLockInfo} from '../../src/api.js';
import {parseManifest} from '../../src/pm/manifest.js';
import type {AlignItem, ResolvedModule} from '../../src/pm/manager.js';
import {createModuleRegistry, sourceRefusal} from '../../src/pm/registry.js';

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const limits = {maxFiles: 100, maxFileBytes: 4096, maxTotalBytes: 100_000};
const noopLog = {error() {}, warn() {}, info() {}, debug() {}, child: () => noopLog, addRedactor() {}} as Logger;

async function mkModule(name: string, version: string, extra: Record<string, unknown> = {}, origin: 'image' | 'overlay' = 'image'): Promise<ResolvedModule> {
	const dir = path.join(await mkdtemp(path.join(tmpdir(), 'yena-reg-')), name);
	await mkdir(dir, {recursive: true});
	const raw = JSON.stringify({name, version, ...extra});
	await writeFile(path.join(dir, 'yena.json'), raw);
	return {dir, manifest: parseManifest(raw), origin};
}

type Setup = {
	modules?: ResolvedModule[];
	image?: Record<string, ModuleLockInfo>;
	overlay?: Record<string, ModuleLockInfo>;
	imageVersions?: Record<string, string>;
	hostVersion?: string;
	dataRoot?: string;
};

function registry(setup: Setup = {}) {
	const calls: {items: AlignItem[]}[] = [];
	const reg = createModuleRegistry({
		resolveModules: async () => ({modules: setup.modules ?? []}),
		locksByOrigin: async () => ({image: setup.image ?? {}, ...(setup.overlay && {overlay: setup.overlay})}),
		alignPinned: async (items, _log, afterHook) => {
			calls.push({items: [...items]});
			await afterHook(new Map());
		},
		imageVersionOf: async name => setup.imageVersions?.[name],
		dataRoot: setup.dataRoot ?? '/nonexistent-data',
		hostVersion: setup.hostVersion ?? '0.9.0',
		log: noopLog,
	});
	return {reg, calls};
}

const pinned = (name: string, version: string, commit = C1) => ({[name]: {source: name, version, commit}});

test('list takes the lock by origin, the overlay falling back to the image', async () => {
	const a = await mkModule('a', '1.0.0', {export: {deny: []}}, 'overlay');
	const b = await mkModule('b', '1.0.0', {host: '^0.9.0'}, 'overlay');
	const c = await mkModule('c', '1.0.0', {}, 'image');
	const {reg} = registry({
		modules: [c, b, a],
		image: {...pinned('a', '1.0.0', C1), ...pinned('b', '1.0.0', C1), ...pinned('c', '1.0.0', C1)},
		overlay: pinned('a', '1.0.0', C2),
	});
	const infos = await reg.list();
	assert.deepEqual(infos.map(i => i.name), ['a', 'b', 'c']);
	assert.equal(infos[0]!.lock?.commit, C2);
	assert.equal(infos[1]!.lock?.commit, C1);
	assert.equal(infos[2]!.lock?.commit, C1);
	assert.deepEqual(infos[0]!.export, {deny: []});
	assert.equal(infos[1]!.host, '^0.9.0');
	assert.deepEqual(infos[2]!.code, {carry: false});
	assert.equal(infos[2]!.export, undefined);
});

async function codeOf(lock: ModuleLockInfo | undefined, version = '1.0.0') {
	const m = await mkModule('m', version);
	const {reg} = registry({modules: [m], image: lock ? {m: lock} : {}});
	return (await reg.list())[0]!.code;
}

test('code is carried when the target could not reproduce the code', async () => {
	assert.deepEqual(await codeOf(undefined), {carry: true, reason: 'not in the module lock'});
	assert.deepEqual(await codeOf({source: './local', version: '1.0.0', commit: C1}), {carry: true, reason: 'installed from a local path'});
	assert.deepEqual(await codeOf({source: 'file:///x/y', version: '1.0.0', commit: C1}), {carry: true, reason: 'installed from a file:// URL'});
	assert.deepEqual(await codeOf({source: 'http://h/r.git', version: '1.0.0', commit: C1}), {carry: true, reason: 'installed from http://'});
	assert.deepEqual(await codeOf({source: 'm', version: '1.0.0'}), {carry: true, reason: 'no commit in the module lock'});
	assert.deepEqual(await codeOf({source: 'm', version: '1.0.0', commit: 'abc'}), {carry: true, reason: 'no commit in the module lock'});
	assert.deepEqual(await codeOf({source: 'm', version: '0.9.0', commit: C1}), {carry: true, reason: 'the lock records 0.9.0, the code is 1.0.0'});
	assert.deepEqual(await codeOf({source: 'm', version: '1.0.0', commit: C1}), {carry: false});
});

test('a git checkout is carried when HEAD differs, it is dirty, or it has no commits', async () => {
	const m = await mkModule('m', '1.0.0');
	const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: m.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
	git('init', '-q');
	const carriedAt = async (commit: string) =>
		(await registry({modules: [m], image: {m: {source: 'm', version: '1.0.0', commit}}}).reg.list())[0]!.code;

	assert.deepEqual(await carriedAt(C1), {carry: true, reason: 'cannot read its git state'});
	git('add', '.');
	git('commit', '-q', '-m', 'one');
	const head = git('rev-parse', 'HEAD').trim();
	assert.deepEqual(await carriedAt(head), {carry: false});
	assert.deepEqual(await carriedAt(C1), {carry: true, reason: 'HEAD is not the locked commit'});
	await writeFile(path.join(m.dir, 'untracked.txt'), 'u');
	assert.deepEqual(await carriedAt(head), {carry: true, reason: 'uncommitted changes'});
});

test('readCode refuses a reproducible module and packs a carried one', async () => {
	const clean = await mkModule('clean', '1.0.0');
	const loose = await mkModule('loose', '1.0.0');
	await writeFile(path.join(loose.dir, 'main.ts'), 'x');
	const {reg} = registry({modules: [clean, loose], image: pinned('clean', '1.0.0')});
	await assert.rejects(reg.readCode('clean', limits), /can be installed from its source/);
	const read = await reg.readCode('loose', limits);
	assert.deepEqual(read.files.map(f => f.path), ['main.ts', 'yena.json']);
	await assert.rejects(reg.readCode('nope', limits), /Module "nope" is not installed/);
	await assert.rejects(reg.readData('nope', limits), /Module "nope" is not installed/);
});

test('readData uses the manifest rules of the installed module', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'yena-reg-data-'));
	await mkdir(path.join(root, 'a'));
	await writeFile(path.join(root, 'a', 'ok.json'), '{}');
	await writeFile(path.join(root, 'a', 'secret'), 's');
	const a = await mkModule('a', '1.0.0', {export: {deny: ['secret']}});
	const b = await mkModule('b', '1.0.0');
	const {reg} = registry({modules: [a, b], dataRoot: root});
	assert.deepEqual((await reg.readData('a', limits)).files.map(f => f.path), ['ok.json']);
	assert.equal((await reg.readData('b', limits)).defaultDeny, true);
});

test('sourceRefusal allows remotes and refuses the rest', () => {
	for (const ok of ['core', 'user/repo', 'github:user/repo', 'gitlab:u/r', 'https://h/r.git', 'ssh://git@h/r.git', 'git@h:u/r.git', 'user/repo#main']) {
		assert.equal(sourceRefusal(ok), undefined, ok);
	}
	assert.equal(sourceRefusal('./x'), 'a local path');
	assert.equal(sourceRefusal('/abs/x'), 'a local path');
	assert.equal(sourceRefusal('file:///x'), 'a file:// URL');
	assert.equal(sourceRefusal('http://h/r.git'), 'http://');
	assert.equal(sourceRefusal('git://h/r.git'), 'git://');
	assert.equal(sourceRefusal('-oProxy@h:x'), 'an unusable source');
	assert.equal(sourceRefusal('a b'), 'an unusable source');
	assert.equal(sourceRefusal('???'), 'an unrecognized source');
});

const target = (name: string, version: string, extra: Record<string, unknown> = {}) => ({name, version, source: name, commit: C2, ...extra});

test('planImport: install, update, downgrade, unchanged, same version other commit, untouched', async () => {
	const mods = [await mkModule('same', '1.0.0'), await mkModule('old', '1.0.0'), await mkModule('new', '2.0.0'), await mkModule('moved', '1.0.0'), await mkModule('extra', '1.0.0')];
	const {reg} = registry({modules: mods, image: {...pinned('same', '1.0.0', C2), ...pinned('old', '1.0.0'), ...pinned('new', '2.0.0'), ...pinned('moved', '1.0.0', C1)}});
	const plan = await reg.planImport([target('same', '1.0.0'), target('old', '1.1.0'), target('new', '1.0.0'), target('moved', '1.0.0'), target('fresh', '0.1.0')]);
	assert.deepEqual(plan.problems, []);
	assert.deepEqual(plan.steps.map(s => [s.name, s.action, s.from, s.to]), [
		['same', 'unchanged', '1.0.0', '1.0.0'],
		['old', 'update', '1.0.0', '1.1.0'],
		['new', 'downgrade', '2.0.0', '1.0.0'],
		['moved', 'update', '1.0.0', '1.0.0'],
		['fresh', 'install', undefined, '0.1.0'],
	]);
	assert.equal(plan.steps[3]!.fromCommit, C1);
	assert.equal(plan.steps[3]!.toCommit, C2);
	assert.deepEqual(plan.untouched, ['extra']);
	assert.equal(plan.hostVersion, '0.9.0');
});

test('planImport: a target without a commit is unchanged at the same version', async () => {
	const {reg} = registry({modules: [await mkModule('a', '1.0.0')]});
	const plan = await reg.planImport([{name: 'a', version: '1.0.0', source: 'a'}]);
	assert.equal(plan.steps[0]!.action, 'unchanged');
});

const INSTALL_HINT = 'Update yena first with install.sh (curl -fsSL https://raw.githubusercontent.com/hyenayena/yena/develop/install.sh | sh), then import again';

test('planImport: each problem line', async () => {
	const {reg} = registry({modules: [await mkModule('have', '1.0.0')], imageVersions: {low: '2.0.0'}});
	const plan = await reg.planImport([
		{name: 'nosrc', version: '1.0.0', commit: C1},
		{name: 'nocommit', version: '1.0.0', source: 'nocommit'},
		{name: 'path', version: '1.0.0', source: './local', commit: C1},
		{name: 'badcommit', version: '1.0.0', source: 'badcommit', commit: 'abc'},
		{name: 'badacct', version: '1.0.0', source: 'badacct', commit: C1, account: 'Bad Name'},
		{name: 'newer', version: '1.0.0', source: 'newer', commit: C1, host: '^0.10.0'},
		{name: 'have', version: '1.0.0', host: '^0.10.0'},
		{name: 'low', version: '1.0.0', source: 'low', commit: C1},
	]);
	assert.deepEqual(plan.problems, [
		'nosrc: the export has no source for it (it was not in the module lock where it was exported)',
		'nocommit: the export has no commit for it',
		'path: ./local cannot be installed from an export (a local path)',
		'badcommit: the export has a malformed commit for it',
		'badacct: badacct cannot be installed from an export (a malformed account name)',
		`newer 1.0.0 needs yena ^0.10.0, this yena is 0.9.0. ${INSTALL_HINT}`,
		`have 1.0.0 needs yena ^0.10.0, this yena is 0.9.0. ${INSTALL_HINT}`,
		"low 1.0.0 cannot replace the image's 2.0.0: a newer image copy always wins",
	]);
});

test('planImport: a git checkout target is refused', async () => {
	const m = await mkModule('dev', '1.0.0');
	execFileSync('git', ['init', '-q'], {cwd: m.dir});
	const {reg} = registry({modules: [m]});
	const plan = await reg.planImport([target('dev', '1.1.0')]);
	assert.deepEqual(plan.problems, ['dev is a git checkout (dev mode); align it with git or run the import in image mode']);
});

const code = (files: Record<string, string>): ModuleDataFile[] =>
	Object.entries(files).map(([p, text]) => ({path: p, mode: 0o644, mtimeMs: 1, data: Buffer.from(text)}));

test('planImport: carried code is an install or update from the file, never unchanged', async () => {
	const {reg} = registry({modules: [await mkModule('a', '1.0.0'), await mkModule('b', '2.0.0')]});
	const plan = await reg.planImport([
		{name: 'a', version: '1.0.0', code: code({'yena.json': '{}'})},
		{name: 'b', version: '1.0.0', code: code({'yena.json': '{}'})},
		{name: 'c', version: '1.0.0', code: code({'yena.json': '{}'})},
	]);
	assert.deepEqual(plan.problems, []);
	assert.deepEqual(plan.steps.map(s => [s.action, s.fromFile]), [['update', true], ['downgrade', true], ['install', true]]);
});

test('planImport: carried code needs yena.json and safe paths', async () => {
	const {reg} = registry();
	const plan = await reg.planImport([
		{name: 'a', version: '1.0.0', code: code({'main.ts': 'x'})},
		{name: 'b', version: '1.0.0', code: code({'yena.json': '{}', '../escape': 'x'})},
	]);
	assert.deepEqual(plan.problems, [
		'a: the file has no yena.json for its code',
		'b: a code path in the file has an empty, "." or ".." segment',
	]);
});

test('applyImport: problems refuse the whole import before anything runs', async () => {
	const {reg, calls} = registry();
	await assert.rejects(
		reg.applyImport({targets: [{name: 'x', version: '1.0.0'}], data: [], backupDir: '/tmp/never'}, () => {}),
		/Import refused, nothing was changed:\n- x: the export has no source/,
	);
	assert.equal(calls.length, 0);
});

test('applyImport: data for a module outside the targets is refused', async () => {
	const {reg, calls} = registry({modules: [await mkModule('a', '1.0.0')]});
	await assert.rejects(
		reg.applyImport({targets: [{name: 'a', version: '1.0.0'}], data: [{name: 'zzz', files: []}], backupDir: '/tmp/never'}, () => {}),
		/not in the export's module list/,
	);
	assert.equal(calls.length, 0);
});

test('applyImport: the non-unchanged steps go into one alignment, data is replaced inside it', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'yena-reg-apply-'));
	const backupDir = path.join(await mkdtemp(path.join(tmpdir(), 'yena-reg-bk-')), 'bk');
	const a = await mkModule('a', '1.0.0', {export: {deny: []}});
	const {reg, calls} = registry({modules: [a], image: pinned('a', '1.0.0', C2), dataRoot: root});
	const result = await reg.applyImport(
		{
			targets: [target('a', '1.0.0'), target('b', '1.0.0', {account: 'acct'}), {name: 'c', version: '1.0.0', code: code({'yena.json': '{}'})}],
			data: [{name: 'a', files: code({'x.json': 'X'})}],
			backupDir,
		},
		() => {},
	);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.items.map(i => i.name), ['b', 'c']);
	assert.deepEqual(calls[0]!.items[0], {name: 'b', version: '1.0.0', spec: 'b', commit: C2, account: 'acct'});
	assert.equal('files' in calls[0]!.items[1]!, true);
	assert.deepEqual(result.replaced, [{name: 'a', written: 1, removed: 0, kept: 0, skipped: 0, defaultDeny: false}]);
	assert.equal(await readFile(path.join(root, 'a', 'x.json'), 'utf8'), 'X');
});

test('applyImport: with nothing to align the data is replaced alone', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'yena-reg-apply-'));
	const backupDir = path.join(await mkdtemp(path.join(tmpdir(), 'yena-reg-bk-')), 'bk');
	const a = await mkModule('a', '1.0.0', {export: {deny: []}});
	const {reg, calls} = registry({modules: [a], image: pinned('a', '1.0.0', C2), dataRoot: root});
	const result = await reg.applyImport({targets: [target('a', '1.0.0')], data: [{name: 'a', files: code({y: 'Y'})}], backupDir}, () => {});
	assert.equal(calls.length, 0);
	assert.equal(result.replaced[0]!.written, 1);
	assert.equal(result.plan.steps[0]!.action, 'unchanged');
});
