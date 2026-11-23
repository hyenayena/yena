import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {ModuleDataFile} from '../../src/api.js';
import {pathProblem, readModuleData, replaceModuleData} from '../../src/pm/module-data.js';
import {filterFor} from '../fixtures/legacy-export.js';

const limits = {maxFiles: 100, maxFileBytes: 1024, maxTotalBytes: 10_000};
const tmp = () => mkdtemp(path.join(tmpdir(), 'yena-data-'));

async function put(root: string, rel: string, text: string, mode = 0o644) {
	const file = path.join(root, ...rel.split('/'));
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, text);
	await chmod(file, mode);
}

async function snapshot(dir: string, rel = ''): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const e of await readdir(path.join(dir, rel), {withFileTypes: true})) {
		const r = rel === '' ? e.name : `${rel}/${e.name}`;
		if (e.isSymbolicLink()) out[r] = `-> ${await readlink(path.join(dir, r))}`;
		else if (e.isDirectory()) {
			out[r] = 'dir';
			Object.assign(out, await snapshot(dir, r));
		} else out[r] = (await readFile(path.join(dir, r), 'utf8')) + ((await stat(path.join(dir, r))).mode & 0o777).toString(8);
	}
	return out;
}

const file = (p: string, text: string, mode = 0o644): ModuleDataFile => ({path: p, mode, mtimeMs: 1_700_000_000_000, data: Buffer.from(text)});
const names = (files: {path: string}[]) => files.map(f => f.path);

test('read: denied files and directories are skipped and counted', async () => {
	const root = await tmp();
	await put(root, 'm/keep.json', '{}');
	await put(root, 'm/state.json', 'secret');
	await put(root, 'm/cache/a', 'x');
	await put(root, 'm/cache/deep/b', 'y');
	await put(root, 'm/sub/.hidden', 'h');
	const read = await readModuleData(root, 'm', filterFor({deny: ['state.json', 'cache']}), limits);
	assert.deepEqual(names(read.files), ['keep.json', 'sub/.hidden']);
	assert.equal(read.skipped, 3);
	assert.equal(read.defaultDeny, false);
});

test('read: modes and mtimes are kept, files are sorted', async () => {
	const root = await tmp();
	await put(root, 'm/b', 'b', 0o600);
	await put(root, 'm/a', 'a', 0o755);
	const read = await readModuleData(root, 'm', filterFor({deny: []}), limits);
	assert.deepEqual(read.files.map(f => [f.path, f.mode]), [['a', 0o755], ['b', 0o600]]);
	assert.equal(Buffer.from(read.files[0]!.data).toString(), 'a');
	assert.ok(read.files[0]!.mtimeMs > 0);
});

test('read: links and special files are skipped and never followed', async () => {
	const root = await tmp();
	const outside = await tmp();
	await put(outside, 'secret', 'outside');
	await put(root, 'm/real', 'r');
	await symlink(path.join(outside, 'secret'), path.join(root, 'm', 'link'));
	await symlink(outside, path.join(root, 'm', 'dirlink'));
	execFileSync('mkfifo', [path.join(root, 'm', 'pipe')]);
	const read = await readModuleData(root, 'm', filterFor({deny: []}), limits);
	assert.deepEqual(names(read.files), ['real']);
	assert.equal(read.skipped, 3);
	assert.deepEqual(read.notes, ['3 links or special files skipped']);
});

test('read: a file over the per-file limit is skipped with a note', async () => {
	const root = await tmp();
	await put(root, 'm/small', 'x');
	await put(root, 'm/big', 'x'.repeat(2000));
	const read = await readModuleData(root, 'm', filterFor({deny: []}), limits);
	assert.deepEqual(names(read.files), ['small']);
	assert.deepEqual(read.notes, ['1 files over 1024 bytes skipped']);
});

test('read: paths that cannot be archived are skipped', async () => {
	const root = await tmp();
	await put(root, 'm/ok', 'x');
	await put(root, `m/${'n'.repeat(250)}`, 'x');
	await put(root, 'm/back\\slash', 'x');
	const read = await readModuleData(root, 'm', filterFor({deny: []}), limits);
	assert.deepEqual(names(read.files), ['ok']);
	assert.deepEqual(read.notes, ['2 files with unusable paths skipped']);
});

