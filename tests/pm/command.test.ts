import assert from 'node:assert/strict';
import {test} from 'node:test';
import {modCommand} from '../../src/pm/command.js';
import type {CommandContext} from '../../src/api.js';

test('mod asks for confirmation by default', () => {
	assert.equal(modCommand.agent, 'confirm');
});

test('mod subcommand agent policies', () => {
	const policies = Object.fromEntries((modCommand.subcommands ?? []).map(s => [s.name, s.agent]));
	assert.deepEqual(policies, {install: 'confirm', update: 'confirm', remove: 'confirm', fix: 'confirm', lock: 'confirm', list: 'safe'});
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

test('mod without a subcommand shows the help through ctx.showHelp, or prints the usage without it', async () => {
	const lines: string[] = [];
	let shown = 0;
	const print = (l: string) => void lines.push(l);
	await modCommand.run([], {print, showHelp: () => void shown++} as unknown as CommandContext);
	await modCommand.run(['help'], {print, showHelp: () => void shown++} as unknown as CommandContext);
	assert.equal(shown, 2);
	assert.deepEqual(lines, []);
	await modCommand.run([], {print} as unknown as CommandContext);
	assert.deepEqual(lines, ['mod <subcommand>']);
});

test('mod fix takes --ranges and --yes and nothing else', async () => {
	const {parseFixArgs} = await import('../../src/pm/fix.js');
	assert.deepEqual(parseFixArgs([]), {yes: false, ranges: false});
	assert.deepEqual(parseFixArgs(['--yes']), {yes: true, ranges: false});
	assert.deepEqual(parseFixArgs(['--ranges', '--yes']), {yes: true, ranges: true});
	assert.throws(() => parseFixArgs(['--force']), /Unknown option "--force"/);
	assert.throws(() => parseFixArgs(['chat']), /takes no arguments/);
});

test('wrong line shapes are usage errors', async () => {
	const ctx: CommandContext = {print() {}, clear() {}, exit() {}};
	const usage = (error: Error & {kind?: string}) => error.kind === 'usage';
	await assert.rejects(Promise.resolve(modCommand.run(['nope'], ctx)), usage);
	await assert.rejects(Promise.resolve(modCommand.run(['lock', 'x'], ctx)), usage);
});
