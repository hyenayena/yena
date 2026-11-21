import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Logger} from '../src/api.js';
import {createReload, RELAUNCH_ENV, RELOAD_STATUS, takeRelaunch} from '../src/reload.js';

const silent = (infos: string[] = []): Logger => {
	const log: Logger = {
		error() {},
		warn() {},
		info: message => void infos.push(message),
		debug() {},
		child: () => log,
		addRedactor() {},
	};
	return log;
};

test('takeRelaunch is true only for "1" and always removes the key', () => {
	for (const [value, expected] of [['1', true], ['0', false], ['', false], ['true', false], [undefined, false]] as const) {
		const env: NodeJS.ProcessEnv = value === undefined ? {} : {[RELAUNCH_ENV]: value};
		assert.equal(takeRelaunch(env), expected, String(value));
		assert.ok(!(RELAUNCH_ENV in env));
	}
});

test('reload sets the status once, logs, and arms the fallback exit', async () => {
	const codes: number[] = [];
	const exits: number[] = [];
	const infos: string[] = [];
	const reload = createReload({log: silent(infos), setExitCode: c => codes.push(c), exit: c => exits.push(c), delayMs: 20});
	reload();
	reload();
	assert.deepEqual(codes, [RELOAD_STATUS]);
	assert.deepEqual(infos, ['reload requested']);
	assert.deepEqual(exits, []);
	await new Promise(resolve => setTimeout(resolve, 80));
	assert.deepEqual(exits, [75]);
});
