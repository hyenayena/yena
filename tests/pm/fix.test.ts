import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeEach, test} from 'node:test';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-fix-')));
process.env.YENA_HOME = home;
delete process.env.YENA_DATA;
const {fixVersions} = await import('../../src/pm/fix.js');

const out: string[] = [];
const log = (l: string) => void out.push(l);
const lockFile = path.join(home, 'yena-modules.json');

type Deps = Record<string, {source: string; version: string; optional?: boolean}>;
const manifest = (name: string, version: string, deps: Record<string, string> = {}) => ({
	name,
	version,
	dependencies: Object.fromEntries(Object.entries(deps).map(([d, v]) => [d, {source: d, version: v}] as [string, Deps[string]])),
});

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: dir, encoding: 'utf8'});

async function repo(name: string, versions: [string, Record<string, string>?][]): Promise<{url: string; heads: string[]}> {
	const dir = path.join(home, 'repos', name);
	await mkdir(dir, {recursive: true});
	git(dir, 'init', '-q');
	const heads: string[] = [];
	for (const [version, deps] of versions) {
		await writeFile(path.join(dir, 'yena.json'), JSON.stringify(manifest(name, version, deps)));
		git(dir, 'add', '.');
		git(dir, 'commit', '-q', '-m', version);
		heads.push(git(dir, 'rev-parse', 'HEAD').trim());
	}
	return {url: `file://${dir}`, heads};
}

async function installed(name: string, version: string, deps: Record<string, string> = {}, {checkout = false, source}: {checkout?: boolean; source?: string} = {}) {
	const dir = path.join(home, 'modules', name);
	await mkdir(dir, {recursive: true});
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify(manifest(name, version, deps), null, '\t') + '\n');
	if (checkout) {
		git(dir, 'init', '-q');
		git(dir, 'add', '.');
		git(dir, 'commit', '-q', '-m', 'x');
	}
	if (source) {
		const lock = await readFile(lockFile, 'utf8').then(JSON.parse, () => ({modules: {}}));
		lock.modules[name] = {source, version};
		await writeFile(lockFile, JSON.stringify(lock));
	}
	return dir;
}
const versionOf = async (name: string) => (JSON.parse(await readFile(path.join(home, 'modules', name, 'yena.json'), 'utf8')) as {version: string}).version;

beforeEach(async () => {
	for (const dir of ['modules', 'repos']) await rm(path.join(home, dir), {recursive: true, force: true});
	await rm(lockFile, {force: true});
	out.length = 0;
});

test('no conflicts: nothing to do', async () => {
	await installed('chat', '0.5.0');
	await installed('claude', '0.34.0', {chat: '^0.5.0'});
	await fixVersions({yes: true, ranges: false}, log);
	await fixVersions({yes: true, ranges: true}, log);
	assert.deepEqual(out, ['No version conflicts', 'No version conflicts']);
});

test('a stale dependency gets a plan; without --yes nothing changes', async () => {
	const chat = await repo('chat', [['0.4.0'], ['0.5.0'], ['0.5.3'], ['0.6.0']]);
	await installed('chat', '0.4.0', {}, {source: chat.url});
	await installed('claude', '0.34.0', {chat: '^0.5.0'});
	await fixVersions({yes: false, ranges: false}, log);
	assert.ok(out.includes('! claude needs chat ^0.5.0, installed 0.4.0; run "mod update chat"'), out.join('|'));
	assert.ok(out.includes(`update chat 0.4.0 → 0.5.3 (${chat.heads[2]!.slice(0, 7)} from ${chat.url})`), out.join('|'));
	assert.equal(out.at(-1), 'Run "mod fix --yes" to apply');
	assert.equal(await versionOf('chat'), '0.4.0');
});

test('--yes installs the pinned commit and records it in the lock', async () => {
	const chat = await repo('chat', [['0.4.0'], ['0.5.0'], ['0.5.3'], ['0.6.0']]);
	await installed('chat', '0.4.0', {}, {source: chat.url});
	await installed('claude', '0.34.0', {chat: '^0.5.0'});
	await fixVersions({yes: true, ranges: false}, log);
	assert.equal(await versionOf('chat'), '0.5.3');
	const lock = JSON.parse(await readFile(lockFile, 'utf8')) as {modules: Record<string, {commit: string; version: string}>};
	assert.deepEqual([lock.modules.chat!.version, lock.modules.chat!.commit], ['0.5.3', chat.heads[2]]);
	assert.ok(out.includes('✓ chat@0.5.3'));
	out.length = 0;
	await fixVersions({yes: true, ranges: false}, log);
	assert.deepEqual(out, ['No version conflicts']);
});

