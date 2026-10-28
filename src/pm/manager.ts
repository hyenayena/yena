import {randomUUID} from 'node:crypto';
import {cp, mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {hostLog} from '../log/index.js';
import {readManifest, RESERVED_NAMES, type Manifest} from './manifest.js';
import {gitSshFor} from './git-ssh.js';
import {compareVersions, pickCopy, type Copy, type ModuleOrigin} from './overlay.js';
import {run, type Log} from './run.js';
import {officialModuleName, parseSource, type Source} from './source.js';

export const root = process.env.YENA_HOME ?? process.cwd();
/** The image's modules (read-only in the image; the only, writable source without `YENA_DATA`). */
export const modulesDir = path.join(root, 'modules');
export const dataDir = process.env.YENA_DATA ?? path.join(root, '.yena');
export const stateDir = hostStateDir(process.env, root);
/**
 * Modules installed at runtime (`mod install|update`); they shadow image modules of the same or an older
 * version. A dev run (`YENA_DEV_CHILD`, see `src/dev-launch.ts`) takes modules only from its working copy.
 */
export const overlayDir: string | undefined =
	process.env.YENA_DATA && process.env.YENA_DEV_CHILD !== '1' ? path.join(stateDir, 'modules') : undefined;

/**
 * The host's runtime state (logs, the module overlay). The code root is read-only in the image, so with
 * `YENA_DATA` set nothing goes under it; bare runs without `YENA_DATA` keep the state in the root.
 */
export function hostStateDir(env: NodeJS.ProcessEnv, codeRoot: string): string {
	return env.YENA_DATA ? path.join(env.YENA_DATA, 'host') : codeRoot;
}

export async function moduleDataDir(name: string): Promise<string> {
	if (RESERVED_NAMES.has(name)) throw new Error(`Module name "${name}" is reserved by yena`);
	const dir = path.join(dataDir, name);
	await mkdir(dir, {recursive: true});
	return dir;
}
const pmLog = () => hostLog().child('pm');
const LOCK_FILE = 'yena-modules.json';
const imageLockPath = path.join(root, LOCK_FILE);
const installDir = overlayDir ?? modulesDir;
const installLockPath = overlayDir === undefined ? imageLockPath : path.join(stateDir, LOCK_FILE);

type LockEntry = {
	source: string;
	version: string;
	commit?: string;
	/** The account whose key fetched it (a private module); restores and updates use it again. */
	account?: string;
};

type Lock = {modules: Record<string, LockEntry>};

async function readLock(file: string): Promise<Lock> {
	try {
		const data = JSON.parse(await readFile(file, 'utf8')) as Partial<Lock>;
		return {modules: data.modules ?? {}};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {modules: {}};
		throw new Error(`Failed to read ${path.basename(file)}: ${(error as Error).message}`);
	}
}

async function writeLock(lock: Lock) {
	const sorted = Object.fromEntries(Object.entries(lock.modules).sort(([a], [b]) => a.localeCompare(b)));
	await mkdir(path.dirname(installLockPath), {recursive: true});
	await writeFile(installLockPath, JSON.stringify({modules: sorted}, null, '\t') + '\n');
}

const imageLock = async (): Promise<Lock> => (overlayDir === undefined ? {modules: {}} : readLock(imageLockPath));

async function exists(p: string) {
	return stat(p).then(
		() => true,
		() => false,
	);
}

const inside = (dir: string, p: string) => !path.relative(dir, p).startsWith('..');

async function fetchSource(src: Source, dest: string, log: Log, account?: string): Promise<string | undefined> {
	if (src.kind === 'path') {
		if (!(await exists(src.path))) throw new Error(`Folder ${src.path} does not exist`);
		if (inside(modulesDir, src.path) || inside(installDir, src.path)) {
			throw new Error('Cannot install a module from the modules/ folder itself');
		}
		const skip = new Set(['.git', 'node_modules', '.venv']);
		await cp(src.path, dest, {recursive: true, filter: p => !skip.has(path.basename(p))});
		return undefined;
	}

	// init + fetch works the same for a branch, a tag or a commit hash
	await mkdir(dest, {recursive: true});
	const trace = pmLog();
	await run('git', ['init', '-q'], {cwd: dest, trace});
	const env = account === undefined ? undefined : {GIT_SSH_COMMAND: await gitSshFor(account)};
	await run('git', ['fetch', '-q', '--depth', '1', src.url, src.ref ?? 'HEAD'], {cwd: dest, log, trace, scrubEnv: true, ...(env && {env})});
	await run('git', ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], {cwd: dest, trace});
	const commit = (await run('git', ['rev-parse', 'HEAD'], {cwd: dest, trace})).trim();
	await rm(path.join(dest, '.git'), {recursive: true, force: true});
	return commit;
}

