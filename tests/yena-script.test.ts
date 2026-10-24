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
case " $* " in *" --catalog "*)
	if [ -n "\${STUB_CATALOG_SLEEP-}" ]; then exec sleep "$STUB_CATALOG_SLEEP"; fi
	if [ -n "\${STUB_CATALOG_FAIL-}" ]; then exit 1; fi
	printf '%s' "\${STUB_CATALOG-}"
	exit 0 ;;
esac
if [ "$1" = ps ] && [ -n "\${STUB_PS-}" ]; then printf '%s\\n' "$STUB_PS"; fi
case " $* " in *" npm "*) if [ -n "\${STUB_CLIP-}" ]; then printf '%s' "$STUB_CLIP" > .yena/.clipboard/.part; mv .yena/.clipboard/.part .yena/.clipboard/1.txt; sleep 1; fi ;; esac
if [ -n "\${STUB_EXIT-}" ]; then
	for a in "$@"; do
		if [ "$a" = "\${STUB_FAIL_ON-}" ]; then exit "$STUB_EXIT"; fi
	done
fi
exit 0
`;

type Call = {cwd: string; args: string[]};

const STOP = ['stop', 'mark'];

// Long interactive commands run in a wrapper that marks their pid, and the script stops what is still marked on exit.
const TRACKED = new Set(['yena', 'start', 'sh']);
function untrack(all: string[][]): string[][] {
	const out: string[][] = [];
	for (const args of all) {
		const at = args.indexOf('yena');
		if (args[0] === 'exec' && args[at + 1] === 'sh' && args[at + 2] === '-c' && /echo \$\$ > "\$0"/.test(args[at + 3] ?? '')) {
			assert.match(args[at + 4] ?? '', /^\/tmp\/yena-exec\/\d+\.\d+$/);
			out.push([...args.slice(0, at + 1), ...args.slice(at + 5)]);
		} else if (args[0] === 'exec' && args[1] === 'yena' && args[2] === 'sh' && /kill -HUP -"\$p"/.test(args[4] ?? '')) {
			out.push(STOP);
		} else out.push(args);
	}
	return out;
}


const DEFAULT_CATALOG = 'mod\tManage modules\nmod list\tList modules\nmod install\tInstall a module\nscheduler\tSchedule lines\nclaude\tClaude chat\nclaude sessions\tList sessions\n';

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
	delete env.YENA_HINTS;
	delete env.YENA_COMPLETION;
	delete env.STUB_EXIT;
	delete env.STUB_FAIL_ON;
	delete env.STUB_CATALOG_FAIL;
	delete env.STUB_CATALOG_SLEEP;
	env.STUB_CATALOG = DEFAULT_CATALOG;
	// The host's copy command (pbcopy) is used only by the tests that ask for it.
	env.YENA_CLIPBOARD = 'off';
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

const withoutCatalog = async (fx: Fixture) => (await calls(fx)).filter(c => !c.args.includes('--catalog'));
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
	assert.deepEqual(untrack(all.map(c => c.args)), [PS, [...EXEC_PREFIX, 'npm', 'run', 'dev'], STOP]);
	for (const c of all) assert.equal(c.cwd, fx.dir);
	assert.ok(!all.some(c => c.args.includes('-t')));
});

test('a stopped container is started before the exec', async () => {
	const fx = await makeFixture();
	const r = run(fx, [], {STUB_PS: ''});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(untrack(await argsOf(fx)), [PS, UP, [...EXEC_PREFIX, 'npm', 'run', 'dev'], STOP]);
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
	['compile', ['npm', 'run', 'build']],
];

for (const [cmd, expected] of EXEC) {
	test(`${cmd} execs ${expected.join(' ')} in the container`, async () => {
		const fx = await makeFixture();
		const r = run(fx, [cmd]);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(untrack(await argsOf(fx)), [PS, [...EXEC_PREFIX, ...expected], ...(TRACKED.has(cmd) ? [STOP] : [])]);
	});
}

test('a tracked command stops its marked process group with the same mark it started with', async () => {
	const fx = await makeFixture();
	assert.equal(run(fx, ['yena']).status, 0);
	const all = await argsOf(fx);
	const start = all[1]!;
	const stop = all[2]!;
	assert.equal(stop[5], start[start.indexOf('yena') + 4], 'the stop call names the started mark');
	assert.deepEqual(stop.slice(0, 4), ['exec', 'yena', 'sh', '-c']);
});

test('yena hands text the app copies to the host clipboard and stops watching at exit', async () => {
	const fx = await makeFixture();
	const clipLog = path.join(fx.bin, 'clip.log');
	await writeFile(path.join(fx.bin, 'pbcopy'), `#!/bin/sh\ncat >> '${clipLog}'\n`);
	await chmod(path.join(fx.bin, 'pbcopy'), 0o755);
	const r = run(fx, ['yena'], {YENA_CLIPBOARD: '', STUB_CLIP: 'copied text'});
	assert.equal(r.status, 0, r.stderr);
	const exec = (await argsOf(fx))[1]!;
	assert.deepEqual(exec.slice(0, 7), ['exec', '-e', 'YENA_LOG_LEVEL', '-e', 'YENA_LOG', '-e', 'YENA_CLIPBOARD_DIR=/data/.clipboard']);
	assert.equal(await readFile(clipLog, 'utf8'), 'copied text');
	assert.equal(existsSync(path.join(fx.dir, '.yena', '.clipboard', '1.txt')), false, 'the file is deleted once copied');
	// Without a copy command nothing is passed to the app.
	const plain = await makeFixture();
	assert.equal(run(plain, ['yena']).status, 0);
	assert.equal((await argsOf(plain))[1]!.includes('YENA_CLIPBOARD_DIR=/data/.clipboard'), false);
});

