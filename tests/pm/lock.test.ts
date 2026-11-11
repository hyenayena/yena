import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeEach, test} from 'node:test';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-lock-')));
process.env.YENA_HOME = home;
delete process.env.YENA_DATA;
const {lockRoot} = await import('../../src/pm/manager.js');

const out: string[] = [];
const log = (l: string) => void out.push(l);
const lockFile = path.join(home, 'yena-modules.json');
const readLock = async () => (JSON.parse(await readFile(lockFile, 'utf8')) as {modules: Record<string, Record<string, string>>}).modules;

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: dir, encoding: 'utf8'});

async function checkout(name: string, version: string, origin?: string, deps: Record<string, unknown> = {}) {
	const dir = path.join(home, 'modules', name);
	await mkdir(dir, {recursive: true});
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name, version, dependencies: deps}));
	git(dir, 'init', '-q');
	if (origin) git(dir, 'remote', 'add', 'origin', origin);
	git(dir, 'add', '.');
	git(dir, 'commit', '-q', '-m', 'c');
	return {dir, head: git(dir, 'rev-parse', 'HEAD').trim()};
}

beforeEach(async () => {
	await rm(path.join(home, 'modules'), {recursive: true, force: true});
	await rm(lockFile, {force: true});
	out.length = 0;
});

test('records the version, the HEAD commit and the official source of each checkout', async () => {
	const chat = await checkout('chat', '0.5.1', 'git@github.com:hyenayena/chat.git');
	const other = await checkout('other', '1.0.0', 'https://example.com/x/other.git');
	const kept = await checkout('kept', '2.0.0', 'https://example.com/x/kept.git');
	await writeFile(lockFile, JSON.stringify({modules: {kept: {source: 'me/kept', version: '1.0.0', account: 'bot'}, ghost: {source: 'ghost', version: '1.0.0'}}}));
	await lockRoot(log);
	assert.deepEqual(await readLock(), {
		chat: {source: 'chat', version: '0.5.1', commit: chat.head},
		kept: {source: 'me/kept', version: '2.0.0', commit: kept.head, account: 'bot'},
		other: {source: 'https://example.com/x/other.git', version: '1.0.0', commit: other.head},
	});
	assert.ok(out.includes(`✓ chat@0.5.1 ${chat.head.slice(0, 7)}`));
});

test('a checkout with uncommitted changes is skipped and keeps its old entry', async () => {
	const clan = await checkout('clan', '0.1.0', 'https://example.com/x/clan.git');
	await checkout('chat', '0.5.1', 'https://github.com/hyenayena/chat');
	await writeFile(path.join(clan.dir, 'notes.txt'), 'wip');
	await writeFile(lockFile, JSON.stringify({modules: {clan: {source: 'clan', version: '0.0.1', commit: 'abc'}}}));
	await lockRoot(log);
	assert.ok(out.includes('! clan has uncommitted changes; not locked'));
	const lock = await readLock();
	assert.deepEqual(lock.clan, {source: 'clan', version: '0.0.1', commit: 'abc'});
	assert.equal(lock.chat!.source, 'chat');
});

test('an incompatible set is refused and the lock stays as it was', async () => {
	await checkout('b', '1.0.0');
	await checkout('a', '1.0.0', undefined, {b: {source: 'b', version: '^2.0.0'}});
	await writeFile(lockFile, '{"modules":{}}');
	await assert.rejects(lockRoot(log), /mod lock refuses an incompatible set: a needs b \^2\.0\.0, installed 1\.0\.0; run "mod update b"/);
	assert.equal(await readFile(lockFile, 'utf8'), '{"modules":{}}');
});
