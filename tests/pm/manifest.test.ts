import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {readManifest} from '../../src/pm/manifest.js';

async function manifestWith(extra: Record<string, unknown>) {
	const dir = await mkdtemp(path.join(tmpdir(), 'yena-manifest-'));
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify({name: 'm', version: '1.0.0', ...extra}));
	return dir;
}

test('headless is optional and read as a string', async () => {
	assert.equal((await readManifest(await manifestWith({}))).headless, undefined);
	assert.equal((await readManifest(await manifestWith({headless: 'src/headless.ts'}))).headless, 'src/headless.ts');
});

test('a non-string headless is rejected', async () => {
	await assert.rejects(readManifest(await manifestWith({headless: 3})), /"headless" must be a string/);
});

test('the name "host" is reserved for the host state directory', async () => {
	await assert.rejects(readManifest(await manifestWith({name: 'host'})), /"name" "host" is reserved by yena/);
});

test('credentials default to none and keep a valid declaration', async () => {
	assert.deepEqual((await readManifest(await manifestWith({}))).credentials, {});
	const declared = {claude: 'write', github: 'read', 'my_kind-2': 'read'};
	assert.deepEqual((await readManifest(await manifestWith({credentials: declared}))).credentials, declared);
});

test('invalid credentials declarations are rejected', async () => {
	await assert.rejects(readManifest(await manifestWith({credentials: ['github']})), /"credentials" must be an object/);
	await assert.rejects(readManifest(await manifestWith({credentials: 'github'})), /"credentials" must be an object/);
	await assert.rejects(readManifest(await manifestWith({credentials: {github: 'admin'}})), /yena\.json: invalid credentials "github"/);
	await assert.rejects(readManifest(await manifestWith({credentials: {GitHub: 'read'}})), /invalid credentials "GitHub"/);
	await assert.rejects(readManifest(await manifestWith({credentials: {_x: 'read'}})), /invalid credentials "_x"/);
	await assert.rejects(readManifest(await manifestWith({credentials: {['k'.repeat(33)]: 'read'}})), /invalid credentials/);
	const many = Object.fromEntries(Array.from({length: 21}, (_, i) => [`k${i}`, 'read']));
	await assert.rejects(readManifest(await manifestWith({credentials: many})), /more than 20 kinds/);
	const twenty = Object.fromEntries(Array.from({length: 20}, (_, i) => [`k${i}`, 'read']));
	assert.equal(Object.keys((await readManifest(await manifestWith({credentials: twenty}))).credentials ?? {}).length, 20);
});
