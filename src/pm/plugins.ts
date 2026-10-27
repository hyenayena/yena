import {pathToFileURL} from 'node:url';
import type {BuildInfo, Command, EventBus, GitSshResolver, Logger, ModulePlugin} from '../api.js';
import {noopLogger} from '../log/index.js';
import {registerGitSsh} from './git-ssh.js';
import type {Manifest} from './manifest.js';
import {resolveInside} from './paths.js';

export type LoadPluginsOptions = {
	modules: {dir: string; manifest: Manifest}[];
	host: {commands: Command[]};
	events: EventBus;
	dataDirFor: (name: string) => Promise<string>;
	log: (line: string) => void;
	logger?: Logger;
	build?: BuildInfo;
	importer?: (url: string) => Promise<unknown>;
	timeoutMs?: number;
};

const CORE = 'core';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const names = (commands: Command[]) => commands.map(c => c.name);

function validate(result: unknown): Command[] {
	if (!Array.isArray(result)) throw new Error('plugin must return an array of commands');
	const seen = new Set<string>();
	for (const item of result as Partial<Command>[]) {
		if (!item || typeof item.name !== 'string' || item.name === '' || typeof item.run !== 'function') {
			throw new Error('plugin returned an invalid command');
		}
		if (seen.has(item.name)) throw new Error(`duplicate command "${item.name}"`);
		seen.add(item.name);
	}
	return result as Command[];
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<Command[]> {
	const importer = opts.importer ?? ((url: string) => import(url));
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const taken = new Set(opts.host.commands.map(c => c.name));
	const accepted: Command[] = [];
	const logger = opts.logger ?? noopLogger;

	const candidates = opts.modules
		.filter(m => m.manifest.name !== CORE && m.manifest.runtime === 'node' && m.manifest.entry)
		.sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : a.manifest.name > b.manifest.name ? 1 : 0));

	for (const {dir, manifest} of candidates) {
		const started = Date.now();
		try {
			if (/[\\/]/.test(manifest.name)) throw new Error('invalid module name');
			const file = await resolveInside(dir, manifest.entry as string, 'entry');
			const mod = (await importer(pathToFileURL(file).href)) as {default?: ModulePlugin};
			if (typeof mod.default !== 'function') throw new Error(`${manifest.entry} must export a default function`);
			const plugin = mod.default;
			const host = {
				dataDir: await opts.dataDirFor(manifest.name),
				events: opts.events,
				log: logger.child(manifest.name),
				...(opts.build && {build: opts.build}),
				registerGitSsh: (resolve: GitSshResolver) => {
					if (!registerGitSsh(resolve)) logger.warn('git ssh resolver ignored', {module: manifest.name});
				},
			};
			const commands = validate(await withTimeout(Promise.resolve().then(() => plugin(host)), timeoutMs));
			for (const c of commands) {
				if (taken.has(c.name)) throw new Error(`command "${c.name}" is already defined`);
			}
			for (const c of commands) taken.add(c.name);
			accepted.push(...commands);
			logger.info('plugin loaded', {module: manifest.name, commands: names(commands), ms: Date.now() - started});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logger.warn('plugin skipped', {module: manifest.name, reason});
			opts.log(`plugin "${manifest.name}" skipped: ${reason}`);
		}
	}
	return accepted;
}
