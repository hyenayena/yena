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

test('mod install splits --account off the sources', async () => {
	const {parseInstallArgs} = await import('../../src/pm/command.js');
	assert.deepEqual(parseInstallArgs(['core', 'dev']), {specs: ['core', 'dev']});
	assert.deepEqual(parseInstallArgs(['--account', 'bot', 'task']), {specs: ['task'], account: 'bot'});
	assert.deepEqual(parseInstallArgs(['task', '--account', 'bot', 'x/y']), {specs: ['task', 'x/y'], account: 'bot'});
	assert.throws(() => parseInstallArgs(['task', '--account']), /needs an account name/);
	assert.throws(() => parseInstallArgs(['--account', '--x', 'task']), /needs an account name/);
	assert.throws(() => parseInstallArgs(['--account', 'a', '--account', 'b', 'task']), /more than once/);
	assert.throws(() => parseInstallArgs(['--account', 'bot']), /needs the modules/);
	assert.throws(() => parseInstallArgs(['--force', 'task']), /Unknown option/);
});
