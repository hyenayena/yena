import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './helpers.js';

test('record shape, field order, pid and timestamp', () => {
	const {logger, lines, records} = setup();
	logger.info('credential resolved', {kind: 'oauth', source: 'env'});
	assert.equal(
		lines()[0],
		'{"ts":"2026-10-18T09:12:03.456Z","level":"info","scope":"host","pid":412,"msg":"credential resolved","data":{"kind":"oauth","source":"env"}}',
	);
	assert.equal(records()[0]!.pid, 412);
});

test('level filtering', () => {
	const {logger, records} = setup({env: {YENA_LOG_LEVEL: 'warn'}});
	logger.error('e');
	logger.warn('w');
	logger.info('i');
	logger.debug('d');
	assert.deepEqual(records().map(r => r.level), ['error', 'warn']);
	const dbg = setup({env: {YENA_LOG_LEVEL: 'debug'}});
	dbg.logger.debug('d');
	assert.equal(dbg.records().length, 1);
	const def = setup();
	def.logger.debug('d');
	def.logger.info('i');
	assert.equal(def.records().length, 1);
});

test('child scopes nest and invalid scopes are replaced', () => {
	const {logger, records} = setup();
	logger.child('claude').info('a');
	logger.child('claude').child('chat').info('b');
	logger.child('Bad Scope\n').info('c');
	logger.child('claude').child('').info('d');
	assert.deepEqual(records().map(r => r.scope), ['claude', 'claude.chat', 'invalid', 'claude.invalid']);
});

test('fields cannot override the envelope', () => {
	const {logger, records} = setup();
	logger.info('m', {ts: 'x', level: 'error', pid: 1, scope: 'z', msg: 'nope'});
	const r = records()[0]!;
	assert.equal(r.ts, '2026-10-18T09:12:03.456Z');
	assert.equal(r.level, 'info');
	assert.equal(r.pid, 412);
	assert.equal(r.scope, 'host');
	assert.equal(r.msg, 'm');
	assert.equal(r.data.ts, 'x');
});

test('the logger never throws into callers', () => {
	const {logger} = setup();
	assert.doesNotThrow(() => logger.info(undefined as never, 5 as never));
	assert.doesNotThrow(() => logger.child(null as never).info('x'));
	assert.doesNotThrow(() => logger.addRedactor(null as never));
});
