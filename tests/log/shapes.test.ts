import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './helpers.js';

function one(fields: Record<string, unknown>, msg = 'm') {
	const s = setup();
	s.logger.info(msg, fields);
	assert.equal(s.lines().length, 1);
	return {rec: s.records()[0]!, line: s.lines()[0]!};
}

test('long messages and fields are truncated with a marker', () => {
	const {rec} = one({big: 'x'.repeat(5000)}, 'y'.repeat(9000));
	assert.match(rec.msg, /…\[truncated 4904 chars\]$/);
	assert.match(rec.data.big, /…\[truncated 3976 chars\]$/);
});

test('the whole record is capped by replacing data, not slicing JSON', () => {
	const fields: Record<string, unknown> = {};
	for (let i = 0; i < 20; i++) fields[`k${i}`] = 'v'.repeat(1000);
	const {rec, line} = one(fields);
	assert.deepEqual(rec.data, {truncated: true});
	assert.ok(Buffer.byteLength(line) <= 8192);
});

test('depth, array, key and top-level caps', () => {
	const {rec} = one({
		deep: {a: {b: {c: {d: 1}}}},
		arr: Array.from({length: 30}, (_, i) => i),
		obj: Object.fromEntries(Array.from({length: 30}, (_, i) => [`k${i}`, i])),
	});
	assert.equal(rec.data.deep.a.b.c, '[Object]');
	assert.equal(rec.data.arr.length, 21);
	assert.equal(rec.data.arr[20], '[10 more]');
	assert.equal(Object.keys(rec.data.obj).length, 21);

	const many = Object.fromEntries(Array.from({length: 40}, (_, i) => [`f${i}`, i]));
	assert.equal(Object.keys(one(many).rec.data).length, 21);
});

test('unusual values are converted safely', () => {
	const circular: Record<string, unknown> = {name: 'c'};
	circular.self = circular;
	class Thing {
		secretish = 1;
	}
	const getter = {
		get boom(): string {
			throw new Error('nope');
		},
		ok: 1,
	};
	const proxy = new Proxy(
		{},
		{
			ownKeys() {
				throw new Error('trap');
			},
		},
	);
	const {rec} = one({
		big: 123n,
		sym: Symbol('s'),
		fn: () => 1,
		buf: Buffer.alloc(10),
		typed: new Uint8Array(4),
		map: new Map([[1, 2]]),
		set: new Set([1, 2, 3]),
		date: new Date('2026-01-02T03:04:05.000Z'),
		bad: new Date(NaN),
		circular,
		inst: new Thing(),
		getter,
		proxy,
		undef: undefined,
		nan: NaN,
	});
	const d = rec.data;
	assert.equal(d.big, '123n');
	assert.equal(d.sym, '[Symbol]');
	assert.equal(d.fn, '[Function]');
	assert.equal(d.buf, '[Buffer 10 bytes]');
	assert.equal(d.typed, '[Buffer 4 bytes]');
	assert.equal(d.map, '[Map 1]');
	assert.equal(d.set, '[Set 3]');
	assert.equal(d.date, '2026-01-02T03:04:05.000Z');
	assert.equal(d.circular.self, '[Circular]');
	assert.equal(d.inst, '[Thing]');
	assert.equal(d.getter.boom, '[Unserializable]');
	assert.equal(d.getter.ok, 1);
	assert.equal(d.proxy, '[Unserializable]');
	assert.equal(d.undef, null);
	assert.equal(d.nan, 'NaN');
});

test('errors keep a whitelist of properties and never dump extras', () => {
	const err = Object.assign(new Error('bad', {cause: new Error('root')}), {
		code: 'E_X',
		status: 500,
		headers: {authorization: 'Bearer zzzzzzzzzzzz'},
		config: {url: 'x'},
	});
	const {rec, line} = one({err});
	assert.equal(rec.data.err.code, 'E_X');
	assert.equal(rec.data.err.status, 500);
	assert.equal(rec.data.err.cause.message, 'root');
	assert.ok(typeof rec.data.err.stack === 'string');
	assert.ok(!('headers' in rec.data.err) && !('config' in rec.data.err));
	assert.ok(!line.includes('zzzzzzzzzzzz'));
});

test('cause chains stop at a depth limit and aggregates keep 3 members', () => {
	let chain: Error = new Error('e0');
	for (let i = 1; i < 10; i++) chain = new Error(`e${i}`, {cause: chain});
	const agg = new AggregateError([1, 2, 3, 4, 5].map(i => new Error(`m${i}`)), 'many');
	const {rec} = one({chain, agg});
	let depth = 0;
	for (let c = rec.data.chain; c; c = c.cause) depth++;
	assert.ok(depth <= 4);
	assert.equal(rec.data.agg.errors.length, 3);
});

test('denylisted and secret keys are replaced at any depth', () => {
	const {rec, line} = one({
		prompt: 'tell me secrets',
		nested: {body: 'abcdef', api_key: 'plain', authorization: 'x', Cookie: 'y', credentials: {a: 1}, inputTokens: 12},
		list: [{content: 'hello'}],
		env: {HOME: '/root'},
	});
	assert.equal(rec.data.prompt, '[omitted 15 chars]');
	assert.equal(rec.data.nested.body, '[omitted 6 chars]');
	assert.equal(rec.data.nested.api_key, '[redacted]');
	assert.equal(rec.data.nested.authorization, '[redacted]');
	assert.equal(rec.data.nested.Cookie, '[redacted]');
	assert.equal(rec.data.nested.credentials, '[redacted]');
	assert.equal(rec.data.nested.inputTokens, 12);
	assert.equal(rec.data.list[0].content, '[omitted 5 chars]');
	assert.equal(rec.data.env, '[omitted]');
	assert.ok(!line.includes('tell me secrets'));
});
