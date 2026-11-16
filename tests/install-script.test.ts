import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chmod, mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../install.sh', import.meta.url));
const MARK = '# yena launcher, written by the yena installer (install.sh)';
const ESC = String.fromCharCode(27);

const YENA_STUB = `#!/bin/sh
echo "yena $*" >> "$STUB_LOG"
for a in "$@"; do echo "arg:$a" >> "$STUB_LOG"; done
if [ "$1" = build ] && [ -n "\${STUB_BUILD_EXIT-}" ]; then exit "$STUB_BUILD_EXIT"; fi
exit 0
`;

const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1 $2" in
"compose version") exit "\${STUB_COMPOSE_EXIT:-0}" ;;
esac
if [ "$1" = info ]; then exit "\${STUB_INFO_EXIT:-0}"; fi
exit 0
`;

const GIT_STUB = `#!/bin/sh
echo "git $*" >> "$STUB_LOG"
if [ "$1" = clone ]; then
	mkdir -p "$3/.git" "$3/src"
	: > "$3/src/cli.ts"
	: > "$3/compose.yaml"
	cat > "$3/yena" <<'INNER'
${YENA_STUB}INNER
	chmod 755 "$3/yena"
	exit 0
fi
if [ "$1" = -C ]; then
	case "$3" in
	status) printf '%s' "\${STUB_GIT_STATUS-}"; exit 0 ;;
	pull) exit "\${STUB_PULL_EXIT:-0}" ;;
	esac
