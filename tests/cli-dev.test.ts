import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src/cli.ts');
const temp = async (prefix: string) => realpath(await mkdtemp(path.join(tmpdir(), prefix)));

async function core(dir: string, files: {headless?: string; entry?: string}) {
	await mkdir(dir, {recursive: true});
	await writeFile(
		path.join(dir, 'yena.json'),
		JSON.stringify({name: 'core', version: '1.0.0', runtime: 'node', entry: 'index.mjs', ...(files.headless !== undefined && {headless: 'headless.mjs'})}),
	);
	await writeFile(path.join(dir, 'index.mjs'), files.entry ?? 'export default () => {};');
	if (files.headless !== undefined) await writeFile(path.join(dir, 'headless.mjs'), files.headless);
}

const IMAGE_HEADLESS = `export default async (yena, req) => { console.log('image ran ' + req.args.join(' ')); };`;
const DEV_HEADLESS = `export default async (yena, req) => {
	console.log('dev ran ' + req.args.join(' ') + ' home=' + process.env.YENA_HOME + ' cwd=' + process.cwd() + ' child=' + process.env.YENA_DEV_CHILD);
};`;

/** An image root, a data dir in dev mode, and a dev root that runs this repo's host with its own core. */
async function setup(dev: {headless?: string; entry?: string}) {
	const home = await temp('yena-img-');
	const data = await temp('yena-data-');
	const devRoot = await temp('yena-devroot-');
	await core(path.join(home, 'modules', 'core'), {headless: IMAGE_HEADLESS, entry: `export default () => { console.log('image ui'); };`});
	await symlink(path.join(repo, 'src'), path.join(devRoot, 'src'));
	await symlink(path.join(repo, 'node_modules'), path.join(devRoot, 'node_modules'));
	await core(path.join(devRoot, 'modules', 'core'), dev);
	await mkdir(path.join(data, 'host'), {recursive: true});
	await writeFile(path.join(data, 'host', 'mode.json'), JSON.stringify({mode: 'dev', devRoot}));
	return {home, data, devRoot};
}

function run(s: {home: string; data: string}, args: string[], extra: Record<string, string> = {}) {
	const env: NodeJS.ProcessEnv = {...process.env, YENA_HOME: s.home, YENA_DATA: s.data, YENA_LOG: 'off', ...extra};
	delete env.YENA_STABLE;
	delete env.YENA_DEV_CHILD;
	Object.assign(env, extra);
	const r = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {env, encoding: 'utf8', cwd: repo, timeout: 60_000});
	return {status: r.status, stdout: r.stdout, stderr: r.stderr};
}
const failure = async (data: string) => JSON.parse(await readFile(path.join(data, 'host', 'dev-failure.json'), 'utf8')) as {message: string; devRoot: string};

test('dev mode runs the line in the dev root (its home, cwd and modules), not the image or the overlay', async () => {
	const s = await setup({headless: DEV_HEADLESS});
	await core(path.join(s.data, 'host', 'modules', 'core'), {headless: `export default async () => { console.log('overlay'); };`});
	await mkdir(path.join(s.data, 'host'), {recursive: true});
	await writeFile(path.join(s.data, 'host', 'dev-failure.json'), JSON.stringify({name: 'Old', message: 'old'}));
	const r = run(s, ['--run', '--', 'a', 'b']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, `dev ran a b home=${s.devRoot} cwd=${s.devRoot} child=1\n`);
	assert.equal(r.stderr, '');
	assert.ok(!existsSync(path.join(s.data, 'host', 'dev-failure.json')), 'a successful dev start clears the old failure');
});

test('the UI start is ready once core main returns, and the run ends with the child', async () => {
	const s = await setup({entry: `export default () => { console.log('dev ui ' + process.env.YENA_DEV_CHILD); };`});
	const r = run(s, []);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, 'dev ui 1\n');
});

test('an error before ready falls back to the image with a warning and a record', async () => {
	const s = await setup({});
	const r = run(s, ['--run', '--', 'x']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, 'image ran x\n');
	assert.match(r.stderr, /Error: core 1\.0\.0 cannot run commands from the terminal/);
	assert.match(r.stderr, new RegExp(`Warning: dev mode: ${s.devRoot} failed to start \\(core 1\\.0\\.0 cannot run commands from the terminal.*\\); running the image`));
	const rec = await failure(s.data);
	assert.equal(rec.devRoot, s.devRoot);
	assert.match(rec.message, /cannot run commands from the terminal/);
});

test('a child that exits early without a record gets one from the launcher', async () => {
	const s = await setup({headless: 'process.exit(5);'});
	const r = run(s, ['--run', '--', 'x']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, 'image ran x\n');
	assert.equal((await failure(s.data)).message, 'exited with code 5 before it was ready');
});

