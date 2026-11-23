import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseExportRules} from '../../src/pm/export-rules.js';

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
