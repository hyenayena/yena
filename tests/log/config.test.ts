import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createHostLogger, readLogConfig} from '../../src/log/index.js';
import {tmp} from './helpers.js';

test('defaults to enabled at info', () => {
	assert.deepEqual(readLogConfig({}), {enabled: true, level: 'info', warnings: []});
});

test('level parsing ignores case and whitespace; empty is unset', () => {
	assert.equal(readLogConfig({YENA_LOG_LEVEL: '  DeBuG '}).level, 'debug');
	assert.equal(readLogConfig({YENA_LOG_LEVEL: 'error'}).level, 'error');
	assert.deepEqual(readLogConfig({YENA_LOG_LEVEL: ''}).warnings, []);
	assert.equal(readLogConfig({YENA_LOG_LEVEL: '  '}).level, 'info');
});

test('off values disable logging', () => {
	for (const v of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(readLogConfig({YENA_LOG: v}).enabled, false, v);
	for (const v of ['on', '1', 'true', '', undefined]) assert.equal(readLogConfig({YENA_LOG: v}).enabled, true, String(v));
});

test('invalid values fall back with exactly one warning each', () => {
	const level = readLogConfig({YENA_LOG_LEVEL: 'x'});
	assert.equal(level.level, 'info');
	assert.deepEqual(level.warnings, ['Warning: YENA_LOG_LEVEL="x" is not valid (error|warn|info|debug); using info']);
	const on = readLogConfig({YENA_LOG: 'maybe'});
	assert.equal(on.enabled, true);
	assert.equal(on.warnings.length, 1);
});

test('YENA_LOG=off yields a logger that writes nothing', () => {
	const root = tmp();
	const log = createHostLogger({root, env: {YENA_LOG: 'off'}});
	log.info('x');
	log.child('a').error('y');
	assert.equal(log.file, '');
	assert.ok(!existsSync(path.join(root, 'logs')));
	assert.equal(log.child('a').child('b').redact!('x'), 'x');
	log.close();
});
