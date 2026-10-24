import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src/cli.ts');

async function makeHome(headlessSource: string | null, manifestExtra: Record<string, unknown> = {headless: 'headless.mjs'}) {
	const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-run-')));
	const dir = path.join(home, 'modules', 'core');
	await mkdir(dir, {recursive: true});
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name: 'core', version: '1.0.0', runtime: 'node', entry: 'index.mjs', ...manifestExtra}));
	await writeFile(path.join(dir, 'index.mjs'), 'export default () => { throw new Error("UI must not load"); };');
	if (headlessSource !== null) await writeFile(path.join(dir, 'headless.mjs'), headlessSource);
	return home;
}

function run(home: string, args: string[]) {
	const env: NodeJS.ProcessEnv = {...process.env, YENA_HOME: home, YENA_DATA: path.join(home, 'data'), YENA_LOG: 'off'};
	const r = spawnSync(process.execPath, ['--import', 'tsx', cli, '--run', '--', ...args], {env, encoding: 'utf8', cwd: repo, timeout: 60_000});
	return {status: r.status, stdout: r.stdout, stderr: r.stderr};
}

test('prints the command output and exits 0, passing the words', async () => {
	const home = await makeHome(`export default async (yena, req) => { console.log('ran ' + req.args.join('|') + ' ' + yena.commands.some(c => c.name === 'mod')); };`);
	const r = run(home, ['mod', 'list']);
	assert.equal(r.status, 0);
	assert.equal(r.stdout, 'ran mod|list true\n');
});

test('an error exits 1 with a sanitized Error line', async () => {
	const home = await makeHome(`export default async () => { throw new Error('bad \\u001b[31mred\\u001b[0m\\u0007 end'); };`);
	const r = run(home, ['x']);
	assert.equal(r.status, 1);
	assert.equal(r.stderr, 'Error: bad red end\n');
});

test('exitCode 2 is passed through, long messages are capped at 21 lines', async () => {
	const home = await makeHome(`export default async () => { throw Object.assign(new Error(Array.from({length: 40}, (_, i) => 'l' + i).join('\\n')), {exitCode: 2}); };`);
	const r = run(home, ['x']);
	assert.equal(r.status, 2);
	assert.equal(r.stderr.trimEnd().split('\n').length, 21);
});

test('a core without headless fails with a clear error', async () => {
	const home = await makeHome(null, {});
	const r = run(home, ['x']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /core 1\.0\.0 cannot run commands from the terminal; update it with: mod update core/);
});

test('a headless path outside the module is rejected', async () => {
	const home = await makeHome(null, {headless: '../escape.mjs'});
	await writeFile(path.join(home, 'modules', 'escape.mjs'), 'export default async () => {};');
	const r = run(home, ['x']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /"headless" points outside the module/);
});

test('the process exits although a plugin leaves an interval running', async () => {
	const home = await makeHome('export default async () => { console.log("done"); };');
	const dir = path.join(home, 'modules', 'ticker');
	await mkdir(dir, {recursive: true});
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name: 'ticker', version: '0.1.0', runtime: 'node', entry: 'index.mjs'}));
	await writeFile(path.join(dir, 'index.mjs'), 'export default () => { setInterval(() => {}, 1000); return []; };');
	const r = run(home, ['x']);
	assert.equal(r.status, 0);
	assert.equal(r.stdout, 'done\n');
});

function runCatalog(home: string, args: string[] = []) {
	const env: NodeJS.ProcessEnv = {...process.env, YENA_HOME: home, YENA_DATA: path.join(home, 'data'), YENA_LOG: 'off'};
	const r = spawnSync(process.execPath, ['--import', 'tsx', cli, '--catalog', ...args], {env, encoding: 'utf8', cwd: repo, timeout: 60_000});
	return {status: r.status, stdout: r.stdout, stderr: r.stderr};
}

test('--catalog asks the headless entry for the catalog and exits 0', async () => {
	const home = await makeHome(`export default async (yena, req) => { console.log(JSON.stringify(req)); };`);
	const r = runCatalog(home);
	assert.equal(r.status, 0);
	assert.equal(r.stdout, '{"args":[],"catalog":true}\n');
});

test('--catalog with extra arguments exits 2', async () => {
	const home = await makeHome(`export default async () => { console.log('ran'); };`);
	const r = runCatalog(home, ['x']);
	assert.equal(r.status, 2);
	assert.equal(r.stdout, '');
});

test('--catalog without core exits 1 and does not install', async () => {
	const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-run-')));
	const r = runCatalog(home);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /core is not installed/);
	assert.doesNotMatch(r.stderr, /downloading/);
	assert.equal(r.stdout, '');
});