type Session = {
	/** The lock of the folder installs go to (the overlay's, or the root's without `YENA_DATA`). */
	lock: Lock;
	/** The image's lock with an overlay; empty without one (then `lock` is the image's). */
	image: Lock;
	log: Log;
	seen: Set<string>;
};

const lockEntry = (s: Session, name: string) => s.lock.modules[name] ?? s.image.modules[name];

/** Installed in either source. */
async function present(name: string): Promise<boolean> {
	return (await exists(path.join(installDir, name))) || (await exists(path.join(modulesDir, name)));
}

type InstallOneOptions = {
	pinCommit?: string;
	account?: string;
	/** The commit of the copy in use: when the fetch gives the same commit, nothing is installed. */
	current?: string;
};

/** Dependencies are fetched with the account of the module that needs them, unless the lock names another. */
async function installOne(spec: string, s: Session, {pinCommit, account, current}: InstallOneOptions = {}): Promise<Manifest> {
	const trace = pmLog();
	const src = parseSource(spec, root, {ssh: account !== undefined});
	if (pinCommit && src.kind === 'git') src.ref = pinCommit;

	await mkdir(installDir, {recursive: true});
	const staging = path.join(installDir, `.staging-${randomUUID()}`);
	const backup = path.join(installDir, `.backup-${randomUUID()}`);

	try {
		s.log(`↓ ${spec}${pinCommit ? ` @ ${pinCommit.slice(0, 7)}` : ''}`);
		trace.info('install started', {spec, kind: src.kind, pinned: pinCommit?.slice(0, 7), account: account !== undefined});
		const commit = await fetchSource(src, staging, s.log, account);
		const manifest = await readManifest(staging);
		trace.info('fetched', {module: manifest.name, version: manifest.version, commit: commit?.slice(0, 7)});
		s.seen.add(manifest.name);
		if (current !== undefined && commit === current) {
			s.log(`  (no changes)`);
			trace.info('unchanged', {module: manifest.name});
			return manifest;
		}

		// Dependencies first, so the module's install script can rely on them
		for (const [dep, depSpec] of Object.entries(manifest.dependencies)) {
			if (s.seen.has(dep) || (await present(dep))) continue;
			trace.info('installing dependency', {module: manifest.name, dependency: dep});
			const entry = lockEntry(s, dep);
			const installed = await installOne(depSpec, s, {pinCommit: entry?.commit, account: entry?.account ?? account});
			if (installed.name !== dep) {
				throw new Error(`Dependency "${dep}" is actually named "${installed.name}"`);
			}
		}

		// Keep the old version as a backup until the install script passes
		const target = path.join(installDir, manifest.name);
		// A module directory with its own .git is a working copy someone develops in; replacing it would lose their work
		if (await exists(path.join(target, '.git'))) {
			throw new Error(`modules/${manifest.name} is a git checkout; update it with git or remove it first`);
		}
		const hadOld = await exists(target);
		if (hadOld) await rename(target, backup);
		await rename(staging, target);
		trace.info('swapped into place', {module: manifest.name, replaced: hadOld});

		try {
			if (manifest.install) {
				s.log(`  $ ${manifest.install}`);
				const started = Date.now();
				trace.info('install script started', {module: manifest.name});
				try {
					await run(manifest.install, [], {cwd: target, shell: true, log: s.log, trace, scrubEnv: true});
				} finally {
					trace.info('install script finished', {module: manifest.name, ms: Date.now() - started});
				}
			}
		} catch (error) {
			trace.warn('rolling back', {module: manifest.name, restored: hadOld, err: error});
			await rm(target, {recursive: true, force: true});
			if (hadOld) await rename(backup, target);
			throw error;
		}

		s.lock.modules[manifest.name] = {source: spec, version: manifest.version, commit, ...(account !== undefined && {account})};
		await writeLock(s.lock);
		trace.info('lock written', {module: manifest.name});
		s.log(`✓ ${manifest.name}@${manifest.version}`);
		trace.info('install finished', {module: manifest.name, version: manifest.version});
		await warnIfShadowed(manifest, s.log);
		return manifest;
	} catch (error) {
		trace.error('install failed', {spec, err: error});
		throw error;
	} finally {
		await rm(staging, {recursive: true, force: true});
		await rm(backup, {recursive: true, force: true});
	}
}