test('check and claude-code are forwarded as console lines', async () => {
	for (const word of ['check', 'claude-code']) {
		const fx = await makeFixture();
		const r = unk(fx, word);
		assert.equal(r.status, 2, word);
		assert.doesNotMatch(r.stderr, /Did you mean/, word);
		const all = await argsOf(fx);
		assert.deepEqual(untrack(all)[1]!.slice(-4), ['src/cli.ts', '--run', '--', word], word);
	}
});

test('lint suggests no removed command', async () => {
	const fx = await makeFixture();
	const r = unk(fx, 'lint');
	assert.equal(r.status, 2);
	assert.doesNotMatch(r.stderr, /Did you mean the script command/);
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
		const names = [...COMPOSE, ...EXEC].map(([n]) => n).concat(['help', 'kill']);
		for (const n of names) assert.match(r.stdout, new RegExp(`(^|\\W)${n}(\\W|$)`, 'm'), n);
		assert.ok(!r.stdout.includes(String.fromCharCode(27)));
		assert.deepEqual(await withoutCatalog(fx), []);
	});
}

test('kill stops the app and runner processes inside a running container', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['kill']);
	assert.equal(r.status, 0, r.stderr);
	const all = await argsOf(fx);
	assert.equal(all.length, 2);
	assert.deepEqual(all[0], PS);
	assert.deepEqual(all[1]!.slice(0, 4), ['exec', 'yena', 'sh', '-c']);
	const body = all[1]![4]!;
	assert.match(body, /pkill -TERM -f -- "\$pat"/);
	assert.match(body, /pkill -KILL -f -- "\$pat"/);
	assert.match(body, /\[s\]rc\/cli\\\.ts\|\[r\]unner\/main\\\.ts/, 'bracketed so the pattern never matches its own shell');
	assert.match(body, /rm -rf \/tmp\/yena-exec/);
});

test('kill with a stopped container does nothing and says so', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['kill'], {STUB_PS: ''});
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /The container is not running; nothing to stop\./);
	assert.deepEqual(await argsOf(fx), [PS]);
});

test('kill takes no arguments', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['kill', 'x']);
	assert.equal(r.status, 2);
	assert.deepEqual(await argsOf(fx), []);
});

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

test('a failing docker compose up stops before the exec with its status', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['typecheck'], {STUB_PS: '', STUB_EXIT: '5', STUB_FAIL_ON: 'up'});
	assert.equal(r.status, 5);
	assert.deepEqual(await argsOf(fx), [PS, UP]);
});

test('help with an argument is refused with exit 2', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['help', 'up']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /help takes no arguments/);
	assert.equal(r.stdout, '');
});

test('errors go to stderr only', async () => {
	const fx = await makeFixture();
	for (const args of [['up', 'x'], ['test', 'x']]) {
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

const ESC = String.fromCharCode(27);
const hints = (stderr: string) => stderr.split('\n').filter(l => l.startsWith('hint: '));

for (const cmd of ['up', 'down', 'restart', 'build', 'rebuild', 'install', 'compile']) {
	test(`${cmd} prints a hint on stderr and nothing extra on stdout`, async () => {
		const fx = await makeFixture();
		const r = run(fx, [cmd]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(hints(r.stderr).length, 1, r.stderr);
		assert.equal(r.stdout, '');
	});
}

test('ps and logs print no hint', async () => {
	const fx = await makeFixture();
	for (const cmd of ['ps', 'logs']) assert.equal(run(fx, [cmd]).stderr, '', cmd);
});

test('YENA_HINTS=off silences the hints', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['up'], {YENA_HINTS: 'off'});
	assert.equal(r.status, 0);
	assert.equal(r.stderr, '');
});

test('hints carry no escape bytes on a pipe or with NO_COLOR', async () => {
	const fx = await makeFixture();
	for (const extra of [{}, {NO_COLOR: '1'}] as Record<string, string>[]) {
		const r = run(fx, ['up'], extra);
		assert.match(r.stderr, /^hint: /);
		assert.ok(!r.stderr.includes(ESC));
	}
});

test('a failing down keeps its status and prints no success hint', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['down'], {STUB_EXIT: '3', STUB_FAIL_ON: 'down'});
	assert.equal(r.status, 3);
	assert.equal(r.stderr, '');
});

