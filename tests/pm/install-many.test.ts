import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-install-many-')));
process.env.YENA_HOME = home;
process.env.YENA_DATA = path.join(home, 'data');
const {install} = await import('../../src/pm/manager.js');

async function source(name: string) {
	const dir = path.join(home, `src-${name}`);
	await mkdir(dir, {recursive: true});
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name, version: '1.0.0'}));
	return dir;
}

test('install takes several sources at once and locks each', async () => {
	await install([await source('one'), await source('two')], () => {});
	const lock = JSON.parse(await readFile(path.join(home, 'data', 'host', 'yena-modules.json'), 'utf8'));
	assert.deepEqual(Object.keys(lock.modules), ['one', 'two']);
});

test('install refuses to replace a module that is a git checkout', async () => {
	const src = await source('dev');
	await install([src], () => {});
	await mkdir(path.join(home, 'data', 'host', 'modules', 'dev', '.git'));
	await writeFile(path.join(home, 'data', 'host', 'modules', 'dev', 'work.txt'), 'mine');
	await assert.rejects(install([src], () => {}), /modules\/dev is a git checkout/);
	assert.equal(await readFile(path.join(home, 'data', 'host', 'modules', 'dev', 'work.txt'), 'utf8'), 'mine');
});
