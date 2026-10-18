import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs, {existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {createHostLogger} from '../../src/log/index.js';
import {setup, tmp} from './helpers.js';

const child = path.resolve(import.meta.dirname, '../fixtures/log-child.ts');

test('files are created with modes 0600 and 0700 under <root>/logs', () => {
	const {root, logger} = setup();
	logger.info('x');
	assert.equal(logger.file, path.join(root, 'logs', 'yena.log'));
	assert.equal(statSync(path.join(root, 'logs')).mode & 0o777, 0o700);
	assert.equal(statSync(logger.file).mode & 0o777, 0o600);
});

test('rotation keeps the cap and three older generations', () => {
	const {root, logger} = setup({maxBytes: 600});
	for (let i = 0; i < 60; i++) logger.info(`record number ${i}`);
	const names = readdirSync(path.join(root, 'logs')).sort();
	assert.deepEqual(names, ['yena.1.log', 'yena.2.log', 'yena.3.log', 'yena.log']);
	for (const n of names) {
		const size = statSync(path.join(root, 'logs', n)).size;
		assert.ok(size < 600 + 300, `${n} ${size}`);
		for (const line of readFileSync(path.join(root, 'logs', n), 'utf8').split('\n').filter(Boolean)) JSON.parse(line);
	}
	assert.ok(readFileSync(logger.file, 'utf8').includes('record number 59'));
});

test('an oversized existing file is rotated at open', () => {
	const root = tmp();
	mkdirSync(path.join(root, 'logs'));
	writeFileSync(path.join(root, 'logs', 'yena.log'), 'x'.repeat(2000) + '\n');
	const logger = createHostLogger({root, env: {}, maxBytes: 1000, onWarn: () => {}});
	logger.info('fresh');
	assert.ok(existsSync(path.join(root, 'logs', 'yena.1.log')));
	assert.equal(readFileSync(logger.file, 'utf8').split('\n').filter(Boolean).length, 1);
});

test('two loggers on the same file keep every line intact', () => {
	const root = tmp();
	const a = createHostLogger({root, env: {}, onWarn: () => {}});
	const b = createHostLogger({root, env: {}, onWarn: () => {}});
	for (let i = 0; i < 100; i++) {
		a.info(`a${i}`);
		b.info(`b${i}`);
	}
	const lines = readFileSync(a.file, 'utf8').split('\n').filter(Boolean);
	assert.equal(lines.length, 200);
	for (const l of lines) JSON.parse(l);
});

test('parallel child processes append only intact lines', async () => {
	const root = tmp();
	const runs = [1, 2, 3].map(
		n =>
			new Promise<number | null>(resolve => {
				const p = spawn(process.execPath, ['--import', 'tsx', child, 'append', root, `proc${n}`], {
					env: {...process.env, YENA_LOG: 'on', YENA_LOG_LEVEL: 'info'},
				});
				p.on('close', resolve);
			}),
	);
	assert.deepEqual(await Promise.all(runs), [0, 0, 0]);
	const lines = readFileSync(path.join(root, 'logs', 'yena.log'), 'utf8').split('\n').filter(Boolean);
	const recs = lines.map(l => JSON.parse(l) as {msg: string});
	assert.equal(recs.filter(r => r.msg.startsWith('proc')).length, 600);
});

function expectDegraded(root: string, dir?: string) {
	const warnings: string[] = [];
	const logger = createHostLogger({root, dir, env: {}, onWarn: m => warnings.push(m)});
	assert.doesNotThrow(() => {
		logger.info('x');
		logger.child('c').error('y');
		logger.close();
	});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /^Warning: cannot write the log file \(\w+\); logging is disabled$/);
	return warnings[0]!;
}

test('a logs path that is a regular file degrades with one warning', () => {
	const root = tmp();
	writeFileSync(path.join(root, 'logs'), 'file');
	assert.match(expectDegraded(root), /ENOTDIR/);
});

test('a parent that is a file degrades with one warning', () => {
	const root = tmp();
	writeFileSync(path.join(root, 'parent'), 'file');
	expectDegraded(path.join(root, 'parent', 'sub'));
});