test('a failing typecheck keeps its status and names the status in the hint', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['typecheck'], {STUB_EXIT: '3', STUB_FAIL_ON: 'typecheck'});
	assert.equal(r.status, 3);
	assert.match(r.stderr, /hint: typecheck failed \(exit 3\)\.$/m);
});

test('a status of 128 or more prints no hint', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['test'], {STUB_EXIT: '130', STUB_FAIL_ON: 'test'});
	assert.equal(r.status, 130);
	assert.equal(r.stderr, '');
});

// What the app does for an unknown word: exit 2 (the stub fails on the word itself).
const unk = (fx: Fixture, word: string, extra: Record<string, string> = {}) => run(fx, [word], {STUB_EXIT: '2', STUB_FAIL_ON: word, ...extra});

test('a forwarded word that the app rejects with exit 2 also gets script suggestions', async () => {
	const fx = await makeFixture();
	for (const [input, expected] of [['tset', 'test'], ['stop', 'down'], ['stat', 'start'], ['status', 'ps']] as const) {
		const r = unk(fx, input);
		assert.equal(r.status, 2, input);
		assert.match(r.stderr, new RegExp(`Did you mean the script command: .*\\./yena ${expected}`), input);
	}
	const far = unk(fx, 'zzzzzzz');
	assert.equal(far.status, 2);
	assert.doesNotMatch(far.stderr, /Did you mean/);
});

test('suggestions are printed even with YENA_HINTS=off', async () => {
	const fx = await makeFixture();
	assert.match(unk(fx, 'tset', {YENA_HINTS: 'off'}).stderr, /Did you mean the script command/);
});

test('an unknown command with shell metacharacters is not interpreted', async () => {
	const fx = await makeFixture();
	const r = unk(fx, "$(touch pwned)'\"; x");
	assert.equal(r.status, 2);
	assert.equal(existsSync(path.join(fx.dir, 'pwned')), false);
	assert.doesNotMatch(r.stderr, /Did you mean/);
});

test('the no-arguments refusal says which command takes arguments', async () => {
	const fx = await makeFixture();
	assert.match(run(fx, ['test', 'x']).stderr, /Arguments go to console commands: \.\/yena console <words>\./);
});

test('help lists the environment variables without colour on a pipe', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['help']);
	for (const v of ['YENA_LOG_LEVEL', 'YENA_LOG=', 'YENA_CLIPBOARD=off', 'NO_COLOR', 'YENA_HINTS=off', 'npm run logs']) {
		assert.ok(r.stdout.includes(v), v);
	}
	assert.ok(!r.stdout.includes(ESC));
	assert.ok(!r.stdout.includes('|'), 'a table cell holds the column separator');
});

test('a stopped container is announced before it starts', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['sh'], {STUB_PS: ''});
	assert.match(r.stderr, /hint: The container is not running; starting it/);
});

test('a failing compose up explains and exits with its status', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['typecheck'], {STUB_PS: '', STUB_EXIT: '5', STUB_FAIL_ON: 'up'});
	assert.equal(r.status, 5);
	assert.match(r.stderr, /Could not start the container \(exit 5\)\. Is Docker running\?/);
});

test('an app that exits with an error gets a debug hint', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['yena'], {STUB_EXIT: '2', STUB_FAIL_ON: 'dev'});
	assert.equal(r.status, 2);
	assert.match(r.stderr, /The app exited with status 2\. Debug: YENA_LOG_LEVEL=debug \.\/yena/);
});

test('hints work under bash --posix', {skip: !existsSync('/bin/bash') && 'bash is not installed'}, async () => {
	const fx = await makeFixture();
	const r = runAs(fx, '/bin/bash', ['--posix', path.join(fx.dir, 'yena'), 'install'], fx.elsewhere);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /Dependencies installed\. \.\/yena typecheck and \.\/yena test check the host\./);
	assert.equal(unk(fx, 'tset').stderr.includes('Did you mean the script command'), true);
});

