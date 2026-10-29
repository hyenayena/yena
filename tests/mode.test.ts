import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {CommandContext} from '../src/api.js';
import {checkDevRoot, DEFAULT_DEV_ROOT, readMode, runningMode, writeMode} from '../src/mode.js';
import {createModeCommand} from '../src/mode-command.js';

const temp = async (prefix: string) => realpath(await mkdtemp(path.join(tmpdir(), prefix)));

async function devRoot(): Promise<string> {
	const dir = await temp('yena-devroot-');
	await mkdir(path.join(dir, 'src'), {recursive: true});
	await writeFile(path.join(dir, 'src', 'cli.ts'), '');
	await mkdir(path.join(dir, 'node_modules'));
	await mkdir(path.join(dir, 'modules', 'core'), {recursive: true});
	return dir;
}

test('readMode: a missing or broken file means the image at the default dev root', async () => {
	const dir = await temp('yena-mode-');
	assert.deepEqual(await readMode(dir), {mode: 'image', devRoot: DEFAULT_DEV_ROOT});
	await writeFile(path.join(dir, 'mode.json'), '{nope');
	assert.deepEqual(await readMode(dir), {mode: 'image', devRoot: DEFAULT_DEV_ROOT});
	await writeFile(path.join(dir, 'mode.json'), JSON.stringify({mode: 'weird', devRoot: 'relative'}));
	assert.deepEqual(await readMode(dir), {mode: 'image', devRoot: DEFAULT_DEV_ROOT});
});

test('writeMode then readMode round-trips and creates the state dir', async () => {
	const dir = path.join(await temp('yena-mode-'), 'host');
	await writeMode(dir, {mode: 'dev', devRoot: '/w/yena'});
	assert.deepEqual(await readMode(dir), {mode: 'dev', devRoot: '/w/yena'});
});

test('checkDevRoot names what is missing', async () => {
	const ok = await devRoot();
	await checkDevRoot(ok);
	const empty = await temp('yena-devroot-');
	await assert.rejects(checkDevRoot(empty), /cannot run yena: missing src\/cli\.ts, node_modules, modules\/core/);
	await assert.rejects(checkDevRoot('rel/path'), /absolute path/);
});

test('runningMode is dev only when the code root is the dev root', () => {
	assert.equal(runningMode('/workplace/yena/', {mode: 'image', devRoot: '/workplace/yena'}), 'dev');
	assert.equal(runningMode('/app', {mode: 'dev', devRoot: '/workplace/yena'}), 'image');
});

function ctx() {
	const lines: string[] = [];
	return {lines, ctx: {print: (l: string) => void lines.push(l)} as unknown as CommandContext};
}

test('mode dev validates, saves and says it takes effect on the next start; it persists', async () => {
	const state = await temp('yena-mode-');
	const dev = await devRoot();
	const cmd = await createModeCommand({stateDir: state, codeRoot: '/app', writable: true});
	const out = ctx();
	await cmd.run(['dev', dev], out.ctx);
	assert.deepEqual(out.lines, [`Start from: dev (${dev}). Takes effect on the next start.`]);
	assert.deepEqual(JSON.parse(await readFile(path.join(state, 'mode.json'), 'utf8')), {mode: 'dev', devRoot: dev});

	const again = await createModeCommand({stateDir: state, codeRoot: '/app', writable: true});
	const shown = ctx();
	await again.run([], shown.ctx);
	assert.deepEqual(shown.lines, [`Start from: dev (${dev})`, 'Running now: image (/app)', 'Takes effect on the next start.']);
});

test('mode dev refuses a root that cannot start and keeps the old state', async () => {
	const state = await temp('yena-mode-');
	const cmd = await createModeCommand({stateDir: state, codeRoot: '/app', writable: true});
	const empty = await temp('yena-devroot-');
	await assert.rejects(async () => cmd.run(['dev', empty], ctx().ctx), /cannot run yena/);
	assert.equal((await readMode(state)).mode, 'image');
});

test('without YENA_DATA the mode cannot be saved', async () => {
	const cmd = await createModeCommand({stateDir: await temp('yena-mode-'), codeRoot: '/app', writable: false});
	await assert.rejects(async () => cmd.run(['image'], ctx().ctx), /needs YENA_DATA/);
});

test('the settings tab reads and saves the same state, and tells the running mode', async () => {
	const state = await temp('yena-mode-');
	const dev = await devRoot();
	await writeMode(state, {mode: 'image', devRoot: dev});
	const cmd = await createModeCommand({stateDir: state, codeRoot: dev, writable: true});
	const setting = cmd.settings!.settings[0]!;
	assert.equal(cmd.settings!.title, 'Yena');
	assert.equal(await setting.get(), 'image');
	assert.match(setting.description ?? '', new RegExp(`next start\\. Running now: dev, ${dev}`));
	await setting.set('dev');
	assert.equal(await cmd.settings!.settings[0]!.get(), 'dev');
	assert.equal((await readMode(state)).mode, 'dev');
	const done = ctx();
	await cmd.run(['image'], done.ctx);
	assert.deepEqual(done.lines, ['Start from: image. Takes effect on the next start.']);
});

test('agent policy: show is safe, switching asks', async () => {
	const cmd = await createModeCommand({stateDir: await temp('yena-mode-'), codeRoot: '/app', writable: true});
	const policy = Object.fromEntries((cmd.subcommands ?? []).map(s => [s.name, s.agent]));
	assert.deepEqual(policy, {show: 'safe', image: 'confirm', dev: 'confirm'});
	assert.equal(cmd.agent, 'confirm');
});

test('mode help goes to core through ctx.showHelp, or prints the usage without it', async () => {
	const cmd = await createModeCommand({stateDir: await temp('yena-mode-'), codeRoot: '/app', writable: true});
	const paths: (string[] | undefined)[] = [];
	const {ctx: base} = ctx();
	await cmd.run(['help'], {...base, showHelp: (path?: string[]) => void paths.push(path)});
	assert.deepEqual(paths, [undefined]);
	const plain = ctx();
	await cmd.run(['help'], plain.ctx);
	assert.deepEqual(plain.lines, ['mode [subcommand]']);
});
