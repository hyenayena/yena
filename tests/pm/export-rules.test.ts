import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isDenied, parseExportRules} from '../../src/pm/export-rules.js';

test('parseExportRules accepts a deny list', () => {
	assert.deepEqual(parseExportRules({deny: []}), {deny: []});
	assert.deepEqual(parseExportRules({deny: ['state.json', 'cache/**', '*.tmp']}), {deny: ['state.json', 'cache/**', '*.tmp']});
});

test('parseExportRules rejects malformed rules', () => {
	const form = /"export" must be \{"deny"/;
	for (const bad of [null, 'x', 3, [], {}, {deny: 'x'}, {deny: [3]}, {deny: [], extra: 1}, {allow: []}]) {
		assert.throws(() => parseExportRules(bad), form);
	}
	assert.throws(() => parseExportRules({deny: Array.from({length: 65}, (_, i) => `f${i}`)}), /more than 64/);
	assert.throws(() => parseExportRules({deny: ['']}), /1 to 200 characters/);
	assert.throws(() => parseExportRules({deny: ['a'.repeat(201)]}), /1 to 200 characters/);
	assert.throws(() => parseExportRules({deny: ['/abs']}), /relative/);
	assert.throws(() => parseExportRules({deny: ['a\\b']}), /relative/);
	assert.throws(() => parseExportRules({deny: [`a${String.fromCharCode(0)}b`]}), /control character/);
	assert.throws(() => parseExportRules({deny: [`a${String.fromCharCode(0x1b)}b`]}), /control character/);
	for (const bad of ['../x', 'a/../b', './a', 'a/./b', 'a//b', 'a/']) {
		assert.throws(() => parseExportRules({deny: [bad]}), /empty, "\." or "\.\." segment/);
	}
});

test('no export list denies everything, an empty list nothing', () => {
	assert.equal(isDenied(undefined, 'a.json'), true);
	assert.equal(isDenied({deny: []}, 'a.json'), false);
});

test('"*" stops at "/" and matches dotfiles', () => {
	const rules = {deny: ['*.log', 'cache/*']};
	assert.equal(isDenied(rules, 'a.log'), true);
	assert.equal(isDenied(rules, '.hidden.log'), true);
	assert.equal(isDenied(rules, 'sub/a.log'), false);
	assert.equal(isDenied(rules, 'cache/x'), true);
	assert.equal(isDenied(rules, 'cache/.x'), true);
	assert.equal(isDenied(rules, 'other/cache/x'), false);
});

test('"?" is one character except "/"', () => {
	const rules = {deny: ['a?c']};
	assert.equal(isDenied(rules, 'abc'), true);
	assert.equal(isDenied(rules, 'ac'), false);
	assert.equal(isDenied(rules, 'abbc'), false);
});

test('"**" matches zero or more segments, dotfiles included', () => {
	assert.equal(isDenied({deny: ['**']}, 'a'), true);
	assert.equal(isDenied({deny: ['**']}, '.a/b/.c'), true);
	assert.equal(isDenied({deny: ['a/**/z']}, 'a/z'), true);
	assert.equal(isDenied({deny: ['a/**/z']}, 'a/b/c/z'), true);
	assert.equal(isDenied({deny: ['a/**/z']}, 'a/b/c'), false);
	assert.equal(isDenied({deny: ['**/secret.txt']}, 'secret.txt'), true);
	assert.equal(isDenied({deny: ['**/secret.txt']}, 'x/.y/secret.txt'), true);
});

test('a pattern denying a directory denies everything under it', () => {
	assert.equal(isDenied({deny: ['cache']}, 'cache/deep/file'), true);
	assert.equal(isDenied({deny: ['cache']}, 'cache'), true);
	assert.equal(isDenied({deny: ['cache']}, 'cachex'), false);
});

test('"dir/**" matches the directory itself', () => {
	assert.equal(isDenied({deny: ['dir/**']}, 'dir'), true);
	assert.equal(isDenied({deny: ['dir/**']}, 'dir/a/b'), true);
	assert.equal(isDenied({deny: ['dir/**']}, 'dirx'), false);
});

test('regular expression characters in patterns are literal', () => {
	assert.equal(isDenied({deny: ['a+b(1).txt']}, 'a+b(1).txt'), true);
	assert.equal(isDenied({deny: ['a.b']}, 'axb'), false);
});
