import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod, mkdir, mkdtemp, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {isSecretLikeName, readModuleCode} from '../../src/pm/module-code.js';

const limits = {maxFiles: 100, maxFileBytes: 1024, maxTotalBytes: 10_000};

async function moduleDir(name = 'mod') {
	const dir = path.join(await mkdtemp(path.join(tmpdir(), 'yena-code-')), name);
	await mkdir(dir);
	await put(dir, 'yena.json', JSON.stringify({name, version: '1.0.0'}));
	return dir;
}

async function put(dir: string, rel: string, text: string, mode = 0o644) {
	const file = path.join(dir, ...rel.split('/'));
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, text);
	await chmod(file, mode);
}

const paths = (read: {files: {path: string}[]}) => read.files.map(f => f.path);

test('walk: packs files with modes and leaves out dependency folders', async () => {
	const dir = await moduleDir();
	await put(dir, 'src/a.ts', 'a');
	await put(dir, 'bin/install', '#!/bin/sh', 0o755);
	await put(dir, 'node_modules/x/index.js', 'x');
	await put(dir, '.venv/lib', 'x');
	await put(dir, '.yena/state', 'x');
	const read = await readModuleCode(dir, limits);
	assert.deepEqual(paths(read), ['bin/install', 'src/a.ts', 'yena.json']);
	assert.equal(read.files[0]!.mode, 0o755);
	assert.equal(read.skipped, 3);
	assert.deepEqual(read.notes, ['3 ignored or dependency files not packed']);
});

test('secret-like names are recognised', () => {
	for (const name of ['.env', '.envrc', '.env.local', '.env-prod', '.env_x', '.env.production.local', '.netrc', '.npmrc', '.pgpass', 'a.pem', 'a.KEY', 'x.p12', 'x.pfx', 'id_rsa', 'id_rsa.pub', 'id_dsa', 'id_ecdsa', 'id_ed25519']) {
		assert.equal(isSecretLikeName(name), true, name);
	}
	for (const name of ['.env.example', '.env.local.sample', '.env.template', '.env.dist', 'env.ts', 'keys.ts', 'key', 'readme.md']) {
		assert.equal(isSecretLikeName(name), false, name);
	}
});

test('walk: secret-like files are excluded at any depth and counted', async () => {
	const dir = await moduleDir();
	await put(dir, '.env', 's');
	await put(dir, 'deep/.env.local', 's');
	await put(dir, 'deep/server.pem', 's');
	await put(dir, '.env.example', 'FOO=');
	const read = await readModuleCode(dir, limits);
	assert.deepEqual(paths(read), ['.env.example', 'yena.json']);
	assert.deepEqual(read.notes, ['3 secret-like files not packed']);
});

test('walk: links are skipped and never followed', async () => {
	const dir = await moduleDir();
	const outside = await mkdtemp(path.join(tmpdir(), 'yena-out-'));
	await put(outside, 'x', 'outside');
	await symlink(path.join(outside, 'x'), path.join(dir, 'link'));
	await symlink(outside, path.join(dir, 'dirlink'));
	const read = await readModuleCode(dir, limits);
	assert.deepEqual(paths(read), ['yena.json']);
	assert.deepEqual(read.notes, ['2 links or special files skipped']);
});

test('a missing yena.json fails', async () => {
	const dir = await moduleDir('nomanifest');
	execFileSync('rm', [path.join(dir, 'yena.json')]);
	await put(dir, 'a', 'a');
	await assert.rejects(readModuleCode(dir, limits), /nomanifest: its yena\.json would not be packed/);
});

test('limits: a big file is skipped, a big total fails', async () => {
	const dir = await moduleDir('limited');
	await put(dir, 'big', 'x'.repeat(2000));
	const read = await readModuleCode(dir, limits);
	assert.deepEqual(paths(read), ['yena.json']);
	assert.deepEqual(read.notes, ['1 files over 1024 bytes skipped']);
	await put(dir, 'a', 'x'.repeat(600));
	await put(dir, 'b', 'x'.repeat(600));
	await assert.rejects(readModuleCode(dir, {...limits, maxTotalBytes: 1000}), /limited's code is larger than the export limit/);
});

test('git checkout: tracked and untracked files, ignored files and node_modules excluded', async () => {
	const dir = await moduleDir('gitmod');
	const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: dir, stdio: 'ignore'});
	git('init', '-q');
	await put(dir, '.gitignore', 'ignored.txt\n');
	await put(dir, 'tracked.ts', 't');
	await put(dir, 'ignored.txt', 'i');
	await put(dir, 'node_modules/p/i.js', 'n');
	await put(dir, '.env', 's');
	git('add', '-f', 'yena.json', '.gitignore', 'tracked.ts', '.env');
	git('commit', '-q', '-m', 'one');
	await put(dir, 'untracked.ts', 'u');
	await put(dir, 'gone.ts', 'g');
	git('add', 'gone.ts');
	execFileSync('rm', [path.join(dir, 'gone.ts')]);
	const read = await readModuleCode(dir, limits);
	assert.deepEqual(paths(read), ['.gitignore', 'tracked.ts', 'untracked.ts', 'yena.json']);
	assert.deepEqual(read.notes, ['1 secret-like files not packed']);
});
