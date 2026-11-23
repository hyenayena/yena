import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {createRulesSlot, rulesLayout, RULES_MODULE} from '../src/rules-provider.js';

const provider = () => ({exportFilter: async () => undefined});

test('only the module named rules can register, the first provider wins', () => {
	const slot = createRulesSlot();
	assert.equal(RULES_MODULE, 'rules');
	assert.equal(slot.current(), undefined);
	assert.equal(slot.register(provider(), 'evil'), false);
	assert.equal(slot.current(), undefined);
	const first = provider();
	assert.equal(slot.register(first, 'rules'), true);
	assert.equal(slot.register(provider(), 'rules'), false);
	assert.equal(slot.current(), first);
});

test('a malformed provider from the rules module throws', () => {
	const slot = createRulesSlot();
	for (const bad of [null, 'x', {}, {exportFilter: 1}]) {
		assert.throws(() => slot.register(bad as never, 'rules'), /invalid rules provider from rules/);
	}
	assert.equal(slot.current(), undefined);
});

test('rulesLayout resolves the code dirs, joins the data dirs and carries the legacy export list', () => {
	const layout = rulesLayout(
		[
			{dir: '/app/modules/a/../a', manifest: {name: 'a', export: {deny: ['x']}}},
			{dir: '/app/modules/b', manifest: {name: 'b'}},
		],
		'/app',
		'/data',
	);
	assert.deepEqual(layout, {
		root: '/app',
		modules: [
			{name: 'a', codeDir: '/app/modules/a', dataDir: path.join('/data', 'a'), legacyExport: {deny: ['x']}},
			{name: 'b', codeDir: '/app/modules/b', dataDir: path.join('/data', 'b')},
		],
	});
	assert.equal('root' in rulesLayout([], undefined, '/data'), false);
});