test('a child that never gets ready is stopped after the timeout', async () => {
	const s = await setup({headless: 'setInterval(() => {}, 1000); await new Promise(() => {});'});
	const r = run(s, ['--run', '--', 'x'], {YENA_DEV_READY_MS: '1500'});
	assert.equal(r.stdout, 'image ran x\n');
	assert.equal((await failure(s.data)).message, 'did not get ready within 1500 ms');
});

test('a crash after ready is a crash: no fallback, the child status is kept', async () => {
	const s = await setup({headless: `export default async () => { throw new Error('late boom'); };`});
	const r = run(s, ['--run', '--', 'x']);
	assert.equal(r.status, 1);
	assert.equal(r.stdout, '');
	assert.equal(r.stderr, 'Error: late boom\n');
	assert.ok(!existsSync(path.join(s.data, 'host', 'dev-failure.json')));
});

test('a signal to the launcher before ready stops the run: no fallback, no record', async () => {
	const s = await setup({headless: DEV_HEADLESS});
	const slow = path.join(s.devRoot, 'modules', 'slow');
	await mkdir(slow, {recursive: true});
	await writeFile(path.join(slow, 'yena.json'), JSON.stringify({name: 'slow', version: '1.0.0', runtime: 'node', entry: 'index.mjs'}));
	await writeFile(path.join(slow, 'index.mjs'), `export default async () => { console.log('plugin up'); setInterval(() => {}, 1000); await new Promise(() => {}); };`);
	const env: NodeJS.ProcessEnv = {...process.env, YENA_HOME: s.home, YENA_DATA: s.data, YENA_LOG: 'off'};
	delete env.YENA_STABLE;
	delete env.YENA_DEV_CHILD;
	const launcher = spawn(process.execPath, ['--import', 'tsx', cli, '--run', '--', 'x'], {env, cwd: repo, stdio: ['ignore', 'pipe', 'pipe']});
	let stdout = '';
	launcher.stdout.on('data', chunk => {
		stdout += String(chunk);
		if (stdout.includes('plugin up')) launcher.kill('SIGTERM');
	});
	const [code, signal] = (await once(launcher, 'exit')) as [number | null, NodeJS.Signals | null];
	assert.deepEqual({code, signal}, {code: 143, signal: null});
	assert.equal(stdout, 'plugin up\n');
	assert.ok(!existsSync(path.join(s.data, 'host', 'dev-failure.json')));
});

test('a yena started from inside the dev run is not the dev child: its early failure leaves no record', async () => {
	const s = await setup({
		headless: `import {spawnSync} from 'node:child_process';
export default async () => {
	const r = spawnSync(process.execPath, ['--import', 'tsx', ${JSON.stringify(cli)}, '--catalog', 'extra'], {encoding: 'utf8'});
	console.log('inner ' + r.status + ' child=' + process.env.YENA_DEV_CHILD);
};`,
	});
	const r = run(s, ['--run', '--', 'x']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, 'inner 2 child=1\n');
	assert.ok(!existsSync(path.join(s.data, 'host', 'dev-failure.json')));
});

test('YENA_STABLE starts the image whatever the mode says', async () => {
	const s = await setup({headless: DEV_HEADLESS});
	const r = run(s, ['--run', '--', 'x'], {YENA_STABLE: '1'});
	assert.equal(r.stdout, 'image ran x\n');
});

test('after a fallback the image core gets the alert and plugins can read the record', async () => {
	const s = await setup({entry: `export default () => { throw new Error('dev core broke'); };`});
	await core(path.join(s.home, 'modules', 'core'), {
		headless: IMAGE_HEADLESS,
		entry: `export default yena => { console.log('alerts ' + JSON.stringify(yena.alerts)); };`,
	});
	const probe = path.join(s.home, 'modules', 'probe');
	await mkdir(probe, {recursive: true});
	await writeFile(path.join(probe, 'yena.json'), JSON.stringify({name: 'probe', version: '1.0.0', runtime: 'node', entry: 'index.mjs'}));
	await writeFile(path.join(probe, 'index.mjs'), `export default async host => { const f = await host.devFailure(); console.log('record ' + f.message + ' ' + ('pid' in f)); return []; };`);
	const r = run(s, []);
	assert.equal(r.status, 0, r.stderr);
	const lines = r.stdout.trim().split('\n');
	assert.equal(lines[0], 'record dev core broke false');
	const alerts = JSON.parse(lines[1]!.slice('alerts '.length)) as {text: string; detail: string}[];
	assert.deepEqual(alerts, [{text: `Dev mode: ${s.devRoot} failed to start, running the image. Run fix to repair it.`, detail: 'dev core broke'}]);
});
