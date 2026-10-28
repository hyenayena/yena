import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
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

function runCli(home: string, extra: Record<string, string | undefined> = {}, args: string[] = []) {
	const env: NodeJS.ProcessEnv = {...process.env, YENA_HOME: home, YENA_DATA: path.join(home, 'data')};
	delete env.YENA_LOG_LEVEL;
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	const r = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {env, encoding: 'utf8', cwd: repo, timeout: 60_000});
	return {status: r.status, stdout: r.stdout, stderr: r.stderr};
}

const records = async (home: string, logDir = path.join(home, 'data', 'host', 'logs')) =>
	(await readFile(path.join(logDir, 'yena.log'), 'utf8'))
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
	await assert.rejects(readFile(path.join(off, 'data', 'host', 'logs', 'yena.log')));
	await assert.rejects(readFile(path.join(on, 'logs', 'yena.log')));
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
	// Core is fetched over https: no network protocol may reach out from the test.
	const env = {GIT_CONFIG_GLOBAL: '/dev/null', GIT_SSH_COMMAND: 'false', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file'};
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

async function snapshot(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, {recursive: true, withFileTypes: true})) {
		const file = path.join(entry.parentPath, entry.name);
		const st = await stat(file);
		out.push(`${path.relative(dir, file)} ${st.size} ${st.mtimeMs}`);
	}
	return out.sort();
}

async function setWritable(dir: string, writable: boolean) {
	for (const entry of await readdir(dir, {recursive: true, withFileTypes: true})) {
		if (entry.isDirectory()) await chmod(path.join(entry.parentPath, entry.name), writable ? 0o755 : 0o555);
	}
	await chmod(dir, writable ? 0o755 : 0o555);
}

const HEADLESS = `export default async (yena, req) => { yena.log.info('line ran'); console.log('ran ' + req.args.join(' ')); };`;

test('with YENA_DATA nothing is written under the code root: the UI start and a console line', async () => {
	const home = await makeHome(OK_CORE);
	const core = path.join(home, 'modules', 'core');
	await writeFile(path.join(core, 'yena.json'), JSON.stringify({name: 'core', version: '1.0.0', runtime: 'node', entry: 'index.mjs', headless: 'headless.mjs'}));
	await writeFile(path.join(core, 'headless.mjs'), HEADLESS);
	const data = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-cli-data-')));
	const before = await snapshot(home);
	// Read-only for real when the tests run as a regular user; as root (the container) the snapshot is the check.
	await setWritable(home, false);
	try {
		const ui = runCli(home, {YENA_DATA: data});
		assert.equal(ui.status, 0, ui.stderr);
		const line = runCli(home, {YENA_DATA: data}, ['--run', '--', 'mod', 'list']);
		assert.equal(line.status, 0, line.stderr);
		assert.equal(line.stdout, 'ran mod list\n');
	} finally {
		await setWritable(home, true);
	}
	assert.deepEqual(await snapshot(home), before);
	const msgs = (await records(home, path.join(data, 'host', 'logs'))).map(r => r.msg);
	for (const m of ['core ran', 'line ran']) assert.ok(msgs.includes(m), m);
});

test('without YENA_DATA the log stays in the root', async () => {
	const home = await makeHome(OK_CORE);
	const r = runCli(home, {YENA_DATA: undefined});
	assert.equal(r.status, 0, r.stderr);
	assert.ok((await records(home, path.join(home, 'logs'))).some(x => x.msg === 'core ran'));
});
