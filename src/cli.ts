#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {register} from 'tsx/esm/api';
import type {BuildInfo, HeadlessMain, Logger, ModuleMain, StartupAlert} from './api.js';
import {clearDevFailure, devLaunchTarget, publicDevFailure, errorFailure, isDevChild, reportReady, resetTerminal, runDevChild, writeDevFailure} from './dev-launch.js';
import {createEventBus} from './events.js';
import {createHostLogger, installProcessHooks, setHostLog} from './log/index.js';
import {terminalText} from './log/sanitize.js';
import {readMode, runningMode} from './mode.js';
import {createModeCommand} from './mode-command.js';
import {modCommand} from './pm/command.js';
import {install, moduleDataDir, modulesDir, overlayDir, resolveModules, root, stateDir, type ResolvedModule} from './pm/manager.js';
import type {Manifest} from './pm/manifest.js';
import {registerModuleHooks} from './pm/module-hooks.js';
import {resolveInside} from './pm/paths.js';
import {loadPlugins} from './pm/plugins.js';

const CORE = 'core';

register();

const argv = process.argv.slice(2);
const runMode = argv[0] === '--run';
const runArgs = argv[1] === '--' ? argv.slice(2) : argv.slice(1);
const catalogMode = argv[0] === '--catalog';
const oneShot = runMode || catalogMode;

const findCore = (modules: ResolvedModule[]) => modules.find(m => m.manifest.name === CORE);

/** Core comes from the image; when it is missing it is installed (into the overlay with `YENA_DATA`). */
async function ensureCore(logger: Logger): Promise<ResolvedModule[]> {
	let {modules, skipped} = await resolveModules();
	if (!findCore(modules)) {
		if (catalogMode) throw new Error(`${CORE} is not installed`);
		const print = (line: string) => (oneShot ? console.error(line) : console.log(line));
		logger.info('core missing, installing');
		print('core is not installed, downloading…');
		await install([], print);
		({modules, skipped} = await resolveModules());
		if (!findCore(modules)) {
			await install([CORE], print);
			({modules, skipped} = await resolveModules());
		}
	}
	for (const m of skipped) {
		logger.warn('overlay module skipped', {module: m.name, version: m.version, imageVersion: m.imageVersion});
		console.warn(`Warning: overlay module ${m.name} ${m.version} skipped: the image has ${m.imageVersion}`);
	}
	registerModuleHooks({
		roots: overlayDir === undefined ? [modulesDir] : [modulesDir, overlayDir],
		winners: new Map(modules.map(m => [m.manifest.name, m.dir])),
		hostRoot: root,
		...(overlayDir !== undefined && {overlay: overlayDir}),
	});
	return modules;
}

// package.json sits one level above both src/cli.ts and dist/cli.js.
async function hostVersion(): Promise<string> {
	try {
		const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {version?: unknown};
		return typeof pkg.version === 'string' ? pkg.version : 'unknown';
	} catch {
		return 'unknown';
	}
}

async function rootInfo(): Promise<NonNullable<BuildInfo['root']>> {
	const state = await readMode(stateDir);
	return {mode: runningMode(root, state), path: root, workCopy: state.devRoot};
}

async function buildInfo(modules: {manifest: Manifest}[]): Promise<BuildInfo> {
	return {
		version: await hostVersion(),
		root: await rootInfo(),
		modules: modules
			.map(m => ({name: m.manifest.name, version: m.manifest.version}))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
	};
}

const logger = createHostLogger({root: stateDir, env: process.env});
const hostCommands = [modCommand, await createModeCommand({stateDir, codeRoot: root, writable: process.env.YENA_DATA !== undefined})];
setHostLog(logger);
installProcessHooks(logger);

// The host owns this path; modules (the claude policy) learn it here instead of building it.
if (process.env.YENA_DATA) process.env.YENA_HOST_STATE = stateDir;

// The marker is inherited by everything the dev child starts; only the launcher's direct child has its IPC channel.
const devChild = isDevChild(process.env) && process.send !== undefined;
let ready = false;
/** In a dev child: the start went through, so the launcher will not fall back and the old failure goes. */
async function markReady() {
	if (!devChild || ready) return;
	ready = true;
	await clearDevFailure(stateDir).catch(() => {});
	reportReady();
}