async function warnIfShadowed(manifest: Manifest, log: Log) {
	if (overlayDir === undefined) return;
	const image = await readManifest(path.join(modulesDir, manifest.name)).catch(() => undefined);
	if (image && compareVersions(manifest.version, image.version) < 0) {
		log(`! The image has ${manifest.name} ${image.version}, newer than ${manifest.version}; the image copy stays in use`);
	}
}

async function session(log: Log): Promise<Session> {
	return {lock: await readLock(installLockPath), image: await imageLock(), log, seen: new Set()};
}

export type InstallOptions = {account?: string};

export async function install(specs: string[], log: Log, {account}: InstallOptions = {}) {
	const s = await session(log);
	const trace = pmLog();
	trace.info('install command started', {specs: specs.length});

	if (specs.length > 0) {
		for (const spec of new Set(specs)) {
			const name = officialModuleName(spec);
			if (name && s.seen.has(name)) continue;
			await installOne(spec, s, {account});
		}
		trace.info('install command finished', {specs: specs.length});
		return;
	}

	let restored = 0;
	for (const [name, entry] of Object.entries(s.lock.modules)) {
		if (s.seen.has(name) || (await exists(path.join(installDir, name)))) continue;
		await installOne(entry.source, s, {pinCommit: entry.commit, account: entry.account});
		restored++;
	}
	for (const {manifest} of await installedModules()) {
		for (const [dep, depSpec] of Object.entries(manifest.dependencies)) {
			if (s.seen.has(dep) || (await present(dep))) continue;
			const entry = lockEntry(s, dep);
			await installOne(depSpec, s, {pinCommit: entry?.commit, account: entry?.account});
			restored++;
		}
	}
	trace.info('install command finished', {specs: 0, restored});
	log(restored ? `Modules restored: ${restored}` : 'All modules are already installed');
}

/** Image modules are updated by installing the newer copy into the overlay. */
export async function update(names: string[], log: Log) {
	const s = await session(log);
	const known = {...s.image.modules, ...s.lock.modules};
	const targets = names.length > 0 ? names : Object.keys(known).sort();
	pmLog().info('update started', {specs: targets.length});
	if (targets.length === 0) return log('No modules installed');

	const inUse = new Map((await resolveModules()).modules.map(m => [m.manifest.name, m.origin]));
	for (const name of targets) {
		const entry = known[name];
		if (!entry) throw new Error(`Module "${name}" is not installed`);
		if (s.seen.has(name)) continue;
		const origin = inUse.get(name);
		const current = origin === undefined ? undefined : (origin === 'overlay' || overlayDir === undefined ? s.lock : s.image).modules[name]?.commit;
		await installOne(entry.source, s, {account: entry.account, ...(current !== undefined && {current})});
	}
	pmLog().info('update finished', {specs: targets.length});
}

export async function remove(names: string[], log: Log) {
	if (names.length === 0) throw new Error('Specify which modules to remove');
	const lock = await readLock(installLockPath);
	const image = await imageLock();
	pmLog().info('remove started', {specs: names.length, names});

	for (const name of names) {
		const dir = path.join(installDir, name);
		if (!lock.modules[name] && !(await exists(dir))) {
			if (overlayDir !== undefined && (image.modules[name] || (await exists(path.join(modulesDir, name))))) {
				throw new Error(`${name} is part of the image; remove it from /workplace/yena and rebuild`);
			}
			throw new Error(`Module "${name}" is not installed`);
		}
		const imageCopy = overlayDir !== undefined && (await exists(path.join(modulesDir, name)));

		if (!imageCopy) {
			const dependents = (await installedModules()).filter(
				m => m.manifest.name !== name && !names.includes(m.manifest.name) && name in m.manifest.dependencies,
			);
			if (dependents.length > 0) {
				log(`! Modules depending on "${name}": ${dependents.map(m => m.manifest.name).join(', ')}`);
			}
		}

		await rm(dir, {recursive: true, force: true});
		delete lock.modules[name];
		await writeLock(lock);
		log(`✗ ${name}${imageCopy ? ' (the image copy is used again)' : ''}`);
	}
	pmLog().info('remove finished', {specs: names.length});
}

