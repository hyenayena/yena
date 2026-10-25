import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {parseSource} from '../../src/pm/source.js';

const base = '/project';

test('user/repo expands to a GitHub URL', () => {
	assert.deepEqual(parseSource('user/repo', base), {kind: 'git', url: 'https://github.com/user/repo.git', ref: undefined});
});

test('host prefixes pick the matching host', () => {
	assert.deepEqual(parseSource('gitlab:user/repo', base), {kind: 'git', url: 'https://gitlab.com/user/repo.git', ref: undefined});
	assert.deepEqual(parseSource('bitbucket:user/repo', base), {kind: 'git', url: 'https://bitbucket.org/user/repo.git', ref: undefined});
});

test('a trailing .git is not duplicated', () => {
	assert.deepEqual(parseSource('user/repo.git', base), {kind: 'git', url: 'https://github.com/user/repo.git', ref: undefined});
});

test('#ref is split off and kept', () => {
	assert.deepEqual(parseSource('user/repo#v1.2', base), {kind: 'git', url: 'https://github.com/user/repo.git', ref: 'v1.2'});
});

test('an empty #ref means no ref', () => {
	assert.deepEqual(parseSource('user/repo#', base), {kind: 'git', url: 'https://github.com/user/repo.git', ref: undefined});
});

test('full URLs and scp-style URLs pass through', () => {
	assert.deepEqual(parseSource('https://host/repo.git', base), {kind: 'git', url: 'https://host/repo.git', ref: undefined});
	assert.deepEqual(parseSource('git@github.com:user/repo.git#main', base), {kind: 'git', url: 'git@github.com:user/repo.git', ref: 'main'});
});

test('relative and absolute paths resolve against the base directory', () => {
	assert.deepEqual(parseSource('./mod', base), {kind: 'path', path: path.resolve(base, './mod')});
	assert.deepEqual(parseSource('../mod', base), {kind: 'path', path: path.resolve(base, '../mod')});
	assert.deepEqual(parseSource('/abs/mod', base), {kind: 'path', path: '/abs/mod'});
});

test('an unrecognized source throws', () => {
	assert.throws(() => parseSource('not a source', base), /Unrecognized source/);
});

test('a bare name is an official module', async () => {
	const {officialModuleName} = await import('../../src/pm/source.js');
	assert.deepEqual(parseSource('core', base), {kind: 'git', url: 'git@github.com:hyenayena/core.git', ref: undefined});
	assert.deepEqual(parseSource('task#v0.2', base), {kind: 'git', url: 'git@github.com:hyenayena/task.git', ref: 'v0.2'});
	assert.equal(officialModuleName('core#main'), 'core');
	assert.equal(officialModuleName('user/repo'), undefined);
	assert.equal(officialModuleName('Core'), undefined);
});