const alerts: StartupAlert[] = [];
const devRoot = devLaunchTarget(process.env, root, await readMode(stateDir));
if (devRoot !== undefined) {
	logger.info('dev start', {devRoot});
	const outcome = await runDevChild({devRoot, args: argv, env: process.env, stateDir});
	if (outcome.kind === 'done') {
		logger.info('dev run ended', {code: outcome.code});
		process.exit(outcome.code);
	}
	resetTerminal();
	logger.warn('dev start failed, running the image', {devRoot});
	const reason = terminalText(outcome.reason, 300).split('\n')[0];
	console.error(`Warning: dev mode: ${devRoot} failed to start (${reason}); running the image`);
	alerts.push({text: `Dev mode: ${devRoot} failed to start, running the image. Run fix to repair it.`, detail: reason});
}

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
	const modules = await ensureCore(logger);
	const {dir, manifest} = findCore(modules) as ResolvedModule;
	if (oneShot) return runHeadless(dir, manifest, modules);
	if (!manifest.entry) throw new Error(`${CORE}/yena.json has no "entry"`);
	const entry = await resolveInside(dir, manifest.entry, 'entry');

	const mod = (await import(pathToFileURL(entry).href)) as {default?: ModuleMain};
	if (typeof mod.default !== 'function') throw new Error(`${manifest.entry} must export a default function`);

	const events = createEventBus();
	logger.info('modules discovered', {
		modules: modules.map(m => ({name: m.manifest.name, version: m.manifest.version, runtime: m.manifest.runtime, origin: m.origin})),
	});
	const plugins = await loadPlugins({
		modules,
		host: {commands: hostCommands},
		events,
		dataDirFor: moduleDataDir,
		log: line => console.warn(`Warning: ${line}`),
		logger,
		build: await buildInfo(modules),
		devFailure: () => publicDevFailure(stateDir),
	});
	logger.info('core loaded', {module: manifest.name, version: manifest.version});
	await mod.default({
		commands: [...hostCommands, ...plugins],
		dataDir: await moduleDataDir(manifest.name),
		events,
		log: logger.child('core'),
		...(alerts.length > 0 && {alerts}),
	});
	// Core's main returns once the first frame is drawn.
	await markReady();
}

async function runHeadless(dir: string, manifest: Manifest, modules: ResolvedModule[]) {
	if (!manifest.headless) {
		throw new Error(`${CORE} ${manifest.version} cannot run commands from the terminal; update it with: mod update ${CORE}`);
	}
	const file = await resolveInside(dir, manifest.headless, 'headless');
	const mod = (await import(pathToFileURL(file).href)) as {default?: HeadlessMain};
	if (typeof mod.default !== 'function') throw new Error(`${manifest.headless} must export a default function`);

	const events = createEventBus();
	const plugins = await loadPlugins({
		modules,
		host: {commands: hostCommands},
		events,
		dataDirFor: moduleDataDir,
		log: line => console.warn(`Warning: ${line}`),
		logger,
		build: await buildInfo(modules),
		devFailure: () => publicDevFailure(stateDir),
	});
	const started = Date.now();
	let status = 'ok';
	await markReady();
	try {
		await mod.default(
			{
				commands: [...hostCommands, ...plugins],
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
	async error => {
		logger.error('fatal', {err: error});
		if (devChild && !ready) await writeDevFailure(stateDir, {devRoot: root, pid: process.pid, ...errorFailure(error)}).catch(() => {});
		const raw = error instanceof Error ? error.message : String(error);
		const shown = terminalText(raw, 4 * 1024).split('\n').slice(0, 21);
		console.error(`Error: ${shown.join('\n')}`);
		const code = (error as {exitCode?: unknown} | null)?.exitCode === 2 ? 2 : 1;
		// An unready dev child still holds the IPC channel open, so it would not end by itself.
		if (oneShot || (devChild && !ready)) finish(code);
		else process.exitCode = 1;
	},
);
