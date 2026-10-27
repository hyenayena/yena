import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'node:test';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-account-install-')));
process.env.YENA_HOME = home;
process.env.YENA_DATA = path.join(home, 'data');
const {install} = await import('../../src/pm/manager.js');
const {registerGitSsh, resetGitSsh} = await import('../../src/pm/git-ssh.js');

afterEach(() => resetGitSsh());

async function repo(name: string): Promise<string> {
	const dir = path.join(home, `repo-${name}`);
	await mkdir(dir);
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name, version: '1.0.0'}));
	const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: dir, stdio: 'ignore'});
	git('init', '-q');
	git('add', '.');
	git('commit', '-q', '-m', 'init');
	return dir;
}

test('--account without the account module fails before fetching', async () => {
	await assert.rejects(install(['owner/private'], () => {}, {account: 'bot'}), /needs the account module/);
});

test('--account asks the resolver and keeps the account in the lock file', async () => {
	const asked: string[] = [];
	registerGitSsh(async name => {
		asked.push(name);
		return 'ssh';
	});
	const dir = await repo('demo');
	await install([`file://${dir}`], () => {}, {account: 'bot'});
	assert.deepEqual(asked, ['bot']);
	const lock = JSON.parse(await readFile(path.join(home, 'yena-modules.json'), 'utf8'));
	assert.equal(lock.modules.demo.account, 'bot');
});

test('git fetch runs with the account ssh command', async () => {
	const marker = path.join(home, 'ssh-used');
	registerGitSsh(async () => `touch '${marker}'; false`);
	await assert.rejects(install(['ssh://git.invalid/owner/x.git'], () => {}, {account: 'bot'}));
	assert.ok(existsSync(marker));
});

test('a resolver error stops the install', async () => {
	registerGitSsh(async name => {
		throw new Error(`Account "${name}" is disabled`);
	});
	await assert.rejects(install(['owner/x'], () => {}, {account: 'off'}), /disabled/);
});

test('the first resolver stays', async () => {
	assert.equal(registerGitSsh(async () => 'a'), true);
	assert.equal(registerGitSsh(async () => 'b'), false);
});
