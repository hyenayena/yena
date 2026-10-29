import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {setup} from './helpers.js';

test('control characters are escaped and the file has one line per record', () => {
	const {logger, lines, records, read} = setup();
	const payloads = ['a\nb', 'a\rb', 'a\r\nb', 'a\u007fb', 'a\u0000b\tc'];
	for (const p of payloads) logger.info(p, {p});
	assert.equal(lines().length, payloads.length);
	assert.equal(read().split('\n').length, payloads.length + 1);
	assert.deepEqual(records().map(r => r.msg), payloads);
	assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(read()));
});

test('LS and PS are stripped and counted', () => {
	const {logger, records} = setup();
	logger.info('a\u2028b\u2029c');
	assert.equal(records()[0]!.msg, 'abc');
	assert.equal(records()[0]!.ctl, 2);
});

test('ANSI, OSC, CSI, C1, bidi, zero-width and tag characters are stripped and counted', () => {
	const cases: Array<[string, number]> = [
		['a\u001b[31mred\u001b[0mb', 2],
		['a\u001b]0;title\u0007b', 1],
		['a\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\b', 2],
		['a\u0085b\u009bc', 2],
		['a‮b⁦c', 2],
		['a​b﻿c', 2],
		['a\u{E0041}b', 1],
	];
	for (const [input, n] of cases) {
		const {logger, records, read} = setup();
		logger.info(input);
		const r = records()[0]!;
		assert.equal(r.ctl, n, JSON.stringify(input));
		assert.ok(/^a.*b/.test(r.msg) && !/[\u001b\u0080-\u009f​‮⁦﻿]/u.test(r.msg));
		assert.ok(!/[\u001b\u0080-\u009f‮​]/u.test(read()));
	}
});

test('no ctl field when nothing was removed', () => {
	const {logger, records} = setup();
	logger.info('plain');
	assert.equal('ctl' in records()[0]!, false);
});

test('a payload cannot forge a second record', () => {
	const {logger, lines, records} = setup();
	const forged = '{"ts":"x","level":"error","scope":"evil","pid":1,"msg":"forged"}';
	logger.info(`hi\n${forged}`, {note: `\n${forged}`, [`k\n${forged}`]: 1});
	assert.equal(lines().length, 1);
	assert.equal(records()[0]!.scope, 'host');
});

test('the file round-trips through JSON.parse including lone surrogates', () => {
	const {logger, file} = (() => {
		const s = setup();
		return {logger: s.logger, file: s.logger.file};
	})();
	logger.info('lone \ud800 and \udc00 and \u{1F600}', {x: '\ud800'});
	for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) JSON.parse(line);
});