fi
exit 0
`;

async function makeFixture() {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'install-script-')));
	const home = path.join(root, 'home');
	const bin = path.join(root, 'bin');
	const gitOnly = path.join(root, 'gitbin');
	const log = path.join(root, 'stub.log');
	for (const d of [home, bin, gitOnly]) await mkdir(d);
	await writeFile(path.join(bin, 'git'), GIT_STUB, {mode: 0o755});
	await writeFile(path.join(bin, 'docker'), DOCKER_STUB, {mode: 0o755});
	await writeFile(path.join(gitOnly, 'git'), GIT_STUB, {mode: 0o755});
	await chmod(path.join(bin, 'git'), 0o755);
	await chmod(path.join(bin, 'docker'), 0o755);
	await chmod(path.join(gitOnly, 'git'), 0o755);
	await writeFile(log, '');
	return {root, home, bin, gitOnly, log, work: path.join(root, 'Proj'), target: path.join(root, 'Proj', 'yena')};
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

function run(fx: Fixture, extra: Record<string, string | undefined> = {}, opts: {file?: string; argv?: string[]; pathVar?: string} = {}) {
	const env: Record<string, string> = {
		PATH: opts.pathVar ?? `${fx.bin}:/usr/bin:/bin`,
		HOME: fx.home,
		STUB_LOG: fx.log,
		YENA_WORKPLACE: fx.work,
	};
	for (const [k, v] of Object.entries(extra)) {
		if (v === undefined) delete env[k];
		else env[k] = v;
	}
	const argv = opts.argv ?? [script];
	const r = spawnSync(opts.file ?? '/bin/sh', argv, {cwd: fx.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000});
	return {status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr};
}

async function lines(fx: Fixture): Promise<string[]> {
	return (await readFile(fx.log, 'utf8')).split('\n').filter(l => l && !l.startsWith('arg:'));
}

const gitLines = (all: string[]) => all.filter(l => l.startsWith('git '));
const hasGit = (all: string[]) => gitLines(all).length > 0;

async function makeCheckout(dir: string) {
	await mkdir(path.join(dir, '.git'), {recursive: true});
	await mkdir(path.join(dir, 'src'));
	await writeFile(path.join(dir, 'src', 'cli.ts'), '');
	await writeFile(path.join(dir, 'compose.yaml'), '');
	await writeFile(path.join(dir, 'yena'), YENA_STUB, {mode: 0o755});
	await chmod(path.join(dir, 'yena'), 0o755);
}

const launcherOf = (fx: Fixture) => path.join(fx.home, '.local', 'bin', 'yena');
const URL_ = 'https://github.com/hyenayena/yena.git';

test('the installer passes a POSIX sh syntax check', () => {
	const r = spawnSync('/bin/sh', ['-n', script], {encoding: 'utf8'});
	assert.equal(r.status, 0, r.stderr);
});

test('a fresh install clones, builds, writes a launcher that forwards its arguments', async () => {
	const fx = await makeFixture();
	fx.work = path.join(fx.root, "my 'proj dir", 'new');
	fx.target = path.join(fx.work, 'yena');
	const r = run(fx);
	assert.equal(r.status, 0, r.out);
	assert.deepEqual(await lines(fx), [
		'docker compose version',
		'docker info',
		`git clone ${URL_} ${fx.target}`,
		'yena build',
	]);
	const launcher = launcherOf(fx);
	assert.equal((await stat(launcher)).mode & 0o777, 0o755);
	assert.match(await readFile(launcher, 'utf8'), new RegExp(MARK.replace(/[()]/g, '\\$&')));
	assert.ok(r.stdout.includes(fx.target));
	assert.ok(r.stdout.includes(fx.work));
	await writeFile(fx.log, '');
	const l = spawnSync(launcher, ['a', 'b c'], {env: {PATH: '/usr/bin:/bin', STUB_LOG: fx.log}, encoding: 'utf8'});
	assert.equal(l.status, 0, l.stderr);
	assert.deepEqual((await readFile(fx.log, 'utf8')).split('\n').filter(x => x.startsWith('arg:')), ['arg:a', 'arg:b c']);
});

test('a tilde in YENA_WORKPLACE expands to HOME', async () => {
	const fx = await makeFixture();
	const r = run(fx, {YENA_WORKPLACE: '~/P'});
	assert.equal(r.status, 0, r.out);
	assert.ok(existsSync(path.join(fx.home, 'P', 'yena', '.git')));
	assert.ok(gitLines(await lines(fx)).includes(`git clone ${URL_} ${path.join(fx.home, 'P', 'yena')}`));
});

for (const kind of ['home', 'home/.', 'root']) {
	test(`refuses ${kind} as the projects folder`, async () => {
		const fx = await makeFixture();
		const value = kind === 'home' ? fx.home : kind === 'root' ? '/' : `${fx.home}/.`;
		const r = run(fx, {YENA_WORKPLACE: value});
		assert.equal(r.status, 1);
		assert.match(r.stderr, /Pick a folder for your projects/);
		assert.ok(!hasGit(await lines(fx)));
	});
}

test('an existing checkout is updated: status, pull, build, rebuild', async () => {
	const fx = await makeFixture();
	await makeCheckout(fx.target);
	const r = run(fx);
	assert.equal(r.status, 0, r.out);
	const all = await lines(fx);
	assert.deepEqual(all.slice(2), [
		`git -C ${fx.target} status --porcelain --untracked-files=no`,
		`git -C ${fx.target} pull --ff-only`,
		'yena build',
		'yena rebuild',
	]);
	assert.ok(!all.some(l => l.startsWith('git clone')));
});

test('local changes in the checkout stop the update', async () => {
	const fx = await makeFixture();
	await makeCheckout(fx.target);
	const r = run(fx, {STUB_GIT_STATUS: ' M x'});
	assert.equal(r.status, 1);
	assert.match(r.stderr, /local changes/);
	const all = await lines(fx);
	assert.ok(!all.some(l => l.includes('pull') || l.startsWith('yena')));
});

test('a failed fast-forward stops before the build', async () => {
	const fx = await makeFixture();
	await makeCheckout(fx.target);
	const r = run(fx, {STUB_PULL_EXIT: '1'});
	assert.equal(r.status, 1);
	assert.match(r.stderr, /fast-forward/);
	assert.ok(!(await lines(fx)).some(l => l.startsWith('yena')));
});

test('a folder that is not a checkout is left untouched', async () => {
	const fx = await makeFixture();
	await mkdir(fx.target, {recursive: true});
	await writeFile(path.join(fx.target, 'notes.txt'), 'mine');
	const r = run(fx);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /not a yena checkout/);
	assert.deepEqual(await readdir(fx.target), ['notes.txt']);
	const all = await lines(fx);
	assert.ok(!hasGit(all));
	assert.ok(!all.some(l => l.startsWith('yena')));
});

test('a foreign launcher is kept with a warning; an installer launcher is replaced', async () => {
	const fx = await makeFixture();
	await mkdir(path.dirname(launcherOf(fx)), {recursive: true});
	await writeFile(launcherOf(fx), 'foreign\n');
	const r = run(fx);
	assert.equal(r.status, 0, r.out);
	assert.match(r.stderr, /Warning/);
	assert.equal(await readFile(launcherOf(fx), 'utf8'), 'foreign\n');

	const fy = await makeFixture();
	const first = run(fy);
	assert.equal(first.status, 0, first.out);
	fy.work = path.join(fy.root, 'Other');
	const second = run(fy);
	assert.equal(second.status, 0, second.out);
	const text = await readFile(launcherOf(fy), 'utf8');
	assert.ok(text.includes(path.join(fy.root, 'Other', 'yena')));
	assert.ok(!text.includes(path.join(fy.root, 'Proj', 'yena')));
});

test('the PATH hint appears only when ~/.local/bin is not on PATH', async () => {
	const fx = await makeFixture();
	const off = run(fx);
	assert.match(off.stdout, /export PATH=/);
	const fy = await makeFixture();
	const on = run(fy, {}, {pathVar: `${fy.bin}:${fy.home}/.local/bin:/usr/bin:/bin`});
	assert.equal(on.status, 0, on.out);
	assert.doesNotMatch(on.stdout, /export PATH=/);
});

test('missing compose v2 and a stopped daemon stop before any git call', async () => {
	const fx = await makeFixture();
	const a = run(fx, {STUB_COMPOSE_EXIT: '1'});
	assert.equal(a.status, 1);
	assert.match(a.stderr, /Compose v2/);
	const b = run(fx, {STUB_INFO_EXIT: '1'});
	assert.equal(b.status, 1);
	assert.match(b.stderr, /Docker does not answer/);
	assert.ok(!hasGit(await lines(fx)));
});

test('missing docker stops the installer', {skip: ['/bin/docker', '/usr/bin/docker'].some(existsSync) ? 'docker is installed' : false}, async () => {
	const fx = await makeFixture();
	const r = run(fx, {}, {pathVar: `${fx.gitOnly}:/usr/bin:/bin`});
	assert.equal(r.status, 1);
	assert.match(r.stderr, /Docker is not installed/);
	assert.ok(!hasGit(await lines(fx)));
});

const setsid = ['/usr/bin/setsid', '/bin/setsid'].find(existsSync);
test('without a terminal or YENA_WORKPLACE the default folder is used', {skip: setsid ? false : 'setsid is missing'}, async () => {
	const fx = await makeFixture();
	const r = run(fx, {YENA_WORKPLACE: undefined}, {file: setsid, argv: ['/bin/sh', script]});
	assert.equal(r.status, 0, r.out);
	assert.ok(existsSync(path.join(fx.home, 'Projects', 'yena', '.git')));
});

test('output on a pipe has no escape bytes', async () => {
	const fx = await makeFixture();
	const ok = run(fx);
	assert.ok(!ok.out.includes(ESC));
	const bad = run(fx, {YENA_WORKPLACE: fx.home});
	assert.ok(!bad.out.includes(ESC));
});

test('a failed build exits 1 with its exit code', async () => {
	const fx = await makeFixture();
	const r = run(fx, {STUB_BUILD_EXIT: '3'});
	assert.equal(r.status, 1);
	assert.match(r.stderr, /failed \(exit 3\)/);
});

const hasBash = existsSync('/bin/bash') || existsSync('/usr/bin/bash');
const busybox = ['/bin/busybox', '/usr/bin/busybox'].find(existsSync);

test('a fresh install works under bash --posix', {skip: hasBash ? false : 'bash is missing'}, async () => {
	const fx = await makeFixture();
	const r = run(fx, {}, {file: 'bash', argv: ['--posix', script], pathVar: `${fx.bin}:/usr/bin:/bin`});
	assert.equal(r.status, 0, r.out);
	assert.ok(existsSync(path.join(fx.target, '.git')));
});

test('a fresh install works under busybox sh', {skip: busybox ? false : 'busybox is missing'}, async () => {
	const fx = await makeFixture();
	const r = run(fx, {}, {file: busybox, argv: ['sh', script]});
	assert.equal(r.status, 0, r.out);
	assert.ok(existsSync(path.join(fx.target, '.git')));
});
