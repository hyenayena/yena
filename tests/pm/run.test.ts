import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Logger} from '../../src/api.js';
import {run, scrubbedEnv} from '../../src/pm/run.js';

type Rec = {level: string; msg: string; fields?: Record<string, unknown>};

function fake(): {logger: Logger; recs: Rec[]} {
	const recs: Rec[] = [];
	const make = (): Logger => ({
		error: (msg, fields) => void recs.push({level: 'error', msg, fields}),
		warn: (msg, fields) => void recs.push({level: 'warn', msg, fields}),
		info: (msg, fields) => void recs.push({level: 'info', msg, fields}),
		debug: (msg, fields) => void recs.push({level: 'debug', msg, fields}),
		child: () => make(),
		addRedactor() {},
	});
	return {logger: make(), recs};
}

const script = (code: string) => ['-e', code];

test('failing child logs the last 5 stderr lines at warn and no output at info', async () => {
	const {logger, recs} = fake();
	const code = `for (let i = 1; i <= 8; i++) console.error('line' + i); process.exit(3)`;
	await assert.rejects(run(process.execPath, script(code), {trace: logger}), /exited with code 3/);
	const warn = recs.find(r => r.level === 'warn' && r.msg === 'child failed');
	assert.ok(warn);
	assert.equal(warn.fields?.code, 3);
	assert.equal(warn.fields?.stderrTail, 'line4\nline5\nline6\nline7\nline8');
	assert.ok(recs.some(r => r.msg === 'child exited' && r.fields?.code === 3));
	for (const r of recs.filter(r => r.level === 'info')) {
		assert.ok(!JSON.stringify(r.fields).includes('line'), 'child output must not appear at info');
	}
});

test('spawn record carries the command and subcommand only, not the full args', async () => {
	const {logger, recs} = fake();
	await run(process.execPath, ['-e', '0', 'secret-arg'], {trace: logger});
	const spawned = recs.find(r => r.msg === 'child spawned');
	assert.equal(spawned?.fields?.cmd, process.execPath);
	assert.ok(!JSON.stringify(spawned).includes('secret-arg'));
});

test('stderr tail lines are capped at 500 characters', async () => {
	const {logger, recs} = fake();
	await assert.rejects(run(process.execPath, script(`console.error('x'.repeat(2000)); process.exit(1)`), {trace: logger}));
	const tail = String(recs.find(r => r.msg === 'child failed')?.fields?.stderrTail);
	assert.ok(tail.length <= 501);
});

test('output lines go to debug only, and the Log callback still receives them', async () => {
	const {logger, recs} = fake();
	const lines: string[] = [];
	await run(process.execPath, script(`console.log('hello')`), {trace: logger, log: l => lines.push(l)});
	assert.deepEqual(lines, ['  hello']);
	assert.ok(recs.some(r => r.level === 'debug' && r.fields?.line === 'hello'));
});

test('run without trace behaves as before', async () => {
	assert.equal((await run(process.execPath, script(`process.stdout.write('ok')`))).trim(), 'ok');
});

test('scrubEnv leaves credentials and the ssh-agent out of the child', async () => {
	process.env.YENA_TEST_API_KEY = 'k';
	process.env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK ?? '/tmp/agent.sock';
	process.env.YENA_TEST_PLAIN = 'plain';
	try {
		const out = await run('echo "${YENA_TEST_API_KEY:-none} ${SSH_AUTH_SOCK:-none} ${YENA_TEST_PLAIN:-none}"', [], {shell: true, scrubEnv: true});
		assert.equal(out.trim(), 'none none plain');
		const full = await run('echo "${YENA_TEST_API_KEY:-none}"', [], {shell: true});
		assert.equal(full.trim(), 'k');
	} finally {
		delete process.env.YENA_TEST_API_KEY;
		delete process.env.YENA_TEST_PLAIN;
	}
	assert.deepEqual(Object.keys(scrubbedEnv({PATH: '/bin', MIRROR: 'https://u:p@h/x', GIT_URL: 'git@github.com:a/b', CLAUDE_CODE_OAUTH_TOKEN: 't'})), ['PATH', 'GIT_URL']);
});
