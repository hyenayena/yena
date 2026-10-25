import {randomUUID} from 'node:crypto';
import {cp, mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {hostLog} from '../log/index.js';
import {readManifest, type Manifest} from './manifest.js';
import {run, type Log} from './run.js';
import {officialModuleName, parseSource, type Source} from './source.js';

export const root = process.env.YENA_HOME ?? process.cwd();
export const modulesDir = path.join(root, 'modules');
export const dataDir = process.env.YENA_DATA ?? path.join(root, '.yena');

export async function moduleDataDir(name: string): Promise<string> {
	const dir = path.join(dataDir, name);
	await mkdir(dir, {recursive: true});
	return dir;
}
const pmLog = () => hostLog().child('pm');
const lockPath = path.join(root, 'yena-modules.json');

type LockEntry = {
	source: string;
	version: string;
	commit?: string;
};

type Lock = {modules: Record<string, LockEntry>};

async function readLock(): Promise<Lock> {
	try {
		const data = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<Lock>;
		return {modules: data.modules ?? {}};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {modules: {}};
		throw new Error(`Failed to read ${path.basename(lockPath)}: ${(error as Error).message}`);
	}
}

async function writeLock(lock: Lock) {
	const sorted = Object.fromEntries(Object.entries(lock.modules).sort(([a], [b]) => a.localeCompare(b)));
	await writeFile(lockPath, JSON.stringify({modules: sorted}, null, '\t') + '\n');
}

async function exists(p: string) {
	return stat(p).then(
		() => true,
		() => false,
	);
}

async function fetchSource(src: Source, dest: string, log: Log): Promise<string | undefined> {
	if (src.kind === 'path') {
		if (!(await exists(src.path))) throw new Error(`Folder ${src.path} does not exist`);
		if (!path.relative(modulesDir, src.path).startsWith('..')) {
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
	await run('git', ['fetch', '-q', '--depth', '1', src.url, src.ref ?? 'HEAD'], {cwd: dest, log, trace});
	await run('git', ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], {cwd: dest, trace});
	const commit = (await run('git', ['rev-parse', 'HEAD'], {cwd: dest, trace})).trim();
	await rm(path.join(dest, '.git'), {recursive: true, force: true});
	return commit;
}

type Session = {
	lock: Lock;
	log: Log;
	seen: Set<string>;
};

async function installOne(spec: string, s: Session, pinCommit?: string): Promise<Manifest> {
	const trace = pmLog();
	const src = parseSource(spec, root);
	if (pinCommit && src.kind === 'git') src.ref = pinCommit;

	await mkdir(modulesDir, {recursive: true});
	const staging = path.join(modulesDir, `.staging-${randomUUID()}`);
	const backup = path.join(modulesDir, `.backup-${randomUUID()}`);

	try {
		s.log(`↓ ${spec}${pinCommit ? ` @ ${pinCommit.slice(0, 7)}` : ''}`);
		trace.info('install started', {spec, kind: src.kind, pinned: pinCommit?.slice(0, 7)});
		const commit = await fetchSource(src, staging, s.log);
		const manifest = await readManifest(staging);
		trace.info('fetched', {module: manifest.name, version: manifest.version, commit: commit?.slice(0, 7)});
		s.seen.add(manifest.name);

		// Dependencies first, so the module's install script can rely on them
		for (const [dep, depSpec] of Object.entries(manifest.dependencies)) {
			if (s.seen.has(dep) || (await exists(path.join(modulesDir, dep)))) continue;
			trace.info('installing dependency', {module: manifest.name, dependency: dep});
			const installed = await installOne(depSpec, s, s.lock.modules[dep]?.commit);
			if (installed.name !== dep) {
				throw new Error(`Dependency "${dep}" is actually named "${installed.name}"`);
			}
		}

		// Keep the old version as a backup until the install script passes
		const target = path.join(modulesDir, manifest.name);
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
					await run(manifest.install, [], {cwd: target, shell: true, log: s.log, trace});
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

		s.lock.modules[manifest.name] = {source: spec, version: manifest.version, commit};
		await writeLock(s.lock);
		trace.info('lock written', {module: manifest.name});
		s.log(`✓ ${manifest.name}@${manifest.version}`);
		trace.info('install finished', {module: manifest.name, version: manifest.version});
		return manifest;
	} catch (error) {
		trace.error('install failed', {spec, err: error});
		throw error;
	} finally {
		await rm(staging, {recursive: true, force: true});
		await rm(backup, {recursive: true, force: true});
	}
}

export async function install(specs: string[], log: Log) {
	const s: Session = {lock: await readLock(), log, seen: new Set()};
	const trace = pmLog();
	trace.info('install command started', {specs: specs.length});

	if (specs.length > 0) {
		for (const spec of new Set(specs)) {
			const name = officialModuleName(spec);
			if (name && s.seen.has(name)) continue;
			await installOne(spec, s);
		}
		trace.info('install command finished', {specs: specs.length});
		return;
	}

	let restored = 0;
	for (const [name, entry] of Object.entries(s.lock.modules)) {
		if (s.seen.has(name) || (await exists(path.join(modulesDir, name)))) continue;
		await installOne(entry.source, s, entry.commit);
		restored++;
	}
	for (const manifest of await installedManifests()) {
		for (const [dep, depSpec] of Object.entries(manifest.dependencies)) {
			if (s.seen.has(dep) || (await exists(path.join(modulesDir, dep)))) continue;
			await installOne(depSpec, s, s.lock.modules[dep]?.commit);
			restored++;
		}
	}
	trace.info('install command finished', {specs: 0, restored});
	log(restored ? `Modules restored: ${restored}` : 'All modules are already installed');
}

export async function update(names: string[], log: Log) {
	const s: Session = {lock: await readLock(), log, seen: new Set()};
	const targets = names.length > 0 ? names : Object.keys(s.lock.modules);
	pmLog().info('update started', {specs: targets.length});
	if (targets.length === 0) return log('No modules installed');

	for (const name of targets) {
		const entry = s.lock.modules[name];
		if (!entry) throw new Error(`Module "${name}" is not installed`);
		if (s.seen.has(name)) continue;
		const before = entry.commit;
		const manifest = await installOne(entry.source, s);
		const after = s.lock.modules[manifest.name]?.commit;
		if (before && before === after) log(`  (no changes)`);
	}
	pmLog().info('update finished', {specs: targets.length});
}

export async function remove(names: string[], log: Log) {
	if (names.length === 0) throw new Error('Specify which modules to remove');
	const lock = await readLock();
	pmLog().info('remove started', {specs: names.length, names});

	for (const name of names) {
		const dir = path.join(modulesDir, name);
		if (!lock.modules[name] && !(await exists(dir))) throw new Error(`Module "${name}" is not installed`);

		const dependents = (await installedManifests()).filter(
			m => m.name !== name && !names.includes(m.name) && name in m.dependencies,
		);
		if (dependents.length > 0) {
			log(`! Modules depending on "${name}": ${dependents.map(m => m.name).join(', ')}`);
		}

		await rm(dir, {recursive: true, force: true});
		delete lock.modules[name];
		await writeLock(lock);
		log(`✗ ${name}`);
	}
	pmLog().info('remove finished', {specs: names.length});
}

export async function installedModules(): Promise<{dir: string; manifest: Manifest}[]> {
	const result: {dir: string; manifest: Manifest}[] = [];
	for (const name of await installedDirs()) {
		const dir = path.join(modulesDir, name);
		try {
			result.push({dir, manifest: await readManifest(dir)});
		} catch (error) {
			pmLog().warn('module manifest unreadable', {dir: name, err: error});
		}
	}
	return result;
}

async function installedManifests(): Promise<Manifest[]> {
	return (await installedModules()).map(m => m.manifest);
}

async function installedDirs(): Promise<string[]> {
	const entries = await readdir(modulesDir, {withFileTypes: true}).catch(() => []);
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
};

export async function list(): Promise<ModuleStatus[]> {
	const lock = await readLock();
	const names = new Set([...Object.keys(lock.modules), ...(await installedDirs())]);
	const result: ModuleStatus[] = [];

	for (const name of [...names].sort()) {
		const entry = lock.modules[name];
		const base = {name, source: entry?.source, commit: entry?.commit, version: entry?.version};
		const dir = path.join(modulesDir, name);

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
	return result;
}
