import assert from 'node:assert/strict';
import {test} from 'node:test';
import {modCommand} from '../../src/pm/command.js';

test('mod asks for confirmation by default', () => {
	assert.equal(modCommand.agent, 'confirm');
});

test('mod subcommand agent policies', () => {
	const policies = Object.fromEntries((modCommand.subcommands ?? []).map(s => [s.name, s.agent]));
	assert.deepEqual(policies, {install: 'confirm', update: 'confirm', remove: 'confirm', list: 'safe', help: 'safe'});
});
