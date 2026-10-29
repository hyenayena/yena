import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {SECRET, tmp} from './helpers.js';

const child = path.resolve(import.meta.dirname, '../fixtures/log-child.ts');

function run(mode: string) {
	const root = tmp();
	const r = spawnSync(process.execPath, ['--import', 'tsx', child, mode, root], {
		encoding: 'utf8',
		env: {...process.env, YENA_LOG: 'on', YENA_LOG_LEVEL: 'info'},
	});
	const file = path.join(root, 'logs', 'yena.log');
	const records = existsSync(file)
		? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>)
		: [];
	return {...r, root, records};
}

test('a normal exit logs exit with code 0, once despite repeated installs', () => {
	const r = run('normal');
	assert.equal(r.status, 0);
	assert.deepEqual(r.records.map(x => x.msg), ['hello', 'exit']);
	assert.equal(r.records[1]!.data.code, 0);
	assert.equal(r.records[1]!.scope, 'process');
});

test('process.exit(3) keeps the exit code and logs it', () => {
	const r = run('exit3');
	assert.equal(r.status, 3);
	assert.equal(r.records.at(-1)!.msg, 'exit');
	assert.equal(r.records.at(-1)!.data.code, 3);
});

for (const kind of ['throw', 'reject']) {
	test(`an uncaught ${kind} still crashes identically and is logged with its stack`, () => {
		const hooked = run(kind);
		const baseline = run(`baseline-${kind}`);
		assert.equal(hooked.status, 1);
		assert.equal(baseline.status, 1);
		assert.equal(hooked.stderr.replaceAll(hooked.root, 'R'), baseline.stderr.replaceAll(baseline.root, 'R'));
		const rec = hooked.records.find(x => x.msg === 'uncaught')!;
		assert.ok(rec, 'uncaught record');
		assert.equal(rec.level, 'error');
		assert.ok(['uncaughtException', 'unhandledRejection'].includes(rec.data.origin));
		assert.match(rec.data.err.stack, /log-child/);
		assert.ok(!JSON.stringify(rec).includes(SECRET));
		assert.equal(hooked.records.at(-1)!.data.code, 1);
	});
}
