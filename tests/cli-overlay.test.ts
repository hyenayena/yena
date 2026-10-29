import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src/cli.ts');

const HEADLESS = `export default async (yena, req) => {
	for (const name of req.args) await yena.commands.find(c => c.name === name).run([], {print: l => console.log(l)});
};`;
const kit = (origin: string) => `const g = globalThis as {__kitLoads?: number};
g.__kitLoads = (g.__kitLoads ?? 0) + 1;
export const kitOrigin: string = '${origin}';
`;
const plugin = (command: string, body: string) => `import {kitOrigin} from '../../core/src/kit.js';
${body}
export default () => [{name: '${command}', run: async (_args: string[], ctx: {print(line: string): void}) => ctx.print(${'`'}${command} sees \${kitOrigin}${'`'} + extra())}];
`;

async function files(dir: string, entries: Record<string, string>) {
	for (const [rel, text] of Object.entries(entries)) {
		await mkdir(path.dirname(path.join(dir, rel)), {recursive: true});
		await writeFile(path.join(dir, rel), text);
	}
}
const manifest = (name: string, version: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({name, version, runtime: 'node', entry: name === 'core' ? 'index.mjs' : 'src/index.ts', ...extra});
const core = (version: string, origin: string) => ({
	'yena.json': manifest('core', version, {headless: 'headless.mjs'}),
	'index.mjs': 'export default () => {};',
	'headless.mjs': HEADLESS,
	'src/kit.ts': kit(origin),
});

async function makeHome() {
	const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-cli-overlay-')));
	const data = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-cli-overlay-data-')));
	const overlay = path.join(data, 'host', 'modules');
	await files(path.join(home, 'node_modules', 'fakepkg'), {
		'package.json': JSON.stringify({name: 'fakepkg', type: 'module', exports: './index.js'}),
		'index.js': `export const where = 'host node_modules';`,
	});
	await files(path.join(home, 'modules', 'core'), core('1.0.0', 'image'));
	await files(path.join(home, 'modules', 'imgmod'), {
		'yena.json': manifest('imgmod', '1.0.0'),
		'src/index.ts': plugin('img', `const extra = () => '';`),
	});
	await files(path.join(overlay, 'ovmod'), {
		'yena.json': manifest('ovmod', '1.0.0'),
		'package.json': JSON.stringify({type: 'module'}),
		'src/index.ts': plugin(
			'ov',
			`import {where} from 'fakepkg';
const extra = () => ', ' + where + ', kit loads ' + (globalThis as {__kitLoads?: number}).__kitLoads;`,
		),
	});
	return {home, data, overlay};
}

function run({home, data}: {home: string; data: string}, args: string[]) {
	const env: NodeJS.ProcessEnv = {...process.env, YENA_HOME: home, YENA_DATA: data, YENA_LOG: 'off'};
	const r = spawnSync(process.execPath, ['--import', 'tsx', cli, '--run', '--', ...args], {env, encoding: 'utf8', cwd: repo, timeout: 60_000});
	return {status: r.status, stdout: r.stdout, stderr: r.stderr};
}

test('an overlay module reaches image core by its relative import, once, and bare packages from the host', async () => {
	const h = await makeHome();
	const r = run(h, ['img', 'ov']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, 'img sees image\nov sees image, host node_modules, kit loads 1\n');
});

test('a newer overlay core is the one image modules import', async () => {
	const h = await makeHome();
	await files(path.join(h.overlay, 'core'), core('1.1.0', 'overlay'));
	const r = run(h, ['img', 'ov']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, 'img sees overlay\nov sees overlay, host node_modules, kit loads 1\n');
});

test('an older overlay core is skipped with a warning', async () => {
	const h = await makeHome();
	await files(path.join(h.overlay, 'core'), core('0.9.0', 'overlay'));
	const r = run(h, ['img']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, 'img sees image\n');
	assert.equal(r.stderr, 'Warning: overlay module core 0.9.0 skipped: the image has 1.0.0\n');
});
