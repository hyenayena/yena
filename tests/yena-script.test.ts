import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chmod, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../yena', import.meta.url));
const END = '--end--';
const EXEC_PREFIX = ['exec', '-e', 'YENA_LOG_LEVEL', '-e', 'YENA_LOG', '-i', 'yena'];
const PS = ['ps', '-q', '--filter', 'name=^yena$'];
const UP = ['compose', 'up', '-d'];

const STUB = `#!/bin/sh
{
	printf 'cwd=%s\\n' "$(pwd -P)"
	for a in "$@"; do printf '%s\\n' "$a"; done
	printf '%s\\n' '${END}'
} >> "$STUB_LOG"
if [ "$1" = ps ] && [ -n "\${STUB_PS-}" ]; then printf '%s\\n' "$STUB_PS"; fi
if [ -n "\${STUB_EXIT-}" ]; then
	for a in "$@"; do
		if [ "$a" = "\${STUB_FAIL_ON-}" ]; then exit "$STUB_EXIT"; fi
	done
fi
exit 0
`;

type Call = {cwd: string; args: string[]};

async function makeFixture(opts: {claude?: boolean; name?: string} = {}) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-script-')));
	const dir = path.join(root, opts.name ?? 'repo');
	const bin = path.join(root, 'bin');
	await mkdir(dir);
	await mkdir(bin);
	await copyFile(script, path.join(dir, 'yena'));
	await chmod(path.join(dir, 'yena'), 0o755);
	await writeFile(path.join(bin, 'docker'), STUB);
	await chmod(path.join(bin, 'docker'), 0o755);
	if (opts.claude) {
		const claudeBin = path.join(dir, 'modules', 'claude', 'bin');
		await mkdir(claudeBin, {recursive: true});
		await writeFile(path.join(claudeBin, 'claude'), '#!/bin/sh\nexit 0\n');
		await chmod(path.join(claudeBin, 'claude'), 0o755);
	}
	const elsewhere = await mkdtemp(path.join(tmpdir(), 'yena-cwd-'));
	const log = path.join(root, 'docker.log');
	await writeFile(log, '');
	return {dir, bin, elsewhere, log};
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

function runAs(fx: Fixture, file: string, argv: string[], cwd: string, extra: Record<string, string> = {}, pathVar?: string) {
	const env: NodeJS.ProcessEnv = {...process.env, STUB_LOG: fx.log, STUB_PS: 'abc'};
	delete env.NO_COLOR;
	delete env.STUB_EXIT;
	delete env.STUB_FAIL_ON;
	Object.assign(env, extra);
	env.PATH = pathVar ?? `${fx.bin}:${process.env.PATH ?? ''}`;
	const r = spawnSync(file, argv, {cwd, env, encoding: 'utf8', timeout: 30_000});
	return {status: r.status, stdout: r.stdout, stderr: r.stderr};
}

function run(fx: Fixture, args: string[], extra: Record<string, string> = {}, pathVar?: string) {
	return runAs(fx, '/bin/sh', [path.join(fx.dir, 'yena'), ...args], fx.elsewhere, extra, pathVar);
}

async function calls(fx: Fixture): Promise<Call[]> {
	const text = await readFile(fx.log, 'utf8');
	return text
		.split(`${END}\n`)
		.filter(Boolean)
		.map(chunk => {
			const lines = chunk.slice(0, -1).split('\n');
			return {cwd: lines[0]!.replace(/^cwd=/, ''), args: lines.slice(1)};
		});
}

const argsOf = async (fx: Fixture) => (await calls(fx)).map(c => c.args);

// 'npm run test' and 'npm test' run the same script
const sameScript = (args: string[][]) => args.map(a => (a.slice(-3).join(' ') === 'npm run test' ? [...a.slice(0, -3), 'npm', 'test'] : a));

test('the script passes a POSIX sh syntax check', () => {
	const r = spawnSync('/bin/sh', ['-n', script], {encoding: 'utf8'});
	assert.equal(r.status, 0, r.stderr);
});

test('no arguments with a running container: one exec of npm run dev from the script dir', async () => {
	const fx = await makeFixture();
	const r = run(fx, []);
	assert.equal(r.status, 0, r.stderr);
	const all = await calls(fx);
	assert.deepEqual(all.map(c => c.args), [PS, [...EXEC_PREFIX, 'npm', 'run', 'dev']]);
	for (const c of all) assert.equal(c.cwd, fx.dir);
	assert.ok(!all.some(c => c.args.includes('-t')));
});

