import assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {escapes, resolveInside} from '../../src/pm/paths.js';

async function setup() {
	const base = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-paths-')));
	const dir = path.join(base, 'mod');
	await mkdir(path.join(dir, '..foo'), {recursive: true});
	await writeFile(path.join(dir, 'a.js'), '');
	await writeFile(path.join(dir, '..foo', 'b.js'), '');
	await writeFile(path.join(base, 'outside.js'), '');
	return {base, dir};
}

test('inside path resolves', async () => {
	const {dir} = await setup();
	assert.equal(await resolveInside(dir, 'a.js'), path.join(dir, 'a.js'));
});

test('parent traversal is rejected', async () => {
	const {dir} = await setup();
	await assert.rejects(resolveInside(dir, '../outside.js', 'entry'), /"entry" points outside the module/);
});

test('absolute path is rejected', async () => {
	const {base, dir} = await setup();
	await assert.rejects(resolveInside(dir, path.join(base, 'outside.js')), /points outside the module/);
});

test('a directory named "..foo" is allowed', async () => {
	const {dir} = await setup();
	assert.equal(await resolveInside(dir, '..foo/b.js'), path.join(dir, '..foo', 'b.js'));
});

test('symlink escaping the module is rejected', async () => {
	const {base, dir} = await setup();
	await symlink(path.join(base, 'outside.js'), path.join(dir, 'link.js'));
	await assert.rejects(resolveInside(dir, 'link.js'), /points outside the module/);
});

test('symlink staying inside is resolved', async () => {
	const {dir} = await setup();
	await symlink(path.join(dir, 'a.js'), path.join(dir, 'link.js'));
	assert.equal(await resolveInside(dir, 'link.js'), path.join(dir, 'a.js'));
});

test('missing file is reported', async () => {
	const {dir} = await setup();
	await assert.rejects(resolveInside(dir, 'nope.js', 'entry'), /"entry" file not found/);
});

test('dangling symlink is reported as not found', async () => {
	const {dir} = await setup();
	await symlink('/nonexistent-yena-target', path.join(dir, 'dangling.js'));
	await assert.rejects(resolveInside(dir, 'dangling.js', 'entry'), /"entry" file not found/);
});

test('a NUL byte in the path is rejected', async () => {
	const {dir} = await setup();
	await assert.rejects(resolveInside(dir, 'a\0.js', 'entry'), /"entry" file not found/);
});

test('a symlinked module directory resolves to the real file', async () => {
	const {base, dir} = await setup();
	const link = path.join(base, 'link');
	await symlink(dir, link);
	assert.equal(await resolveInside(link, 'a.js'), path.join(dir, 'a.js'));
});

test('a symlinked directory pointing outside is rejected for nested files', async () => {
	const {base, dir} = await setup();
	await symlink(base, path.join(dir, 'up'));
	await assert.rejects(resolveInside(dir, 'up/outside.js', 'entry'), /"entry" points outside the module/);
});

test('escapes detects paths outside the base directory', () => {
	assert.equal(escapes('/a/b', '/a/b/c'), false);
	assert.equal(escapes('/a/b', '/a/b'), false);
	assert.equal(escapes('/a/b', '/a/bc'), true);
	assert.equal(escapes('/a/b', '/a'), true);
	assert.equal(escapes('/a/b', '/a/b/../x'), true);
	assert.equal(escapes('/a/b', '/a/b/..foo'), false);
});