test('an unknown command with printf conversions and backslashes is echoed literally', async () => {
	const fx = await makeFixture();
	const r = unk(fx, '%s%d%n\\n');
	assert.equal(r.status, 2);
	assert.equal(r.stdout, '');
	assert.doesNotMatch(r.stderr, /Did you mean/);
	assert.match(unk(fx, 'tes\\t').stderr, /Did you mean the script command: \.\/yena test\?/);
});

test('an unknown command longer than 32 characters gets no suggestion', async () => {
	const fx = await makeFixture();
	const r = unk(fx, 't'.repeat(33));
	assert.equal(r.status, 2);
	assert.doesNotMatch(r.stderr, /Did you mean/);
});

test('signal statuses print no hint in the app and exec commands', async () => {
	const fx = await makeFixture();
	for (const status of ['130', '143']) {
		for (const [args, failOn] of [[['yena'], 'dev'], [['start'], 'start'], [['typecheck'], 'typecheck']] as const) {
			const r = run(fx, [...args], {STUB_EXIT: status, STUB_FAIL_ON: failOn});
			assert.equal(r.status, Number(status), args.join(' '));
			assert.equal(r.stderr, '', args.join(' '));
			assert.equal(r.stdout, '', args.join(' '));
		}
	}
});

test('stdout stays empty for every hinted success and failure', async () => {
	const fx = await makeFixture();
	for (const cmd of ['up', 'down', 'restart', 'build', 'rebuild', 'install', 'compile', 'typecheck', 'test']) {
		const r = run(fx, [cmd]);
		assert.equal(r.stdout, '', cmd);
		if (cmd !== 'typecheck' && cmd !== 'test') assert.match(r.stderr, /^hint: /, cmd);
	}
	const bad = run(fx, ['test'], {STUB_EXIT: '1', STUB_FAIL_ON: 'test'});
	assert.equal(bad.stdout, '');
	assert.equal(bad.status, 1);
});

test('hints and failures behave the same under busybox sh', {skip: !existsSync('/bin/busybox') && 'busybox is not installed'}, async () => {
	const fx = await makeFixture();
	const sh = (args: string[], extra: Record<string, string> = {}) => runAs(fx, '/bin/busybox', ['sh', path.join(fx.dir, 'yena'), ...args], fx.elsewhere, extra);
	assert.match(sh(['tset'], {STUB_EXIT: '2', STUB_FAIL_ON: 'tset'}).stderr, /Did you mean the script command: \.\/yena test\?/);
	assert.match(sh(['help']).stdout, /Console commands\n {2}mod /);
	assert.equal(sh(['__commands']).stdout.split('\n')[0], 'mod\tManage modules');
	const r = sh(['test'], {STUB_EXIT: '4', STUB_FAIL_ON: 'test'});
	assert.equal(r.status, 4);
	assert.match(r.stderr, /hint: test failed \(exit 4\)\./);
});

test('completion prints a script without docker, listing every help command', async () => {
	const fx = await makeFixture();
	const empty = await mkdtemp(path.join(tmpdir(), 'yena-path-'));
	const r = run(fx, ['completion'], {}, `${empty}:/bin:/usr/bin`);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stderr, '');
	for (const name of ['help', 'completion']) assert.match(r.stdout, new RegExp(`'${name}:`));
	for (const name of ['check', 'test-modules', 'typecheck-modules', 'claude-code']) assert.doesNotMatch(r.stdout, new RegExp(`'${name}:`));
	assert.equal(run(fx, ['completion', 'zsh']).status, 2);
	assert.deepEqual(await argsOf(fx), []);
});

test('help ends with the line that loads the completion while it is off in the shell', async () => {
	const fx = await makeFixture();
	const off = run(fx, ['help']).stdout;
	assert.match(off, /Tab completion is off in this shell/);
	assert.ok(off.includes(`eval "$('${fx.dir}/yena' completion)"`));
	const on = run(fx, ['help'], {YENA_COMPLETION: 'on'}).stdout;
	assert.match(on, /Tab completion: on in this shell\.\n$/);
	assert.ok(!on.includes('completion)"'));
});

