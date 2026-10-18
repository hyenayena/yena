#!/usr/bin/env node
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {register} from 'tsx/esm/api';
import type {Logger, ModuleMain} from './api.js';
import {createEventBus} from './events.js';
import {createHostLogger, installProcessHooks, setHostLog} from './log/index.js';
import {modCommand} from './pm/command.js';
import {install, installedModules, moduleDataDir, modulesDir, root} from './pm/manager.js';
import {readManifest} from './pm/manifest.js';
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

async function ensureCore(dir: string, logger: Logger) {
	if (await exists(dir)) return;
	const print = (line: string) => console.log(line);
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
	const dir = path.join(modulesDir, CORE);
	await ensureCore(dir, logger);

	const manifest = await readManifest(dir);
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

main().catch(error => {
	logger.error('fatal', {err: error});
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
