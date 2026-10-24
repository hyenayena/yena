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
