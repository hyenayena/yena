import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-bake-')));
process.env.YENA_HOME = home;
delete process.env.YENA_DATA;
const {bakeModules, readImageRecord} = await import('../../src/pm/bake.js');

async function writeModule(dir: string, manifest: Record<string, unknown>) {
	await mkdir(dir, {recursive: true});
	await writeFile(path.join(dir, 'yena.json'), JSON.stringify(manifest));
}

test('local copies run their install scripts, locked modules missing from the context are fetched, the record lists both', async () => {
	await writeModule(path.join(home, 'modules', 'core'), {name: 'core', version: '1.0.0'});
	await writeModule(path.join(home, 'modules', 'local'), {name: 'local', version: '0.2.0', install: 'touch installed'});
	const src = path.join(home, 'src-remote');
	await writeModule(src, {name: 'remote', version: '0.3.0', install: 'touch installed'});
	await writeFile(path.join(home, 'yena-modules.json'), JSON.stringify({modules: {remote: {source: src, version: '0.3.0'}}}));

	const lines: string[] = [];
	const record = await bakeModules(l => void lines.push(l));
	assert.ok(existsSync(path.join(home, 'modules', 'local', 'installed')));
	assert.ok(existsSync(path.join(home, 'modules', 'remote', 'installed')));
	assert.deepEqual(
		record.modules.map(m => [m.name, m.version, m.from]),
		[['core', '1.0.0', 'local'], ['local', '0.2.0', 'local'], ['remote', '0.3.0', 'lock']],
	);
	assert.equal(record.modules.find(m => m.name === 'remote')?.source, src);
	assert.deepEqual(await readImageRecord(home), JSON.parse(await readFile(path.join(home, 'yena-image.json'), 'utf8')));
});

test('a missing or broken record reads as none', async () => {
	assert.equal(await readImageRecord(await realpath(await mkdtemp(path.join(tmpdir(), 'yena-bake-none-')))), undefined);
});
