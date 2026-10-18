import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SECRET, setup} from './helpers.js';

function logged(msg: string, fields?: Record<string, unknown>, redactor?: (t: string) => string) {
	const s = setup();
	if (redactor) s.logger.addRedactor(redactor);
	s.logger.info(msg, fields);
	return {raw: s.read(), rec: s.records()[0]!};
}

test('built-in token shapes are redacted', () => {
	const samples = [
		SECRET,
		'sk-ant-api03-abcdefghijklmnop_QRST-uvw',
		'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2',
		'ghp_' + 'A'.repeat(36),
		'github_pat_' + 'B'.repeat(30),
		'AKIA' + 'ABCDEFGHIJKLMNOP',
		'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl',
	];
	for (const s of samples) {
		const {raw} = logged(`value ${s} end`, {k: s});
		assert.ok(!raw.includes(s), s);
		assert.ok(raw.includes('[redacted]'), s);
	}
});

test('PEM private key blocks are redacted', () => {
	const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\n-----END RSA PRIVATE KEY-----';
	const {raw} = logged(`key ${pem} done`);
	assert.ok(!raw.includes('MIIEabc123'));
	assert.ok(raw.includes('done'));
});

test('Bearer, Basic, key=value and JSON values', () => {
	const cases = [
		'Authorization: Bearer abcdef0123456789',
		'Basic dXNlcjpwYXNzd29yZA==',
		'password=hunter2hunter2',
		'api_key: zzzzzzzz',
		'{"token":"s3cr3t-value"}',
		"access_token='s3cr3t-value'",
	];
	for (const c of cases) {
		const {raw} = logged(c);
		assert.ok(!/abcdef0123456789|dXNlcjpwYXNzd29yZA|hunter2|zzzzzzzz|s3cr3t/.test(raw), c);
	}
});

test('URL userinfo is redacted except a bare git', () => {
	assert.ok(!logged('clone https://user:pw123@github.com/a/b').raw.includes('pw123'));
	assert.ok(!logged('clone https://tok123@github.com/a/b').raw.includes('tok123'));
	assert.ok(logged('clone ssh://git@github.com/a/b').raw.includes('ssh://git@github.com/a/b'));
});

test('commit SHAs and UUIDs are not redacted', () => {
	const sha = 'a'.repeat(20) + '0123456789abcdef0123';
	const uuid = '123e4567-e89b-12d3-a456-426614174000';
	const {rec} = logged(`sha ${sha} session ${uuid}`);
	assert.ok(rec.msg.includes(sha));
	assert.ok(rec.msg.includes(uuid));
});

test('registered redactors run; duplicates are ignored; a throwing one fails closed', () => {
	let calls = 0;
	const fn = (t: string) => {
		calls++;
		return t.replaceAll('exactvalue', '[x]');
	};
	const s = setup();
	s.logger.addRedactor(fn);
	s.logger.child('a').addRedactor(fn);
	s.logger.info('has exactvalue here');
	assert.equal(s.records()[0]!.msg, 'has [x] here');
	assert.equal(calls, 1);

	const bad = logged('secretish text', {a: 'b'}, () => {
		throw new Error('x');
	});
	assert.equal(bad.rec.msg, '[unredactable]');
	assert.deepEqual(bad.rec.data, {'[unredactable]': '[unredactable]'});
});

test('the redactor registry is capped at 64, evicting the oldest', () => {
	const s = setup();
	const first = (t: string) => t.replaceAll('FIRST', '[1]');
	s.logger.addRedactor(first);
	for (let i = 0; i < 64; i++) s.logger.addRedactor(t => t + '');
	s.logger.info('FIRST');
	assert.equal(s.records()[0]!.msg, 'FIRST');
});

test('secrets split by escape or invisible characters are still caught', () => {
	const half = SECRET.length >> 1;
	for (const sep of ['\u001b[31m', '\u001b]0;title\u0007', '​', '‮', '\u009b']) {
		const split = SECRET.slice(0, half) + sep + SECRET.slice(half);
		const {raw, rec} = logged(`x ${split} y`, {k: split});
		assert.ok(!raw.includes(SECRET.slice(0, 20)), JSON.stringify(sep));
		assert.ok(rec.ctl >= 2);
	}
});