const stubEnv = (fx: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({...process.env, STUB_LOG: fx.log, STUB_PS: 'abc', STUB_CATALOG: DEFAULT_CATALOG, PATH: `${fx.bin}:${process.env.PATH ?? ''}`, ...extra});

const hasShell = (name: string) => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;

test('the loaded completion marks the shell, so help sees it', {skip: !hasShell('bash')}, async () => {
	const fx = await makeFixture();
	const r = spawnSync('bash', ['--norc', '-c', `eval "$(sh '${fx.dir}/yena' completion)"; sh '${fx.dir}/yena' help | tail -n 1`], {encoding: 'utf8'});
	assert.equal(r.stdout.trim(), 'Tab completion: on in this shell.');
});

test('bash completes command names after ./yena', {skip: !hasShell('bash')}, async () => {
	const fx = await makeFixture();
	const probe = `eval "$(sh '${fx.dir}/yena' completion)"; for w in te comp; do COMP_WORDS=(./yena "$w"); COMP_CWORD=1; _yena; echo "\${COMPREPLY[*]}"; done; COMP_WORDS=(./yena claude code x); COMP_CWORD=3; _yena; echo "[\${COMPREPLY[*]}]"`;
	const r = spawnSync('bash', ['--norc', '-c', probe], {encoding: 'utf8', env: stubEnv(fx)});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(r.stdout.trim().split('\n'), ['test', 'compile completion', '[]']);
});

test('zsh registers the completion for yena and ./yena', {skip: !hasShell('zsh')}, async () => {
	const fx = await makeFixture();
	const probe = `eval "$(sh '${fx.dir}/yena' completion)"; print -r -- "$_comps[yena] $_comps[./yena] \${#_yena_described}"`;
	const r = spawnSync('zsh', ['-fc', probe], {encoding: 'utf8'});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), '_yena _yena 18');
});

const CONSOLE_EXEC = ['exec', '-e', 'YENA_LOG_LEVEL', '-e', 'YENA_LOG'];
const TSX = ['node_modules/.bin/tsx', 'src/cli.ts', '--run', '--'];
const CATALOG_CALL = ['exec', '-e', 'YENA_LOG=off', 'yena', 'node_modules/.bin/tsx', 'src/cli.ts', '--catalog'];

function consoleCall(all: string[][]) {
	const exec = all.find(a => a[0] === 'exec' && a.includes('--run'));
	assert.ok(exec, 'a console exec happened');
	const at = exec.indexOf('yena');
	assert.equal(exec[at + 1], 'sh');
	assert.match(exec[at + 3] ?? '', /echo \$\$ > "\$0"/);
	return {head: exec.slice(0, at + 1), words: exec.slice(at + 5)};
}

const catalogCalls = async (fx: Fixture) => (await argsOf(fx)).filter(a => a.includes('--catalog'));

test('an unlisted word runs as a console line, word by word', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['mod', 'list', 'a b', '$(x)']);
	assert.equal(r.status, 0, r.stderr);
	const all = await argsOf(fx);
	assert.deepEqual(all[0], PS);
	const c = consoleCall(all);
	assert.deepEqual(c.head, [...CONSOLE_EXEC, '-i', 'yena']);
	assert.deepEqual(c.words, [...TSX, 'mod', 'list', 'a b', '$(x)']);
	assert.deepEqual(untrack(all).at(-1), STOP);
	assert.equal(existsSync(path.join(fx.dir, '.yena', '.completion')), false);
	assert.deepEqual(await catalogCalls(fx), []);
});

test('an unknown word is always forwarded, whatever the catalog says', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['zzz', 'a']);
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(r.stderr, /Unknown command|Did you mean/);
	assert.deepEqual(consoleCall(await argsOf(fx)).words, [...TSX, 'zzz', 'a']);
});

test('claude is the console module, not the Claude Code CLI', async () => {
	const fx = await makeFixture({claude: true});
	assert.equal(run(fx, ['claude', 'sessions']).status, 0);
	assert.deepEqual(consoleCall(await argsOf(fx)).words, [...TSX, 'claude', 'sessions']);
});

test('console runs the words even for names the script has', async () => {
	const fx = await makeFixture();
	assert.equal(run(fx, ['console', 'help']).status, 0);
	assert.deepEqual(consoleCall(await argsOf(fx)).words, [...TSX, 'help']);
	const none = await makeFixture();
	const r = run(none, ['console']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /Usage: \.\/yena console/);
	assert.deepEqual(await argsOf(none), []);
});

test('exit 2 from a forwarded word suggests a script command, an explicit console line does not', async () => {
	const fx = await makeFixture();
	const word = unk(fx, 'stop');
	assert.equal(word.status, 2);
	assert.match(word.stderr, /Did you mean the script command: \.\/yena down\?/);
	const quiet = unk(fx, 'stop', {YENA_HINTS: 'off'});
	assert.match(quiet.stderr, /Did you mean the script command: \.\/yena down\?/);
	const explicit = run(fx, ['console', 'stop'], {STUB_EXIT: '2', STUB_FAIL_ON: 'stop'});
	assert.equal(explicit.status, 2);
	assert.doesNotMatch(explicit.stderr, /Did you mean/);
	const other = run(fx, ['stop'], {STUB_EXIT: '3', STUB_FAIL_ON: 'stop'});
	assert.equal(other.status, 3);
	assert.doesNotMatch(other.stderr, /Did you mean/);
});

