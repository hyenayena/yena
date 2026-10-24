#!/usr/bin/env node
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {register} from 'tsx/esm/api';
import type {HeadlessMain, Logger, ModuleMain} from './api.js';
import {createEventBus} from './events.js';
import {createHostLogger, installProcessHooks, setHostLog} from './log/index.js';
import {terminalText} from './log/sanitize.js';
import {modCommand} from './pm/command.js';
import {install, installedModules, moduleDataDir, modulesDir, root} from './pm/manager.js';
import {readManifest, type Manifest} from './pm/manifest.js';
import {resolveInside} from './pm/paths.js';
import {loadPlugins} from './pm/plugins.js';

const CORE = 'core';
const CORE_SOURCE = 'git@github.com:hyenayena/core.git';

register();

const exists = (p: string) =>
	stat(p).then(
		() => true,
		() => false,
	);

const argv = process.argv.slice(2);
const runMode = argv[0] === '--run';
const runArgs = argv[1] === '--' ? argv.slice(2) : argv.slice(1);
const catalogMode = argv[0] === '--catalog';
const oneShot = runMode || catalogMode;

async function ensureCore(dir: string, logger: Logger) {
	if (await exists(dir)) return;
	if (catalogMode) throw new Error(`${CORE} is not installed`);
	const print = (line: string) => (oneShot ? console.error(line) : console.log(line));
	logger.info('core missing, installing');
	print('core is not installed, downloading…');
	await install([], print);
	if (!(await exists(dir))) await install([CORE_SOURCE], print);
}

const logger = createHostLogger({root, env: process.env});
setHostLog(logger);
installProcessHooks(logger);

async function main() {
	logger.info('start', {
		version: process.env.npm_package_version,
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		cwd: process.cwd(),
		hasYenaHome: process.env.YENA_HOME !== undefined,
		hasYenaData: process.env.YENA_DATA !== undefined,
		tty: Boolean(process.stdout.isTTY),
	});
	if (catalogMode && argv.length > 1) {
		throw Object.assign(new Error('--catalog takes no arguments'), {exitCode: 2});
	}
	const dir = path.join(modulesDir, CORE);
	await ensureCore(dir, logger);

	const manifest = await readManifest(dir);
	if (oneShot) return runHeadless(dir, manifest);
	if (!manifest.entry) throw new Error(`${CORE}/yena.json has no "entry"`);
	const entry = await resolveInside(dir, manifest.entry, 'entry');

	const mod = (await import(pathToFileURL(entry).href)) as {default?: ModuleMain};
	if (typeof mod.default !== 'function') throw new Error(`${manifest.entry} must export a default function`);

	const events = createEventBus();
	const modules = await installedModules();
	logger.info('modules discovered', {
		modules: modules.map(m => ({name: m.manifest.name, version: m.manifest.version, runtime: m.manifest.runtime})),
	});
	const plugins = await loadPlugins({
		modules,
		host: {commands: [modCommand]},
		events,
		dataDirFor: moduleDataDir,
		log: line => console.warn(`Warning: ${line}`),
		logger,
	});
	logger.info('core loaded', {module: manifest.name, version: manifest.version});
	await mod.default({
		commands: [modCommand, ...plugins],
		dataDir: await moduleDataDir(manifest.name),
		events,
		log: logger.child('core'),
	});
}

async function runHeadless(dir: string, manifest: Manifest) {
	if (!manifest.headless) {
		throw new Error(`${CORE} ${manifest.version} cannot run commands from the terminal; update it with: mod update ${CORE}`);
	}
	const file = await resolveInside(dir, manifest.headless, 'headless');
	const mod = (await import(pathToFileURL(file).href)) as {default?: HeadlessMain};
	if (typeof mod.default !== 'function') throw new Error(`${manifest.headless} must export a default function`);

	const events = createEventBus();
	const modules = await installedModules();
	const plugins = await loadPlugins({
		modules,
		host: {commands: [modCommand]},
		events,
		dataDirFor: moduleDataDir,
		log: line => console.warn(`Warning: ${line}`),
		logger,
	});
	const started = Date.now();
	let status = 'ok';
	try {
		await mod.default(
			{
				commands: [modCommand, ...plugins],
				dataDir: await moduleDataDir(manifest.name),
				events,
				log: logger.child('core'),
			},
			catalogMode ? {args: [], catalog: true} : {args: runArgs},
		);
	} catch (error) {
		status = 'error';
		throw error;
	} finally {
		logger.info('headless run', {ms: Date.now() - started, status});
	}
}

// Plugins may leave timers or sockets open, so a one-shot run ends with an explicit exit.
const finish = (code: number) => {
	process.stdout.write('', () => process.exit(code));
};

main().then(
	() => {
		if (oneShot) finish(0);
	},
	error => {
		logger.error('fatal', {err: error});
		const raw = error instanceof Error ? error.message : String(error);
		const shown = terminalText(raw, 4 * 1024).split('\n').slice(0, 21);
		console.error(`Error: ${shown.join('\n')}`);
		const code = (error as {exitCode?: unknown} | null)?.exitCode === 2 ? 2 : 1;
		if (oneShot) finish(code);
		else process.exitCode = 1;
	},
);