test('secrets in error message, stack and cause are redacted', () => {
	const err = new Error(`failed ${SECRET}`, {cause: new Error(`inner ${SECRET}`)});
	err.stack = `Error: ${SECRET}\n    at x`;
	const {raw, rec} = logged('boom', {err});
	assert.ok(!raw.includes('TESTVALUE'));
	assert.equal(rec.data.err.name, 'Error');
	assert.ok(rec.data.err.cause.message.includes('[redacted]'));
});

test('truncation never leaves a secret prefix at the cap edge', () => {
	for (let pad = 4096 - SECRET.length - 3; pad <= 4096 + 2; pad++) {
		const {raw, rec} = logged('a'.repeat(pad) + SECRET);
		assert.ok(!raw.includes('sk-ant-oat'), String(pad));
		assert.ok(rec.msg.length <= 4096 + 40);
	}
});

test('a 1 MiB adversarial string is handled within a time bound', () => {
	const inputs = [
		'sk-ant-'.repeat(150_000),
		'Bearer '.repeat(150_000),
		'password'.repeat(130_000),
		'https://' + 'a'.repeat(1 << 20),
		'-----BEGIN PRIVATE KEY-----' + 'x'.repeat(1 << 20),
		'eyJ' + 'a'.repeat(1 << 20),
	];
	const start = Date.now();
	for (const input of inputs) logged(input, {k: input});
	assert.ok(Date.now() - start < 5000, `took ${Date.now() - start}ms`);
});

test('secrets split by U+2028 or U+2029 are redacted in messages, fields, keys and errors', () => {
	for (const sep of ['\u2028', '\u2029']) {
		const split = SECRET.split('').join(sep);
		const s = setup();
		s.logger.info(`m ${split}`, {value: split, [split]: 1, err: new Error(`e ${split}`)});
		const raw = s.read();
		assert.ok(!raw.includes('TESTVALUE'), JSON.stringify(sep));
		assert.ok(!/t\\u202[89]e\\u202[89]s\\u202[89]t/i.test(raw));
		assert.equal(s.lines().length, 1);
		const rec = s.records()[0]!;
		assert.ok(rec.ctl >= 4 * (SECRET.length - 1));
		assert.equal(rec.msg, 'm [redacted]');
		assert.equal(rec.data.value, '[redacted]');
		assert.equal(rec.data.err.message, 'e [redacted]');
	}
});

test('newline-split secrets are a documented residual risk and are not recombined', () => {
	const {rec} = logged(`a ${SECRET.slice(0, 12)}\n${SECRET.slice(12)} b`);
	assert.ok(rec.msg.includes('\n'));
});

test('key=value redaction covers the whole rest of the line', () => {
	assert.equal(logged('password: my secret pass').rec.msg, 'password: [redacted]');
	assert.equal(logged('Authorization: Bearer abc12').rec.msg, 'Authorization: [redacted]');
	assert.equal(logged('Bearer abc12').rec.msg, 'Bearer [redacted]');
	assert.equal(logged('Basic x').rec.msg, 'Basic [redacted]');
	assert.equal(logged('login ok\npassword=a b c\nnext').rec.msg, 'login ok\npassword=[redacted]\nnext');
	assert.equal(logged('{"password":"two words","x":1}').rec.msg, '{"password":"[redacted]');
});

test('usage counters are not redacted', () => {
	assert.equal(logged('tokens=5').rec.msg, 'tokens=5');
	assert.equal(logged('inputTokens: 5 used').rec.msg, 'inputTokens: 5 used');
});

test('repeated key fragments in a 1 MiB string redact in linear time', () => {
	const input = 'password: '.repeat(1 << 17);
	const start = Date.now();
	const {rec} = logged(input);
	assert.ok(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
	assert.ok(!rec.msg.includes('password: password'));
});