test('a stopped container is started before the exec', async () => {
	const fx = await makeFixture();
	const r = run(fx, [], {STUB_PS: ''});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(await argsOf(fx), [PS, UP, [...EXEC_PREFIX, 'npm', 'run', 'dev']]);
});

const COMPOSE: [string, string[]][] = [
	['up', ['compose', 'up', '-d']],
	['down', ['compose', 'down']],
	['restart', ['compose', 'restart']],
	['build', ['compose', 'build']],
	['rebuild', ['compose', 'up', '-d', '--force-recreate']],
	['ps', ['compose', 'ps']],
	['logs', ['compose', 'logs', '-f']],
];

for (const [cmd, expected] of COMPOSE) {
	test(`${cmd} runs docker ${expected.join(' ')}`, async () => {
		const fx = await makeFixture();
		const r = run(fx, [cmd]);
		assert.equal(r.status, 0, r.stderr);
		const all = await calls(fx);
		assert.deepEqual(all.map(c => c.args), [expected]);
		assert.equal(all[0]!.cwd, fx.dir);
	});
}

const EXEC: [string, string[]][] = [
	['yena', ['npm', 'run', 'dev']],
	['start', ['npm', 'start']],
	['sh', ['sh']],
	['install', ['npm', 'install']],
	['typecheck', ['npm', 'run', 'typecheck']],
	['test', ['npm', 'test']],
	['typecheck-modules', ['npm', 'run', 'typecheck:modules']],
	['test-modules', ['npm', 'run', 'test:modules']],
	['compile', ['npm', 'run', 'build']],
];

for (const [cmd, expected] of EXEC) {
	test(`${cmd} execs ${expected.join(' ')} in the container`, async () => {
		const fx = await makeFixture();
		const r = run(fx, [cmd]);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(await argsOf(fx), [PS, [...EXEC_PREFIX, ...expected]]);
	});
}

test('check runs the steps in order and stops at the first failure', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['check'], {STUB_EXIT: '4', STUB_FAIL_ON: 'typecheck:modules'});
	assert.notEqual(r.status, 0);
	assert.deepEqual(sameScript(await argsOf(fx)), [
		PS,
		[...EXEC_PREFIX, 'npm', 'run', 'typecheck'],
		[...EXEC_PREFIX, 'npm', 'test'],
		[...EXEC_PREFIX, 'npm', 'run', 'typecheck:modules'],
	]);
});

test('check runs all four steps and checks the container once', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['check'], {STUB_PS: ''});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(sameScript(await argsOf(fx)), [
		PS,
		UP,
		[...EXEC_PREFIX, 'npm', 'run', 'typecheck'],
		[...EXEC_PREFIX, 'npm', 'test'],
		[...EXEC_PREFIX, 'npm', 'run', 'typecheck:modules'],
		[...EXEC_PREFIX, 'npm', 'run', 'test:modules'],
	]);
});

test('claude without the module: exit 1, install hint, no docker calls', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['claude']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /The claude module is not installed: mod install git@github\.com:hyenayena\/claude\.git/);
	assert.deepEqual(await calls(fx), []);
});

test('claude with the module passes its arguments unchanged', async () => {
	const fx = await makeFixture({claude: true});
	const r = run(fx, ['claude', '--resume', 'a b']);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(await argsOf(fx), [PS, [...EXEC_PREFIX, 'modules/claude/bin/claude', '--resume', 'a b']]);
});

test('an unknown command: exit 2, message and hint, no docker calls', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['bogus']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /Unknown command: bogus/);
	assert.match(r.stderr, /Run \.\/yena help for the list of commands\./);
	assert.deepEqual(await calls(fx), []);
});

test('extra arguments to a non-claude command: exit 2, no docker calls', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['test', '--foo']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /test takes no arguments/);
	assert.deepEqual(await calls(fx), []);
});

for (const flag of ['help', '-h', '--help']) {
	test(`${flag} lists every command without colour on a pipe`, async () => {
		const fx = await makeFixture();
		const r = run(fx, [flag]);
		assert.equal(r.status, 0, r.stderr);
		const names = [...COMPOSE, ...EXEC].map(([n]) => n).concat(['check', 'claude', 'help']);
		for (const n of names) assert.match(r.stdout, new RegExp(`(^|\\W)${n}(\\W|$)`, 'm'), n);
		assert.ok(!r.stdout.includes(String.fromCharCode(27)));
		assert.deepEqual(await calls(fx), []);
	});
}

