import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createHostLogger, resolveLogLevel} from '../../src/log/index.js';
import {tmp} from './helpers.js';

test('defaults to info from the default source', () => {
	assert.deepEqual(resolveLogLevel({}), {level: 'info', source: 'default', warnings: []});
});

test('level parsing ignores case and whitespace; empty is unset', () => {
	assert.equal(resolveLogLevel({YENA_LOG_LEVEL: '  DeBuG '}).level, 'debug');
	assert.equal(resolveLogLevel({YENA_LOG_LEVEL: 'error'}).level, 'error');
	assert.equal(resolveLogLevel({YENA_LOG_LEVEL: 'off'}).level, 'off');
	assert.deepEqual(resolveLogLevel({YENA_LOG_LEVEL: ''}).warnings, []);
	assert.equal(resolveLogLevel({YENA_LOG_LEVEL: '  '}).level, 'info');
});

test('precedence: environment over the setting over the default', () => {
	assert.deepEqual(resolveLogLevel({}, 'warn'), {level: 'warn', source: 'setting', warnings: []});
	assert.deepEqual(resolveLogLevel({YENA_LOG_LEVEL: 'debug'}, 'warn'), {
		level: 'debug',
		source: 'environment',
		variable: 'YENA_LOG_LEVEL',
		warnings: [],
	});
	assert.deepEqual(resolveLogLevel({YENA_LOG: 'off', YENA_LOG_LEVEL: 'debug'}, 'warn'), {
		level: 'off',
		source: 'environment',
		variable: 'YENA_LOG',
		warnings: [],
	});
});

test('YENA_LOG off values win; on values fix nothing', () => {
	for (const v of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(resolveLogLevel({YENA_LOG: v}).level, 'off', v);
	for (const v of ['on', '1', 'true', '', undefined]) {
		const r = resolveLogLevel({YENA_LOG: v}, 'debug');
		assert.deepEqual([r.level, r.source], ['debug', 'setting'], String(v));
	}
});

test('invalid values warn once and fall back to the setting or info', () => {
	const level = resolveLogLevel({YENA_LOG_LEVEL: 'x'});
	assert.deepEqual([level.level, level.source], ['info', 'default']);
	assert.deepEqual(level.warnings, ['Warning: YENA_LOG_LEVEL="x" is not valid (error|warn|info|debug|off); using info']);
	const stored = resolveLogLevel({YENA_LOG_LEVEL: 'x'}, 'warn');
	assert.deepEqual([stored.level, stored.source], ['warn', 'setting']);
	assert.match(stored.warnings[0]!, /using the setting/);
	const on = resolveLogLevel({YENA_LOG: 'maybe'});
	assert.deepEqual([on.level, on.source], ['info', 'default']);
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
