import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {test} from 'node:test';
import type {LogThreshold} from '../../src/api.js';
import {setup} from './helpers.js';

test('info to debug writes debug records afterwards', () => {
	const {logger, records} = setup();
	logger.debug('before');
	assert.deepEqual(logger.setLevel('debug'), {ok: true});
	logger.debug('after');
	const msgs = records().map(r => r.msg);
	assert.ok(!msgs.includes('before'));
	assert.ok(msgs.includes('after'));
	assert.deepEqual(records().find(r => r.msg === 'level changed')?.data, {from: 'info', to: 'debug'});
	assert.deepEqual(logger.levelSource(), {source: 'setting'});
});

test('off writes nothing more, after noting the change', () => {
	const {logger, records} = setup();
	logger.setLevel('off');
	logger.error('nope');
	const msgs = records().map(r => r.msg);
	assert.deepEqual(msgs, ['level changed']);
	assert.equal(logger.level(), 'off');
});

test('off at start opens no file until a level is set', () => {
	const {logger, read} = setup({env: {YENA_LOG_LEVEL: 'off'}});
	assert.equal(logger.file, '');
	logger.info('x');
	assert.equal(logger.levelSource().source, 'environment');
	assert.equal(logger.setLevel('debug').ok, true);
	assert.notEqual(logger.file, '');
	logger.debug('now');
	assert.match(read(), /"msg":"now"/);
});

test('root and child listeners fire once per change; same level fires nothing', () => {
	const {logger} = setup();
	const seen: string[] = [];
	logger.onLevel(l => seen.push(`root:${l}`));
	logger.child('a').child('b').onLevel!(l => seen.push(`child:${l}`));
	logger.setLevel('info');
	assert.deepEqual(seen, []);
	logger.setLevel('debug');
	assert.deepEqual(seen, ['root:debug', 'child:debug']);
});

test('unsubscribe stops events and a throwing listener is harmless', () => {
	const {logger} = setup();
	const seen: LogThreshold[] = [];
	logger.onLevel(() => {
		throw new Error('boom');
	});
	const off = logger.onLevel(l => seen.push(l));
	assert.equal(logger.setLevel('warn').ok, true);
	off();
	logger.setLevel('error');
	assert.deepEqual(seen, ['warn']);
});

test('an open failure keeps the level and reports the code', () => {
	const {logger, root} = setup({
		env: {YENA_LOG_LEVEL: 'off'},
		io: {
			mkdirSync: () => {
				throw Object.assign(new Error('x'), {code: 'EACCES'});
			},
		},
	});
	assert.deepEqual(logger.setLevel('info'), {ok: false, code: 'EACCES'});
	assert.equal(logger.level(), 'off');
	assert.equal(logger.file, '');
	assert.ok(!existsSync(`${root}/logs`));
});

test('an escaped directory yields a logger that refuses changes', () => {
	const {logger, warnings} = setup({dir: '/elsewhere-yena-test'});
	assert.equal(warnings.length, 1);
	assert.deepEqual(logger.setLevel('debug'), {ok: false, code: 'EPERM'});
	assert.equal(logger.level(), 'info');
});

test('a level switched live reaches loggers made before the switch', () => {
	const {logger, records} = setup();
	const child = logger.child('chat').child('turn');
	child.debug('hidden');
	logger.setLevel('debug');
	child.debug('shown');
	logger.setLevel('error');
	child.warn('hidden too');
	child.error('still shown');
	const found = records().filter(r => r.scope === 'chat.turn').map(r => r.msg);
	assert.deepEqual(found, ['shown', 'still shown']);
	assert.equal(child.level?.(), 'error');
});

test('every threshold writes exactly the levels at or above it', () => {
	const order = ['error', 'warn', 'info', 'debug'] as const;
	for (const [i, threshold] of order.entries()) {
		const {logger, records} = setup({env: {YENA_LOG_LEVEL: threshold}});
		for (const at of order) logger[at](at);
		assert.deepEqual(records().map(r => r.msg), order.slice(0, i + 1), threshold);
	}
});

test('one record per change, none for the same level', () => {
	const {logger, records} = setup();
	logger.setLevel('info');
	assert.deepEqual(records(), []);
	logger.setLevel('debug');
	logger.setLevel('debug');
	logger.setLevel('off');
	logger.setLevel('off');
	const changes = records().filter(r => r.msg === 'level changed');
	assert.deepEqual(changes.map(r => r.data), [{from: 'info', to: 'debug'}, {from: 'debug', to: 'off'}]);
	assert.equal(changes[0]!.level, 'info');
	assert.equal(changes[0]!.scope, 'log');
});

test('listeners are capped at 64; the extra ones never fire and unsubscribe is harmless', () => {
	const {logger} = setup();
	let fired = 0;
	const offs = Array.from({length: 70}, () => logger.onLevel(() => void fired++));
	logger.setLevel('debug');
	assert.equal(fired, 64);
	for (const off of offs) off();
	logger.setLevel('warn');
	assert.equal(fired, 64);
	logger.onLevel(() => void fired++);
	logger.setLevel('error');
	assert.equal(fired, 65);
});

test('setLevel refuses an unknown level without throwing and keeps the level', () => {
	const {logger} = setup();
	const before = logger.level();
	for (const junk of ['loud', '', undefined, null, 3, {}, [], Symbol('x')]) {
		assert.deepEqual(logger.setLevel(junk as never), {ok: false, code: 'EINVAL'}, String(typeof junk));
	}
	assert.equal(logger.level(), before);
	assert.doesNotThrow(() => logger.error('still logs'));
});

test('the resolved source is kept until the first change, then it is the setting', () => {
	const fromEnv = setup({env: {YENA_LOG_LEVEL: 'warn'}});
	assert.deepEqual(fromEnv.logger.levelSource(), {source: 'environment', variable: 'YENA_LOG_LEVEL'});
	fromEnv.logger.setLevel('debug');
	assert.deepEqual(fromEnv.logger.levelSource(), {source: 'setting'});
	const stored = setup({setting: 'warn'});
	assert.equal(stored.logger.level(), 'warn');
	assert.deepEqual(stored.logger.levelSource(), {source: 'setting'});
	assert.deepEqual(setup().logger.levelSource(), {source: 'default'});
});
