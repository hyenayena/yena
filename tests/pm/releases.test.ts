import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-releases-')));
process.env.YENA_HOME = home;
delete process.env.YENA_DATA;
const {findRelease} = await import('../../src/pm/releases.js');
const {satisfies} = await import('../../src/pm/versions.js');

const log = () => {};

async function repo(name: string, commits: Record<string, unknown>[]): Promise<{dir: string; heads: string[]}> {
	const dir = path.join(home, 'repos', name);
	await mkdir(dir, {recursive: true});
	const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: dir, encoding: 'utf8'});
	git('init', '-q');
	const heads: string[] = [];
	for (const [i, manifest] of commits.entries()) {
		await writeFile(path.join(dir, 'yena.json'), JSON.stringify(manifest));
		await writeFile(path.join(dir, 'code.txt'), String(i));
		git('add', '.');
		git('commit', '-q', '-m', `c${i}`);
		heads.push(git('rev-parse', 'HEAD').trim());
	}
	return {dir, heads};
}
const m = (version: string, extra: Record<string, unknown> = {}) => ({name: 'chat', version, ...extra});
const inRange = (range: string) => (manifest: {version: string}) => satisfies(manifest.version, range);

test('the newest commit with a version inside the range wins', async () => {
	const {dir, heads} = await repo('newest', [m('0.4.0'), m('0.5.0'), m('0.5.3'), m('0.6.0')]);
	const found = await findRelease(`file://${dir}`, undefined, inRange('^0.5.0'), log);
	assert.equal(found?.manifest.version, '0.5.3');
	assert.equal(found?.commit, heads[2]);
	const none = await readdir(path.join(home, 'modules')).catch(() => []);
	assert.deepEqual(none.filter(n => n.startsWith('.probe')), []);
});

test('no version in range gives undefined', async () => {
	const {dir} = await repo('none', [m('0.4.0'), m('0.6.0')]);
	assert.equal(await findRelease(`file://${dir}`, undefined, inRange('^0.5.0'), log), undefined);
});

test('commits with an old-format manifest never qualify', async () => {
	const {dir, heads} = await repo('old', [m('0.5.0', {dependencies: {core: {source: 'core', version: '^0.22.0'}}}), m('0.5.9', {dependencies: {core: 'core'}})]);
	const found = await findRelease(`file://${dir}`, undefined, () => true, log);
	assert.equal(found?.commit, heads[0]);
	assert.equal(found?.manifest.version, '0.5.0');
});

test('a git failure names the module, the source and the reason, and leaves no probe behind', async () => {
	const missing = `file://${path.join(home, 'repos', 'nope')}`;
	await assert.rejects(findRelease(missing, undefined, () => true, log), new RegExp(`Cannot read the versions of ${missing.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} from ${missing.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: `));
	const left = await readdir(path.join(home, 'modules')).catch(() => []);
	assert.deepEqual(left.filter(n => n.startsWith('.probe')), []);
	assert.ok(!existsSync(path.join(home, 'modules', '.probe')));
});

test('a path source offers only the current manifest', async () => {
	const dir = path.join(home, 'folder');
	await mkdir(dir, {recursive: true});
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify(m('0.5.1')));
	const found = await findRelease(dir, undefined, inRange('^0.5.0'), log);
	assert.deepEqual([found?.commit, found?.manifest.version], [undefined, '0.5.1']);
	assert.equal(await findRelease(dir, undefined, inRange('^0.6.0'), log), undefined);
	await assert.rejects(findRelease(path.join(home, 'absent'), undefined, () => true, log), /Cannot read the versions of .* Folder .* does not exist/);
});