test('docker exit status propagates from an exec', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['start'], {STUB_EXIT: '3', STUB_FAIL_ON: 'start'});
	assert.equal(r.status, 3);
});

test('docker exit status propagates from a compose command', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['down'], {STUB_EXIT: '3', STUB_FAIL_ON: 'down'});
	assert.equal(r.status, 3);
});

test('docker missing from PATH: exit 1 with the hint', {skip: ['/bin/docker', '/usr/bin/docker'].some(p => existsSync(p)) && 'docker is installed in /bin or /usr/bin'}, async () => {
	const fx = await makeFixture();
	const empty = await mkdtemp(path.join(tmpdir(), 'yena-path-'));
	const r = run(fx, ['up'], {}, `${empty}:/bin:/usr/bin`);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /docker not found\. Run \.\/yena on the host; inside the container use npm run <script>\./);
	assert.deepEqual(await calls(fx), []);
});

test('executed directly through its shebang from the repo dir', async () => {
	const fx = await makeFixture();
	const r = runAs(fx, './yena', ['ps'], fx.dir);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(await calls(fx), [{cwd: fx.dir, args: ['compose', 'ps']}]);
});

test('sh yena with a relative $0 resolves the script dir', async () => {
	const fx = await makeFixture();
	const r = runAs(fx, '/bin/sh', ['yena', 'ps'], fx.dir);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(await calls(fx), [{cwd: fx.dir, args: ['compose', 'ps']}]);
});

test('a repo path with spaces and a set CDPATH still runs from the script dir', async () => {
	const fx = await makeFixture({name: 'my repo'});
	const r = run(fx, ['ps'], {CDPATH: fx.elsewhere});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, '');
	assert.deepEqual(await calls(fx), [{cwd: fx.dir, args: ['compose', 'ps']}]);
});

test('runs the same under bash --posix', {skip: !existsSync('/bin/bash') && 'bash is not installed'}, async () => {
	const fx = await makeFixture();
	const r = runAs(fx, '/bin/bash', ['--posix', path.join(fx.dir, 'yena'), 'test'], fx.elsewhere, {STUB_PS: ''});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(await argsOf(fx), [PS, UP, [...EXEC_PREFIX, 'npm', 'test']]);
});

test('check exits with the exact status of the failing step', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['check'], {STUB_EXIT: '4', STUB_FAIL_ON: 'test:modules'});
	assert.equal(r.status, 4);
	assert.equal((await calls(fx)).length, 5);
});

test('a failing docker compose up stops before the exec with its status', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['typecheck'], {STUB_PS: '', STUB_EXIT: '5', STUB_FAIL_ON: 'up'});
	assert.equal(r.status, 5);
	assert.deepEqual(await argsOf(fx), [PS, UP]);
});

test('claude exit status propagates', async () => {
	const fx = await makeFixture({claude: true});
	const r = run(fx, ['claude', 'x'], {STUB_EXIT: '6', STUB_FAIL_ON: 'modules/claude/bin/claude'});
	assert.equal(r.status, 6);
});

test('claude with no arguments execs the binary alone', async () => {
	const fx = await makeFixture({claude: true});
	const r = run(fx, ['claude']);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(await argsOf(fx), [PS, [...EXEC_PREFIX, 'modules/claude/bin/claude']]);
});

test('a claude binary without the execute bit counts as not installed', async () => {
	const fx = await makeFixture({claude: true});
	await chmod(path.join(fx.dir, 'modules', 'claude', 'bin', 'claude'), 0o644);
	const r = run(fx, ['claude']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /The claude module is not installed/);
	assert.deepEqual(await calls(fx), []);
});

test('help with an argument is refused with exit 2', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['help', 'up']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /help takes no arguments/);
	assert.equal(r.stdout, '');
});

test('an unknown command with arguments reports the unknown command', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['bogus', 'x']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /Unknown command: bogus/);
	assert.doesNotMatch(r.stderr, /takes no arguments/);
});

test('errors go to stderr only', async () => {
	const fx = await makeFixture();
	for (const args of [['bogus'], ['up', 'x'], ['claude']]) {
		const r = run(fx, args);
		assert.equal(r.stdout, '', args.join(' '));
		assert.notEqual(r.stderr, '', args.join(' '));
	}
});

test('help works without docker on PATH', async () => {
	const fx = await makeFixture();
	const empty = await mkdtemp(path.join(tmpdir(), 'yena-path-'));
	const r = run(fx, ['help'], {}, `${empty}:/bin:/usr/bin`);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^Usage: \.\/yena/);
});