test('claude-code is forwarded to the console, not run as a binary', async () => {
	const fx = await makeFixture({claude: true});
	assert.equal(run(fx, ['claude-code', 'x']).status, 0);
	const exec = (await argsOf(fx))[1]!;
	assert.deepEqual(exec.slice(-5), ['src/cli.ts', '--run', '--', 'claude-code', 'x']);
	assert.ok(!exec.includes('modules/claude/bin/claude'));
});

test('a console line gets a terminal only when stdin and stdout are both terminals', {skip: !hasShell('script') && 'script is not installed'}, async () => {
	const fx = await makeFixture();
	const out = path.join(fx.dir, 'tty.out');
	const env = {...process.env, STUB_LOG: fx.log, STUB_PS: 'abc', PATH: `${fx.bin}:${process.env.PATH ?? ''}`};
	// stdin is a terminal (script), stdout goes to a file: no -t
	spawnSync('script', ['-qc', `sh '${path.join(fx.dir, 'yena')}' mod list > '${out}'`, '/dev/null'], {env, encoding: 'utf8', timeout: 30_000, input: ''});
	const c = consoleCall(await argsOf(fx));
	assert.equal(c.head.includes('-t'), false);
});

test('the exit status of a console line passes through with a hint', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['mod', 'x'], {STUB_EXIT: '3', STUB_FAIL_ON: 'x'});
	assert.equal(r.status, 3);
	assert.match(r.stderr, /hint: console command failed \(exit 3\)/);
	const sig = run(fx, ['mod', 'y'], {STUB_EXIT: '130', STUB_FAIL_ON: 'y'});
	assert.equal(sig.status, 130);
	assert.doesNotMatch(sig.stderr, /console command failed/);
});

test('yena and start pass no completion file and create no .yena/.completion', async () => {
	const fx = await makeFixture();
	for (const cmd of ['yena', 'start']) {
		assert.equal(run(fx, [cmd]).status, 0);
	}
	const text = await readFile(fx.log, 'utf8');
	assert.ok(!text.includes('YENA_COMPLETION_FILE'));
	assert.equal(existsSync(path.join(fx.dir, '.yena', '.completion')), false);
});

test('script commands still take no arguments', async () => {
	const fx = await makeFixture();
	assert.equal(run(fx, ['up', 'foo']).status, 2);
	assert.deepEqual(await argsOf(fx), []);
});

test('help lists the live console commands and explains the rule', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['help']);
	assert.match(r.stdout, /Console commands\n {2}mod +Manage modules\n {2}scheduler +Schedule lines\n {2}claude +Claude chat\n/);
	assert.match(r.stdout, /\.\/yena mod list/);
	assert.doesNotMatch(r.stdout, /listed when the container is running/);
	assert.deepEqual(await argsOf(fx), [CATALOG_CALL]);
});

test('help prints a note instead of the list when the container is down or docker is missing', async () => {
	const note = /Console commands: listed when the container is running \(\.\/yena up\)\./;
	const fx = await makeFixture();
	const down = run(fx, ['help'], {STUB_CATALOG_FAIL: '1'});
	assert.equal(down.status, 0, down.stderr);
	assert.match(down.stdout, note);
	assert.doesNotMatch(down.stdout, /Console commands\n/);
	const empty = await mkdtemp(path.join(tmpdir(), 'yena-path-'));
	const fx2 = await makeFixture();
	const none = run(fx2, ['help'], {}, `${empty}:/bin:/usr/bin`);
	assert.equal(none.status, 0, none.stderr);
	assert.match(none.stdout, note);
	assert.deepEqual(await argsOf(fx2), []);
});

const EVIL = [
	'ok1\tFine one',
	'$(touch PWNED)\tx',
	'bad:colon\tx',
	'esc\tbad \u001b[31m desc',
	'ok2 sub1\tSub one',
	'ok2 `touch PWNED`\tx',
	'ok2 a b\tx',
	'ok2 sub2\tSub: two',
	'-dash\tx',
	`${'n'.repeat(65)}\tlong`,
	'mod\tShadow of nothing',
].join('\n') + '\n';

test('__commands drops malicious lines and never reaches compose or the container start', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['__commands'], {STUB_CATALOG: EVIL, STUB_PS: ''});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stderr, '');
	assert.deepEqual(r.stdout.split('\n'), ['ok1\tFine one', 'esc\tbad [31m desc', 'ok2 sub1\tSub one', 'ok2 sub2\tSub: two', 'mod\tShadow of nothing', '']);
	assert.deepEqual(await argsOf(fx), [CATALOG_CALL]);
});