test('a symlinked logs directory is refused', () => {
	const root = tmp();
	const target = tmp();
	symlinkSync(target, path.join(root, 'logs'));
	assert.match(expectDegraded(root), /ELOOP/);
	assert.deepEqual(readdirSync(target), []);
});

test('a symlinked log file is refused', () => {
	const root = tmp();
	const target = path.join(tmp(), 'victim');
	writeFileSync(target, 'keep');
	mkdirSync(path.join(root, 'logs'));
	symlinkSync(target, path.join(root, 'logs', 'yena.log'));
	assert.match(expectDegraded(root), /ELOOP/);
	assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('a directory outside the root is refused', () => {
	const root = tmp();
	const other = tmp();
	expectDegraded(root, other);
	expectDegraded(root, path.join(root, 'logs', '..', '..', 'x'));
	assert.deepEqual(readdirSync(other), []);
});

test('write errors drop records silently and a notice follows recovery', () => {
	let failing = false;
	const warnings: string[] = [];
	const {logger, records, read} = setup({
		onWarn: m => warnings.push(m),
		io: {
			writeSync: ((fd: number, buf: Buffer) => {
				if (failing) throw Object.assign(new Error('full'), {code: 'ENOSPC'});
				return (fs.writeSync as (fd: number, buf: Buffer) => number)(fd, buf);
			}) as never,
		},
	});
	logger.info('before');
	failing = true;
	assert.doesNotThrow(() => {
		logger.info('lost1');
		logger.info('lost2');
	});
	failing = false;
	logger.info('after');
	const msgs = records().map(r => r.msg);
	assert.deepEqual(msgs, ['before', 'log: 2 records dropped', 'after']);
	assert.ok(!read().includes('lost'));
	assert.deepEqual(warnings, []);
});

test('a short write is followed by a newline so lines never merge', () => {
	let short = true;
	const {logger, lines} = setup({
		io: {
			writeSync: ((fd: number, buf: Buffer) => {
				const out = short ? buf.subarray(0, 10) : buf;
				short = false;
				return fs.writeSync(fd, out);
			}) as never,
		},
	});
	logger.info('torn');
	logger.info('good');
	const parsed = lines().filter(l => {
		try {
			JSON.parse(l);
			return true;
		} catch {
			return false;
		}
	});
	assert.ok(parsed.some(l => l.includes('"good"')));
});

test('a failing rotation falls back to truncation', () => {
	const {logger, read} = setup({
		maxBytes: 400,
		io: {
			renameSync: (() => {
				throw Object.assign(new Error('perm'), {code: 'EPERM'});
			}) as never,
		},
	});
	for (let i = 0; i < 30; i++) logger.info(`record ${i}`);
	assert.ok(read().length < 400 + 200);
	assert.ok(read().split('\n').filter(Boolean).length < 30);
});

test('concurrent writers keep total size bounded and records intact', async () => {
	const root = tmp();
	const cap = 40_000;
	const count = 400;
	const writers = [1, 2, 3, 4];
	const codes = await Promise.all(
		writers.map(
			n =>
				new Promise<number | null>(resolve => {
					const p = spawn(
						process.execPath,
						['--import', 'tsx', child, 'append', root, `w${n}`, String(cap), String(count)],
						{env: {...process.env, YENA_LOG: 'on', YENA_LOG_LEVEL: 'info'}},
					);
					p.on('close', resolve);
				}),
		),
	);
	assert.deepEqual(codes, [0, 0, 0, 0]);
	const dir = path.join(root, 'logs');
	let total = 0;
	const seen = new Set<string>();
	for (const name of readdirSync(dir)) {
		const text = readFileSync(path.join(dir, name), 'utf8');
		total += Buffer.byteLength(text);
		for (const line of text.split('\n').filter(Boolean)) {
			const rec = JSON.parse(line) as {msg: string};
			if (!/^w\d \d+$/.test(rec.msg)) continue;
			assert.ok(!seen.has(rec.msg), `duplicate ${rec.msg}`);
			seen.add(rec.msg);
		}
	}
	assert.ok(seen.size > 0);
	assert.ok(total <= 4 * cap * 1.5, `total ${total}`);
});
