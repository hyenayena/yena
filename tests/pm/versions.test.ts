import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Dependency} from '../../src/pm/manifest.js';
import {dependencyProblems, loadableModules, parseRange, problemText, satisfies} from '../../src/pm/versions.js';

const dep = (range: string, optional = false, source = 'x'): Dependency => ({source, range, optional});
const mod = (name: string, version: string, dependencies: Record<string, Dependency> = {}) => ({name, version, dependencies});

test('parseRange accepts only ^x.y.z and x.y.z', () => {
	assert.deepEqual(parseRange('^0.5.0'), {kind: 'caret', version: [0, 5, 0]});
	assert.deepEqual(parseRange('1.20.3'), {kind: 'exact', version: [1, 20, 3]});
	for (const bad of ['', '^1', '^1.2', 'v1.2.3', '^ 1.2.3', ' ^1.2.3', '~0.5.0', '>=0.5.0', '^0.5.x', '^1.2.3-beta', '^01.2.3', '^1.2.3+b', '*']) {
		assert.equal(parseRange(bad), undefined, bad);
	}
});

test('caret bounds: 1.x, 0.x and 0.0.x', () => {
	assert.ok(satisfies('1.2.3', '^1.2.3') && satisfies('1.9.0', '^1.2.3') && satisfies('1.2.4', '^1.2.3'));
	assert.ok(!satisfies('1.2.2', '^1.2.3') && !satisfies('2.0.0', '^1.2.3'));
	assert.ok(satisfies('0.5.0', '^0.5.0') && satisfies('0.5.9', '^0.5.0'));
	assert.ok(!satisfies('0.4.9', '^0.5.0') && !satisfies('0.6.0', '^0.5.0') && !satisfies('1.0.0', '^0.5.0'));
	assert.ok(satisfies('0.0.3', '^0.0.3'));
	assert.ok(!satisfies('0.0.4', '^0.0.3') && !satisfies('0.0.2', '^0.0.3') && !satisfies('0.1.0', '^0.0.3'));
});

test('an exact range accepts only that version', () => {
	assert.ok(satisfies('0.5.0', '0.5.0'));
	assert.ok(!satisfies('0.5.1', '0.5.0') && !satisfies('0.4.9', '0.5.0'));
});

test('a pre-release, build suffix or non-semver version never satisfies', () => {
	for (const v of ['0.5.0-beta.1', '0.5.0+build', 'v0.5.0', '0.5', 'latest', '', '0.5.0 ']) {
		assert.equal(satisfies(v, '^0.5.0'), false, v);
		assert.equal(satisfies(v, '0.5.0'), false, v);
	}
	assert.equal(satisfies('0.5.0', '~0.5.0'), false);
});

test('problem kinds: missing needs a required dependency; a present optional one is checked', () => {
	const set = [
		mod('a', '1.0.0', {gone: dep('^1.0.0'), maybe: dep('^1.0.0', true), old: dep('^2.0.0'), fresh: dep('^0.1.0'), odd: dep('^1.0.0'), ok: dep('^1.0.0'), opt: dep('^3.0.0', true)}),
		mod('old', '1.9.9'),
		mod('fresh', '0.2.0'),
		mod('odd', '1.0.0-rc.1'),
		mod('ok', '1.4.0'),
		mod('opt', '2.0.0'),
	];
	const found = dependencyProblems(set).map(p => `${p.kind} ${p.dependency}`);
	assert.deepEqual(found, ['missing gone', 'too-old old', 'too-new fresh', 'unversioned odd', 'too-old opt']);
});

test('problem texts name both sides and the fix', () => {
	const [old] = dependencyProblems([mod('claude', '0.34.0', {chat: dep('^0.5.0', false, 'chat')}), mod('chat', '0.4.0')]);
	assert.equal(problemText(old!), 'claude needs chat ^0.5.0, installed 0.4.0; run "mod update chat"');
	const [fresh] = dependencyProblems([mod('claude', '0.34.0', {chat: dep('^0.5.0', false, 'chat')}), mod('chat', '0.6.0')]);
	assert.equal(problemText(fresh!), 'claude needs chat ^0.5.0, installed 0.6.0; run "mod update claude"');
	const [missing] = dependencyProblems([mod('claude', '0.34.0', {chat: dep('^0.5.0', false, 'user/chat')})]);
	assert.equal(problemText(missing!), 'claude needs chat ^0.5.0, which is not installed; run "mod install user/chat"');
});

test('a refused module takes its dependents with it, through optional dependencies too', () => {
	const modules = [
		{manifest: mod('md', '0.2.0')},
		{manifest: mod('project', '0.4.0', {md: dep('^0.1.0')})},
		{manifest: mod('task', '0.9.0', {project: dep('^0.4.0')})},
		{manifest: mod('claude', '0.34.0', {project: dep('^0.4.0', true)})},
		{manifest: mod('dev', '0.5.0')},
	];
	const {modules: loaded, refused} = loadableModules(modules);
	assert.deepEqual(loaded.map(m => m.manifest.name), ['md', 'dev']);
	assert.deepEqual(refused.map(r => r.name), ['claude', 'project', 'task']);
	assert.deepEqual(refused.find(r => r.name === 'project')!.reasons, ['project needs md ^0.1.0, installed 0.2.0; run "mod update project"']);
	assert.deepEqual(refused.find(r => r.name === 'task')!.reasons, ['task needs project, which is not loaded']);
	assert.deepEqual(refused.find(r => r.name === 'claude')!.reasons, ['claude needs project, which is not loaded']);
});

test('core is never refused and an absent optional dependency is fine', () => {
	const {modules, refused} = loadableModules([{manifest: mod('core', '0.22.0')}, {manifest: mod('claude', '1.0.0', {project: dep('^0.4.0', true), core: dep('^0.22.0')})}]);
	assert.equal(refused.length, 0);
	assert.equal(modules.length, 2);
	const odd = loadableModules([{manifest: mod('core', '0.22.0', {x: dep('^1.0.0')})}]);
	assert.equal(odd.refused.length, 0);
});
