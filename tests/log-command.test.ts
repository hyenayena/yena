import assert from 'node:assert/strict';
import {mkdtemp, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {CommandContext, Subcommand} from '../src/api.js';
import {createLogCommand, logLevelSetting} from '../src/log-command.js';
import {createHostLogger, readLogSetting} from '../src/log/index.js';

async function fixture(env: NodeJS.ProcessEnv = {}, writable = true) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-logcmd-')));
	const make = () => createHostLogger({root, env, setting: undefined, onWarn: () => {}});
	const logger = make();
	const opts = {logger, stateDir: root, writable};
	const lines: string[] = [];
	const ctx = {print: (l: string) => void lines.push(l)} as unknown as CommandContext;
	return {root, logger, opts, command: createLogCommand(opts), lines, ctx};
}

test('policy: show is safe, each value asks', () => {
	const command = createLogCommand({} as never);
	assert.equal(command.agent, 'safe');
	const level = command.subcommands!.find(s => s.name === 'level') as Subcommand;
	assert.equal(level.agent, 'safe');
	assert.deepEqual(level.subcommands!.map(s => [s.name, s.agent]), [
		['error', 'confirm'],
		['warn', 'confirm'],
		['info', 'confirm'],
		['debug', 'confirm'],
		['off', 'confirm'],
	]);
});

test('log level shows the value and its source', async () => {
	const a = await fixture();
	await a.command.run(['level'], a.ctx);
	assert.deepEqual(a.lines, ['Log level: info (default)']);
	const b = await fixture({YENA_LOG_LEVEL: 'warn'});
	await b.command.run(['level'], b.ctx);
	assert.deepEqual(b.lines, ['Log level: warn (environment: YENA_LOG_LEVEL)']);
	await a.command.run(['level', 'debug'], a.ctx);
	a.lines.length = 0;
	await a.command.run(['level'], a.ctx);
	assert.deepEqual(a.lines, ['Log level: debug (setting)']);
});

test('setting a level persists and applies live', async () => {
	const f = await fixture();
	await f.command.run(['level', 'debug'], f.ctx);
	assert.equal(f.logger.level(), 'debug');
	assert.equal(await readLogSetting(f.root), 'debug');
	assert.match(f.lines[0]!, /^Log level: debug\. Applies now/);
});

test('refused when the environment fixes the level', async () => {
	const f = await fixture({YENA_LOG: 'off'});
	await assert.rejects(async () => f.command.run(['level', 'debug'], f.ctx), /set by YENA_LOG in the environment/);
	assert.equal(f.logger.level(), 'off');
	assert.equal(await readLogSetting(f.root), undefined);
});

test('invalid value, extra args, unknown subcommand and no YENA_DATA', async () => {
	const f = await fixture();
	await assert.rejects(async () => f.command.run(['level', 'loud'], f.ctx), {kind: 'invalid', message: /Unknown log level "loud"/});
	await assert.rejects(async () => f.command.run(['level', 'debug', 'x'], f.ctx), {kind: 'usage'});
	await assert.rejects(async () => f.command.run(['nope'], f.ctx), {kind: 'usage', message: /See log help/});
	assert.equal(f.logger.level(), 'info');
	const g = await fixture({}, false);
	await assert.rejects(async () => g.command.run(['level', 'debug'], g.ctx), /needs YENA_DATA/);
	assert.equal(g.logger.level(), 'info');
});

test('write failure restores the previous level', async () => {
	const f = await fixture();
	const blocked = {...f.opts, stateDir: path.join(f.root, 'log.json-parent', '\0bad')};
	await assert.rejects(async () => createLogCommand(blocked).run(['level', 'debug'], f.ctx));
	assert.equal(f.logger.level(), 'info');
});

test('no subcommand shows help, or the usage line without showHelp', async () => {
	const f = await fixture();
	await f.command.run([], f.ctx);
	assert.deepEqual(f.lines, ['log <subcommand>']);
	let shown = 0;
	await f.command.run([], {...f.ctx, showHelp: () => void shown++} as CommandContext);
	assert.equal(shown, 1);
});

test('the settings row follows the logger and is read-only when env-fixed', async () => {
	const f = await fixture();
	const row = logLevelSetting(f.opts);
	assert.equal(row.label, 'Log level');
	assert.equal(row.readOnly, undefined);
	await row.set('warn');
	assert.equal(await row.get(), 'warn');
	assert.equal(await readLogSetting(f.root), 'warn');
	const g = await fixture({YENA_LOG_LEVEL: 'info'});
	const fixed = logLevelSetting(g.opts);
	assert.match(fixed.readOnly!, /Set by YENA_LOG_LEVEL/);
	await assert.rejects(Promise.resolve().then(() => fixed.set('debug')), /YENA_LOG_LEVEL/);
});

test('an unknown word inherits safe from the command but is refused before any change', async () => {
	const f = await fixture();
	const level = f.command.subcommands!.find(s => s.name === 'level')!;
	assert.equal(level.subcommands!.some(s => s.name === 'loud'), false);
	assert.equal(level.agent, 'safe');
	await assert.rejects(async () => f.command.run(['level', 'loud'], f.ctx), {kind: 'invalid'});
	await assert.rejects(async () => f.command.run(['level', 'LOUD', 'debug'], f.ctx), {kind: 'usage'});
	assert.equal(f.logger.level(), 'info');
	assert.equal(await readLogSetting(f.root), undefined);
	assert.deepEqual(f.lines, []);
});

test('the stored level is read by a new logger, and the environment still wins over it', async () => {
	const f = await fixture();
	await f.command.run(['level', 'debug'], f.ctx);
	const next = createHostLogger({root: f.root, env: {}, setting: await readLogSetting(f.root), onWarn: () => {}});
	assert.equal(next.level(), 'debug');
	assert.deepEqual(next.levelSource(), {source: 'setting'});
	const fixed = createHostLogger({root: f.root, env: {YENA_LOG_LEVEL: 'error'}, setting: await readLogSetting(f.root), onWarn: () => {}});
	assert.equal(fixed.level(), 'error');
	assert.equal(fixed.levelSource().source, 'environment');
	const off = createHostLogger({root: f.root, env: {YENA_LOG: 'off'}, setting: 'debug', onWarn: () => {}});
	assert.equal(off.level(), 'off');
});

test('every value sets the level and the one-line answer names it', async () => {
	const f = await fixture();
	for (const value of ['error', 'warn', 'debug', 'off', 'info']) {
		f.lines.length = 0;
		await f.command.run(['level', value], f.ctx);
		assert.equal(f.logger.level(), value);
		assert.equal(await readLogSetting(f.root), value);
		assert.match(f.lines[0]!, new RegExp(`^Log level: ${value}`));
	}
});