test('__commands prints nothing and exits 0 when the container is down or docker is missing', async () => {
	const fx = await makeFixture();
	const down = run(fx, ['__commands'], {STUB_CATALOG_FAIL: '1'});
	assert.deepEqual([down.status, down.stdout, down.stderr], [0, '', '']);
	const empty = await mkdtemp(path.join(tmpdir(), 'yena-path-'));
	const none = run(fx, ['__commands'], {}, `${empty}:/bin:/usr/bin`);
	assert.deepEqual([none.status, none.stdout, none.stderr], [0, '', '']);
});

test('the catalog call has no -i or -t and silences the app log', async () => {
	const fx = await makeFixture();
	run(fx, ['__commands']);
	const [call] = await catalogCalls(fx);
	assert.deepEqual(call, CATALOG_CALL);
});

test('__commands is hidden from help, completion words and suggestions', async () => {
	const fx = await makeFixture();
	assert.ok(!run(fx, ['help']).stdout.includes('__commands'));
	const script = run(fx, ['completion']).stdout;
	assert.doesNotMatch(script, /_yena_words='[^']*__commands/);
	assert.doesNotMatch(script, /'__commands:/);
	assert.doesNotMatch(unk(fx, '__command').stderr, /__commands/);
});

test('a hanging catalog call is cut off after about 3 seconds', async () => {
	const fx = await makeFixture();
	const started = Date.now();
	const r = run(fx, ['__commands'], {STUB_CATALOG_SLEEP: '30'});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, '');
	assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
});

const shq = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

const BASH_PROBE = (fx: Fixture, cases: string) =>
	`cd ${shq(fx.elsewhere)}; eval "$(sh ${shq(`${fx.dir}/yena`)} completion)"; t() { COMP_WORDS=("$@"); COMP_CWORD=$((\${#COMP_WORDS[@]} - 1)); _yena; echo "[\${COMPREPLY[*]}]"; }; ${cases}`;

const bash = (fx: Fixture, cases: string, extra: Record<string, string> = {}) => spawnSync('bash', ['--norc', '-c', BASH_PROBE(fx, cases)], {encoding: 'utf8', env: stubEnv(fx, extra)});

test('bash completes commands and subcommands through the running app', {skip: !hasShell('bash')}, async () => {
	const fx = await makeFixture();
	const r = bash(fx, `t ./yena mod; t ./yena ''; t ./yena console ''; t ./yena console mod ''; t ./yena mod ''; t ./yena mod 'in'; t ./yena claude ''; t ./yena claude-code ''; t ./yena up ''`);
	assert.equal(r.status, 0, r.stderr);
	const lines = r.stdout.trim().split('\n');
	assert.deepEqual(lines[0], '[mod]');
	assert.match(lines[1]!, /^\[help up .* console mod scheduler claude\]$/);
	assert.equal(lines[1]!.split(' ').filter(w => w === '[claude' || w === 'claude' || w === 'claude]').length, 1);
	assert.equal(lines[2], '[mod scheduler claude]');
	assert.equal(lines[3], '[list install]');
	assert.equal(lines[4], '[list install]');
	assert.equal(lines[5], '[install]');
	assert.equal(lines[6], '[sessions]');
	assert.equal(lines[7], '[]');
	assert.equal(lines[8], '[]');
});

test('bash: the arguments of claude code complete to nothing and removed words are not offered', {skip: !hasShell('bash')}, async () => {
	const fx = await makeFixture();
	const r = bash(fx, `t ./yena claude code ''; t ./yena claude code --ver; t ./yena ''`);
	assert.equal(r.status, 0, r.stderr);
	const lines = r.stdout.trim().split('\n');
	assert.equal(lines[0], '[]');
	assert.equal(lines[1], '[]');
	for (const word of ['check', 'lint', 'claude-code', 'typecheck-modules', 'test-modules']) assert.ok(!lines[2]!.slice(1, -1).split(' ').includes(word), word);
});

test('help lists no removed command and names the host typecheck and test', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['help']);
	assert.equal(r.status, 0, r.stderr);
	for (const word of ['check', 'claude-code', 'typecheck-modules', 'test-modules']) assert.doesNotMatch(r.stdout, new RegExp(`^  ${word}\\s`, 'm'), word);
	assert.match(r.stdout, /^  typecheck\s+Check host types$/m);
	assert.match(r.stdout, /^  test\s+Run the host tests$/m);
});

test('claude code with arguments is forwarded as one console line', async () => {
	const fx = await makeFixture();
	assert.equal(run(fx, ['claude', 'code', '--version']).status, 0);
	const exec = (await argsOf(fx)).find(a => a.includes('--run'))!;
	assert.deepEqual(exec.slice(exec.indexOf('--run')), ['--run', '--', 'claude', 'code', '--version']);
});