test('read: over the file count or total size throws', async () => {
	const root = await tmp();
	await put(root, 'm/a', 'x'.repeat(600));
	await put(root, 'm/b', 'x'.repeat(600));
	await assert.rejects(readModuleData(root, 'm', filterFor({deny: []}), {...limits, maxTotalBytes: 1000}), /m's data is larger than the export limit/);
	await assert.rejects(readModuleData(root, 'm', filterFor({deny: []}), {...limits, maxFiles: 1}), /larger than the export limit/);
});

test('read: no rules means default deny with the file count', async () => {
	const root = await tmp();
	await put(root, 'm/a', 'x');
	await put(root, 'm/d/b', 'y');
	const read = await readModuleData(root, 'm', undefined, limits);
	assert.deepEqual(read, {files: [], skipped: 2, notes: [], defaultDeny: true});
});

test('read: a missing data directory is empty; host and bad names are refused', async () => {
	const root = await tmp();
	assert.deepEqual(await readModuleData(root, 'nothing', filterFor({deny: []}), limits), {files: [], skipped: 0, notes: [], defaultDeny: false});
	await assert.rejects(readModuleData(root, 'host', filterFor({deny: []}), limits), /reserved/);
	await assert.rejects(readModuleData(root, '../x', filterFor({deny: []}), limits), /Invalid module name/);
});

test('pathProblem rejects unsafe paths', () => {
	for (const bad of ['', '/a', 'a\\b', 'a//b', 'a/./b', '../a', 'a/..', `a${String.fromCharCode(7)}`, 'x'.repeat(241), Array(33).fill('d').join('/')]) {
		assert.ok(pathProblem(bad), bad);
	}
	assert.equal(pathProblem('a/b/.c'), undefined);
});

async function setup() {
	const root = await tmp();
	const backups = await tmp();
	await put(root, 'a/keep.json', 'K');
	await put(root, 'a/old.json', 'old', 0o600);
	await put(root, 'a/dir/old2', 'old2');
	await put(root, 'a/secret/token', 'T');
	await put(root, 'b/x', 'bx');
	await symlink('/etc', path.join(root, 'a', 'link'));
	return {root, backupDir: path.join(backups, 'run1')};
}

const rulesFor = (name: string) => (name === 'a' ? filterFor({deny: ['keep.json', 'secret']}) : name === 'b' ? filterFor({deny: []}) : undefined);

test('replace: denied files and links stay, the rest is moved to the backup, the archive is written', async () => {
	const {root, backupDir} = await setup();
	const results = await replaceModuleData(root, [{name: 'a', files: [file('new.json', 'N', 0o600), file('dir/new2', 'N2')]}], {backupDir, rulesFor});
	assert.deepEqual(results, [{name: 'a', written: 2, removed: 2, kept: 3, skipped: 0, defaultDeny: false}]);
	assert.equal(await readFile(path.join(root, 'a', 'keep.json'), 'utf8'), 'K');
	assert.equal(await readFile(path.join(root, 'a', 'secret', 'token'), 'utf8'), 'T');
	assert.equal(await readlink(path.join(root, 'a', 'link')), '/etc');
	assert.equal(await readFile(path.join(root, 'a', 'new.json'), 'utf8'), 'N');
	assert.equal((await stat(path.join(root, 'a', 'new.json'))).mode & 0o777, 0o600);
	assert.equal((await stat(path.join(root, 'a', 'new.json'))).mtimeMs, 1_700_000_000_000);
	await assert.rejects(stat(path.join(root, 'a', 'old.json')));
	assert.equal(await readFile(path.join(backupDir, 'a', 'old.json'), 'utf8'), 'old');
	assert.equal(await readFile(path.join(backupDir, 'a', 'dir', 'old2'), 'utf8'), 'old2');
	assert.equal((await lstat(path.join(backupDir, 'a'))).mode & 0o777, 0o700);
});

test('replace: archive entries denied by the target or blocked by kept entries are skipped', async () => {
	const {root, backupDir} = await setup();
	const results = await replaceModuleData(
		root,
		[{name: 'a', files: [file('keep.json', 'EVIL'), file('secret/token', 'EVIL'), file('link', 'EVIL'), file('link/inside', 'EVIL'), file('ok', 'ok')]}],
		{backupDir, rulesFor},
	);
	assert.equal(results[0]!.written, 1);
	assert.equal(results[0]!.skipped, 4);
	assert.equal(await readFile(path.join(root, 'a', 'keep.json'), 'utf8'), 'K');
	assert.equal(await readFile(path.join(root, 'a', 'secret', 'token'), 'utf8'), 'T');
	assert.equal(await readlink(path.join(root, 'a', 'link')), '/etc');
});

test('replace: a target without rules is untouched', async () => {
	const {root, backupDir} = await setup();
	const before = await snapshot(root);
	const results = await replaceModuleData(root, [{name: 'nope', files: [file('x', 'x')]}], {backupDir, rulesFor});
	assert.deepEqual(results, [{name: 'nope', written: 0, removed: 0, kept: 0, skipped: 1, defaultDeny: true}]);
	assert.deepEqual(await snapshot(root), before);
});

test('replace: invalid input is refused before any change', async () => {
	const {root, backupDir} = await setup();
	const before = await snapshot(root);
	const items = (f: ModuleDataFile[]) => [{name: 'a', files: f}];
	await assert.rejects(replaceModuleData(root, items([file('../escape', 'x')]), {backupDir, rulesFor}), /Invalid path/);
	await assert.rejects(replaceModuleData(root, items([file('/abs', 'x')]), {backupDir, rulesFor}), /Invalid path/);
	await assert.rejects(replaceModuleData(root, items([file('d', 'x'), file('d', 'y')]), {backupDir, rulesFor}), /Duplicate path/);
	await assert.rejects(replaceModuleData(root, [...items([]), ...items([])], {backupDir, rulesFor}), /listed twice/);
	await assert.rejects(replaceModuleData(root, [{name: 'host', files: []}], {backupDir, rulesFor}), /reserved/);
	await assert.rejects(replaceModuleData(root, items([]), {backupDir: 'relative/dir', rulesFor}), /absolute/);
	assert.deepEqual(await snapshot(root), before);
	await assert.rejects(stat(backupDir));
});

test('replace: an existing backup folder is refused', async () => {
	const {root, backupDir} = await setup();
	await mkdir(backupDir);
	const before = await snapshot(root);
	await assert.rejects(replaceModuleData(root, [{name: 'a', files: []}], {backupDir, rulesFor}), /already exists/);
	assert.deepEqual(await snapshot(root), before);
});

test('replace: a backup folder inside an unkept target is refused, inside a kept one is allowed', async () => {
	const {root} = await setup();
	const before = await snapshot(root);
	await assert.rejects(
		replaceModuleData(root, [{name: 'a', files: []}], {backupDir: path.join(root, 'a', 'dir', 'bk'), rulesFor}),
		/inside the data of a/,
	);
	assert.deepEqual(await snapshot(root), before);
	await replaceModuleData(root, [{name: 'a', files: []}], {backupDir: path.join(root, 'a', 'secret', 'bk'), rulesFor});
	assert.equal(await readFile(path.join(root, 'a', 'secret', 'bk', 'a', 'old.json'), 'utf8'), 'old');
});

test('replace: a failure in the second item restores both directories exactly', async () => {
	const {root, backupDir} = await setup();
	const before = await snapshot(root);
	await assert.rejects(
		replaceModuleData(
			root,
			[{name: 'a', files: [file('new.json', 'N'), file('sub/n', 'N')]}, {name: 'b', files: [file('y', 'Y'), file('z', 'Z')]}],
			{
				backupDir,
				rulesFor,
				beforeWrite: (name, rel) => {
					if (name === 'b' && rel === 'z') throw new Error('disk full');
				},
			},
		),
		/Import failed and was rolled back: disk full/,
	);
	assert.deepEqual(await snapshot(root), before);
	await assert.rejects(stat(backupDir));
});

test('replace: missing target directories are created', async () => {
	const root = await tmp();
	const backupDir = path.join(await tmp(), 'bk');
	const results = await replaceModuleData(root, [{name: 'b', files: [file('deep/er/f', 'F')]}], {backupDir, rulesFor});
	assert.equal(results[0]!.written, 1);
	assert.equal(await readFile(path.join(root, 'b', 'deep', 'er', 'f'), 'utf8'), 'F');
});

test('read: the filter note is added and directories are asked with isDir', async () => {
	const root = await tmp();
	await put(root, 'm/a', 'x');
	await put(root, 'm/d/b', 'y');
	const asked: string[] = [];
	const read = await readModuleData(
		root,
		'm',
		{
			denied: async (rel, isDir) => {
				asked.push(`${rel}${isDir ? '/' : ''}`);
				return rel === 'd';
			},
			note: 'closed by rules',
		},
		limits,
	);
	assert.deepEqual(read.files.map(f => f.path), ['a']);
	assert.deepEqual(read.notes, ['closed by rules']);
	assert.equal(read.skipped, 1);
	assert.deepEqual(asked, ['a', 'd/']);
});
