import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src/cli.ts');

async function makeHome(coreSource: string | null, plugin?: string) {
	const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-cli-')));
	if (coreSource !== null) {
		const dir = path.join(home, 'modules', 'core');
		await mkdir(dir, {recursive: true});
		await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name: 'core', version: '1.0.0', runtime: 'node', entry: 'index.mjs'}));
		await writeFile(path.join(dir, 'index.mjs'), coreSource);
	}
	if (plugin !== undefined) {
		const dir = path.join(home, 'modules', 'bad');
		await mkdir(dir, {recursive: true});
		await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name: 'bad', version: '0.1.0', runtime: 'node', entry: 'index.mjs'}));
		await writeFile(path.join(dir, 'index.mjs'), plugin);
	}
	return home;
}

function runCli(home: string, extra: Record<string, string> = {}) {
	const env: NodeJS.ProcessEnv = {...process.env, YENA_HOME: home, YENA_DATA: path.join(home, 'data'), ...extra};
	delete env.YENA_LOG_LEVEL;
	Object.assign(env, extra);
	const r = spawnSync(process.execPath, ['--import', 'tsx', cli], {env, encoding: 'utf8', cwd: repo, timeout: 60_000});
	return {status: r.status, stdout: r.stdout, stderr: r.stderr};
}

const records = async (home: string) =>
	(await readFile(path.join(home, 'logs', 'yena.log'), 'utf8'))
		.split('\n')
		.filter(Boolean)
		.map(l => JSON.parse(l) as {level: string; scope: string; msg: string; data?: Record<string, unknown>});

const OK_CORE = `export default yena => { yena.log.info('core ran'); };`;
const THROWING_CORE = `export default () => { throw new Error('core exploded'); };`;
const BAD_PLUGIN = `export default () => { throw new Error('plugin boom'); };`;

test('success: output identical with logging on and off, log has lifecycle records', async () => {
	const on = await makeHome(OK_CORE, BAD_PLUGIN);
	const off = await makeHome(OK_CORE, BAD_PLUGIN);
	const a = runCli(on);
	const b = runCli(off, {YENA_LOG: 'off'});
	assert.equal(a.status, 0);
	assert.deepEqual(a, b);
	assert.equal(a.stderr, 'Warning: plugin "bad" skipped: plugin boom\n');
	const msgs = (await records(on)).map(r => r.msg);
	for (const m of ['start', 'modules discovered', 'plugin skipped', 'core loaded', 'core ran']) assert.ok(msgs.includes(m), m);
	await assert.rejects(readFile(path.join(off, 'logs', 'yena.log')));
});

test('a throwing core: Error line and exit code unchanged, fatal logged with a stack', async () => {
	const on = await makeHome(THROWING_CORE);
	const off = await makeHome(THROWING_CORE);
	const a = runCli(on);
	const b = runCli(off, {YENA_LOG: 'off'});
	assert.equal(a.status, 1);
	assert.equal(a.stderr, 'Error: core exploded\n');
	assert.deepEqual(a, b);
	const fatal = (await records(on)).find(r => r.msg === 'fatal');
	assert.equal(fatal?.level, 'error');
	assert.match(JSON.stringify(fatal?.data), /core exploded/);
});

test('a missing core fails the clone: Error line identical, fatal logged', async () => {
	const on = await makeHome(null);
	const off = await makeHome(null);
	const env = {GIT_CONFIG_GLOBAL: '/dev/null', GIT_SSH_COMMAND: 'false', GIT_CONFIG_NOSYSTEM: '1'};
	const a = runCli(on, env);
	const b = runCli(off, {...env, YENA_LOG: 'off'});
	assert.equal(a.status, 1);
	assert.match(a.stderr, /^Error: /m);
	assert.deepEqual(a, b);
	const msgs = (await records(on)).map(r => r.msg);
	assert.ok(msgs.includes('start'));
	assert.ok(msgs.includes('fatal'));
});

test('an invalid YENA_LOG_LEVEL warns once and still runs', async () => {
	const home = await makeHome(OK_CORE);
	const r = runCli(home, {YENA_LOG_LEVEL: 'bogus'});
	assert.equal(r.status, 0);
	assert.equal(r.stderr.split('\n').filter(l => l.includes('YENA_LOG_LEVEL')).length, 1);
	assert.ok((await records(home)).some(x => x.msg === 'core ran'));
});