test('bash: two Tabs in one shell make one catalog call and none starts the container', {skip: !hasShell('bash')}, async () => {
	const fx = await makeFixture();
	const r = bash(fx, `t ./yena mod; t ./yena mod ''; t ./yena ''`, {STUB_PS: ''});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(await argsOf(fx), [CATALOG_CALL]);
});

test('bash: a failing catalog is remembered too and leaves only the script words', {skip: !hasShell('bash')}, async () => {
	const fx = await makeFixture();
	const r = bash(fx, `t ./yena 'te'; t ./yena mod ''`, {STUB_CATALOG_FAIL: '1'});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(r.stdout.trim().split('\n'), ['[test]', '[]']);
	assert.equal((await catalogCalls(fx)).length, 1);
});

test('bash: a hanging catalog returns within about 4 seconds with only the script words', {skip: !hasShell('bash')}, async () => {
	const fx = await makeFixture();
	const started = Date.now();
	const r = bash(fx, `t ./yena 'comp'`, {STUB_CATALOG_SLEEP: '30'});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), '[compile completion]');
	assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
});

test('a malicious catalog is skipped by bash completion and runs nothing', {skip: !hasShell('bash')}, async () => {
	const fx = await makeFixture();
	const r = bash(fx, `t ./yena ''; t ./yena ok2 ''; t ./yena console ok2 ''`, {STUB_CATALOG: EVIL});
	assert.equal(r.status, 0, r.stderr);
	const lines = r.stdout.trim().split('\n');
	assert.match(lines[0]!, / ok1 esc mod\]$/);
	assert.ok(!lines[0]!.includes('touch') && !lines[0]!.includes('bad') && !lines[0]!.includes('dash') && !lines[0]!.includes('nnnn'));
	assert.equal(lines[1], '[sub1 sub2]');
	assert.equal(lines[2], '[sub1 sub2]');
	assert.equal(existsSync(path.join(fx.elsewhere, 'PWNED')), false);
	assert.equal(existsSync(path.join(fx.dir, 'PWNED')), false);
});

test('the completion embeds a script path with a quote safely', {skip: !hasShell('bash')}, async () => {
	const fx = await makeFixture({name: "it's here"});
	const r = bash(fx, "t ./yena mod; t ./yena mod ''");
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(r.stdout.trim().split('\n'), ['[mod]', '[list install]']);
});

test('zsh completes through the running app and survives a malicious catalog', {skip: !hasShell('zsh')}, async () => {
	for (const catalog of [DEFAULT_CATALOG, EVIL]) {
		const fx = await makeFixture();
		const probe = `cd '${fx.elsewhere}'; eval "$(sh ${shq(`${fx.dir}/yena`)} completion)"; _yena_load; _yena_load; print -r -- "\${#_yena_rows}"; _yena_cands '' skip; print -r -- "\${_yena_out[@]%%$'\\t'*}"; _yena_cands mod ''; print -r -- "\${_yena_out[@]%%$'\\t'*}"`;
		const r = spawnSync('zsh', ['-fc', probe], {encoding: 'utf8', env: stubEnv(fx, {STUB_CATALOG: catalog})});
		assert.equal(r.status, 0, r.stderr);
		const [n, names, subs] = r.stdout.trim().split('\n');
		if (catalog === DEFAULT_CATALOG) assert.deepEqual([n, names, subs], ['6', 'mod scheduler claude', 'list install']);
		else assert.deepEqual([n, names, subs ?? ''], ['5', 'ok1 esc mod', '']);
		assert.equal((await catalogCalls(fx)).length, 1);
		assert.equal(existsSync(path.join(fx.elsewhere, 'PWNED')), false);
	}
});

test('__commands takes no arguments and exits 2 without calling docker', async () => {
	const fx = await makeFixture();
	const r = run(fx, ['__commands', 'x']);
	assert.equal(r.status, 2);
	assert.deepEqual(await argsOf(fx), []);
});

test('zsh: a floating point SECONDS still memoises the catalog', {skip: !hasShell('zsh')}, async () => {
	const fx = await makeFixture();
	const probe = `cd '${fx.elsewhere}'; eval "$(sh ${shq(`${fx.dir}/yena`)} completion)"; typeset -F SECONDS; sleep 1.2; _yena_load; sleep 1.2; _yena_load`;
	const r = spawnSync('zsh', ['-fc', probe], {encoding: 'utf8', env: stubEnv(fx, {})});
	assert.equal(r.status, 0, r.stderr);
	assert.equal((await catalogCalls(fx)).length, 1);
});