export type ResolvedModule = Copy & {origin: ModuleOrigin};
export type SkippedModule = {name: string; version: string; imageVersion: string};

async function readCopies(dir: string, origin: ModuleOrigin): Promise<Map<string, Copy>> {
	const copies = new Map<string, Copy>();
	for (const name of await subdirs(dir)) {
		const moduleDir = path.join(dir, name);
		try {
			copies.set(name, {dir: moduleDir, manifest: await readManifest(moduleDir)});
		} catch (error) {
			pmLog().warn('module manifest unreadable', {dir: name, origin, err: error});
		}
	}
	return copies;
}

/**
 * One copy per module name: the image's, the overlay's, or the newer of both (the overlay on equal
 * versions). `skipped` lists overlay copies that lost to a newer image copy.
 */
export async function resolveModules(): Promise<{modules: ResolvedModule[]; skipped: SkippedModule[]}> {
	const image = await readCopies(modulesDir, 'image');
	const overlay = overlayDir === undefined ? new Map<string, Copy>() : await readCopies(overlayDir, 'overlay');
	const modules: ResolvedModule[] = [];
	const skipped: SkippedModule[] = [];
	for (const name of [...new Set([...image.keys(), ...overlay.keys()])].sort()) {
		const picked = pickCopy(image.get(name), overlay.get(name));
		if (!picked) continue;
		modules.push({...picked.winner, origin: picked.origin});
		const lost = overlay.get(name);
		if (lost && picked.origin === 'image') {
			skipped.push({name, version: lost.manifest.version, imageVersion: picked.winner.manifest.version});
		}
	}
	return {modules, skipped};
}

export async function installedModules(): Promise<ResolvedModule[]> {
	return (await resolveModules()).modules;
}

async function subdirs(dir: string): Promise<string[]> {
	const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
	return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
}

export type ModuleStatus = {
	name: string;
	version?: string;
	description?: string;
	source?: string;
	commit?: string;
	state: 'ok' | 'missing' | 'untracked' | 'broken';
	error?: string;
	/** Where this copy lives; a module in both places gets a row for each. */
	origin: ModuleOrigin;
	/** This copy is the one loaded. */
	active: boolean;
};

export const overlayEnabled = overlayDir !== undefined;

export async function list(): Promise<ModuleStatus[]> {
	const inUse = new Set((await installedModules()).map(m => m.dir));
	const roots: {origin: ModuleOrigin; dir: string; lock: Lock}[] = [{origin: 'image', dir: modulesDir, lock: await readLock(imageLockPath)}];
	if (overlayDir !== undefined) roots.push({origin: 'overlay', dir: overlayDir, lock: await readLock(installLockPath)});
	const result: ModuleStatus[] = [];

	for (const {origin, dir: rootDir, lock} of roots) {
		const names = new Set([...Object.keys(lock.modules), ...(await subdirs(rootDir))]);
		for (const name of names) {
			const entry = lock.modules[name];
			const dir = path.join(rootDir, name);
			const base = {name, source: entry?.source, commit: entry?.commit, version: entry?.version, origin, active: inUse.has(dir)};

			if (!(await exists(dir))) {
				result.push({...base, state: 'missing'});
				continue;
			}
			try {
				const m = await readManifest(dir);
				result.push({...base, version: m.version, description: m.description, state: entry ? 'ok' : 'untracked'});
			} catch (error) {
				result.push({...base, state: 'broken', error: (error as Error).message});
			}
		}
	}
	return result.sort((a, b) => a.name.localeCompare(b.name) || (a.origin === b.origin ? 0 : a.origin === 'image' ? -1 : 1));
}