test('a too-new dependency is resolved by a newer dependent', async () => {
	const claude = await repo('claude', [['0.34.0', {chat: '^0.5.0'}], ['0.35.0', {chat: '^0.6.0'}]]);
	await installed('chat', '0.6.0');
	await installed('claude', '0.34.0', {chat: '^0.5.0'}, {source: claude.url});
	await fixVersions({yes: true, ranges: false}, log);
	assert.equal(await versionOf('claude'), '0.35.0');
	assert.equal(await versionOf('chat'), '0.6.0');
});

test('when no version fits, it throws and changes nothing', async () => {
	const chat = await repo('chat', [['0.4.0']]);
	const claude = await repo('claude', [['0.34.0', {chat: '^0.5.0'}]]);
	await installed('chat', '0.4.0', {}, {source: chat.url});
	await installed('claude', '0.34.0', {chat: '^0.5.0'}, {source: claude.url});
	await assert.rejects(
		fixVersions({yes: true, ranges: false}, log),
		/mod fix cannot resolve: claude needs chat \^0\.5\.0, installed 0\.4\.0; run "mod update chat"; nothing was changed\. In a working copy, mod fix --ranges moves the ranges/,
	);
	assert.equal(await versionOf('chat'), '0.4.0');
});

test('a git checkout is never replaced', async () => {
	const chat = await repo('chat', [['0.4.0'], ['0.5.0']]);
	const dir = await installed('chat', '0.4.0', {}, {checkout: true, source: chat.url});
	await installed('claude', '0.34.0', {chat: '^0.5.0'});
	await assert.rejects(fixVersions({yes: true, ranges: false}, log), /mod fix cannot resolve: .*chat is a git checkout; update it with git or use mod fix --ranges/);
	assert.equal(await versionOf('chat'), '0.4.0');
	assert.match(git(dir, 'status', '--short'), /^$/);
});

test('--ranges rewrites the range of working copies only, with tabs and nothing else', async () => {
	await installed('chat', '0.6.0');
	const claude = await installed('claude', '0.34.0', {chat: '^0.5.0'}, {checkout: true});
	const task = await installed('task', '0.9.0', {chat: '^0.5.0'});
	const taskBefore = await readFile(path.join(task, 'yena.json'), 'utf8');
	const claudeBefore = JSON.parse(await readFile(path.join(claude, 'yena.json'), 'utf8')) as {dependencies: Record<string, {version: string}>};

	await fixVersions({yes: false, ranges: true}, log);
	assert.ok(out.includes('claude/yena.json: chat ^0.5.0 → ^0.6.0'));
	assert.ok(out.includes('! task is not a working copy; change its yena.json in its repo'));
	assert.equal(out.at(-1), 'Run "mod fix --ranges --yes" to apply');
	assert.equal(JSON.parse(await readFile(path.join(claude, 'yena.json'), 'utf8')).dependencies.chat.version, '^0.5.0');

	out.length = 0;
	await fixVersions({yes: true, ranges: true}, log);
	assert.ok(out.includes("Changed claude/yena.json: chat ^0.5.0 → ^0.6.0. Test it, bump claude's version and commit; restart yena to load it"), out.join('|'));
	claudeBefore.dependencies.chat!.version = '^0.6.0';
	assert.equal(await readFile(path.join(claude, 'yena.json'), 'utf8'), JSON.stringify(claudeBefore, null, '\t') + '\n');
	assert.equal(await readFile(path.join(task, 'yena.json'), 'utf8'), taskBefore);
	assert.equal(git(claude, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('--ranges leaves a too-old dependency to mod fix', async () => {
	await installed('chat', '0.4.0');
	const claude = await installed('claude', '0.34.0', {chat: '^0.5.0'}, {checkout: true});
	const before = await readFile(path.join(claude, 'yena.json'), 'utf8');
	await fixVersions({yes: true, ranges: true}, log);
	assert.deepEqual(out, ['! claude needs chat ^0.5.0, installed 0.4.0; run "mod update chat"; run "mod fix"']);
	assert.equal(await readFile(path.join(claude, 'yena.json'), 'utf8'), before);
});
