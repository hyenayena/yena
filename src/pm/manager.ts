import {randomUUID} from 'node:crypto';
import {cp, mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {hostLog} from '../log/index.js';
import {readManifest, RESERVED_NAMES, type Manifest} from './manifest.js';
import {dependencyProblems, loadableModules, problemKey, problemText, satisfies, type DependencyProblem, type ModuleVersion} from './versions.js';
import {gitSshFor} from './git-ssh.js';
import {compareVersions, pickCopy, type Copy, type ModuleOrigin} from './overlay.js';
import {run, type Log} from './run.js';
import {officialModuleName, parseSource, type Source} from './source.js';

export const root = process.env.YENA_HOME ?? process.cwd();
export const modulesDir = path.join(root, 'modules');
export const dataDir = process.env.YENA_DATA ?? path.join(root, '.yena');
export const stateDir = hostStateDir(process.env, root);
export const overlayDir: string | undefined =
	process.env.YENA_DATA && process.env.YENA_DEV_CHILD !== '1' ? path.join(stateDir, 'modules') : undefined;

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
export const installDir = overlayDir ?? modulesDir;
const installLockPath = overlayDir === undefined ? imageLockPath : path.join(stateDir, LOCK_FILE);

type LockEntry = {
	source: string;
	version: string;
	commit?: string;
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

type Staged = {
	name: string;
	spec: string;
	staging: string;
	manifest: Manifest;
	commit: string | undefined;
	account: string | undefined;
};

type Session = {
	lock: Lock;
	image: Lock;
	log: Log;
	seen: Set<string>;
	staged: Map<string, Staged>;
	stagings: string[];
	backups: string[];
	resolved: ResolvedModule[];
};

const lockEntry = (s: Session, name: string) => s.lock.modules[name] ?? s.image.modules[name];

type StageOptions = {
	pinCommit?: string;
	account?: string;
	current?: string;
};

async function stageOne(spec: string, s: Session, {pinCommit, account, current}: StageOptions = {}): Promise<Manifest> {
	const trace = pmLog();
	const src = parseSource(spec, root, {ssh: account !== undefined});
	if (pinCommit && src.kind === 'git') src.ref = pinCommit;

	await mkdir(installDir, {recursive: true});
	const staging = path.join(installDir, `.staging-${randomUUID()}`);
	s.stagings.push(staging);

	s.log(`↓ ${spec}${pinCommit ? ` @ ${pinCommit.slice(0, 7)}` : ''}`);
	trace.info('install started', {spec, kind: src.kind, pinned: pinCommit?.slice(0, 7), account: account !== undefined});
	const commit = await fetchSource(src, staging, s.log, account);
	const manifest = await readManifest(staging);
	trace.info('fetched', {module: manifest.name, version: manifest.version, commit: commit?.slice(0, 7)});
	s.seen.add(manifest.name);
	if (current !== undefined && commit === current) {
		s.log(`  (no changes)`);
		trace.info('unchanged', {module: manifest.name});
		await rm(staging, {recursive: true, force: true});
		return manifest;
	}
	if (s.staged.has(manifest.name)) {
		await rm(staging, {recursive: true, force: true});
		return manifest;
	}
	s.staged.set(manifest.name, {name: manifest.name, spec, staging, manifest, commit, account});

	const have = new Map(s.resolved.map(m => [m.manifest.name, m.manifest]));
	for (const [dep, d] of Object.entries(manifest.dependencies)) {
		if (d.optional || s.seen.has(dep) || s.staged.has(dep)) continue;
		const installed = have.get(dep);
		if (installed && satisfies(installed.version, d.range)) continue;
		trace.info('staging dependency', {module: manifest.name, dependency: dep, present: installed !== undefined});
		const entry = lockEntry(s, dep);
		const staged = installed
			? await stageOne(entry?.source ?? d.source, s, {account: entry?.account ?? account})
			: await stageOne(d.source, s, {pinCommit: entry?.commit, account: entry?.account ?? account});
		if (staged.name !== dep) throw new Error(`Dependency "${dep}" is actually named "${staged.name}"`);
	}
	return manifest;
}

function dependencyOrder(staged: Staged[]): Staged[] {
	const byName = new Map(staged.map(st => [st.name, st]));
	const done = new Set<string>();
	const ordered: Staged[] = [];
	const visit = (st: Staged) => {
		if (done.has(st.name)) return;
		done.add(st.name);
		for (const dep of Object.keys(st.manifest.dependencies)) {
			const d = byName.get(dep);
			if (d) visit(d);
		}
		ordered.push(st);
	};
	staged.forEach(visit);
	return ordered;
}

const toVersions = (copies: Map<string, Copy>): ModuleVersion[] =>
	[...copies.values()].map(c => ({name: c.manifest.name, version: c.manifest.version, dependencies: c.manifest.dependencies}));

function winnerCopies(image: Map<string, Copy>, overlay: Map<string, Copy>): Map<string, Copy> {
	const winners = new Map<string, Copy>();
	for (const name of new Set([...image.keys(), ...overlay.keys()])) {
		const picked = pickCopy(image.get(name), overlay.get(name));
		if (picked) winners.set(name, picked.winner);
	}
	return winners;
}

export async function plannedVersions(staged: readonly {name: string; dir: string; manifest: Manifest}[]): Promise<{current: ModuleVersion[]; planned: ModuleVersion[]}> {
	const image = await readCopies(modulesDir, 'image');
	const overlay = overlayDir === undefined ? new Map<string, Copy>() : await readCopies(overlayDir, 'overlay');
	const current = toVersions(winnerCopies(image, overlay));
	const target = overlayDir === undefined ? image : overlay;
	for (const st of staged) target.set(st.name, {dir: st.dir, manifest: st.manifest});
	return {current, planned: toVersions(winnerCopies(image, overlay))};
}

export class RefusedInstall extends Error {}

export function refusalText(problems: readonly DependencyProblem[], versionOf: (name: string) => string | undefined): string {
	const parts = problems.map(p => {
		const head = `${p.dependent} needs ${p.dependency} ${p.range}`;
		const v = versionOf(p.dependency);
		return v === undefined ? `${head}, which would not be installed` : `${head}, ${p.dependency} would be ${v}`;
	});
	const names = [...new Set(problems.flatMap(p => [p.dependency, p.dependent]))];
	return `Refused, nothing was changed: ${parts.join('; ')}. Run "mod fix" to find compatible versions, or update them together (mod update ${names.join(' ')})`;
}

async function applyStaged(s: Session) {
	const trace = pmLog();
	const staged = dependencyOrder([...s.staged.values()]);
	if (staged.length === 0) return;

	for (const st of staged) {
		if (await exists(path.join(installDir, st.name, '.git'))) {
			throw new Error(`modules/${st.name} is a git checkout; update it with git or remove it first`);
		}
	}
	const {current, planned} = await plannedVersions(staged.map(st => ({name: st.name, dir: st.staging, manifest: st.manifest})));
	const before = new Set(dependencyProblems(current).map(problemKey));
	const fresh = dependencyProblems(planned).filter(p => !before.has(problemKey(p)));
	if (fresh.length > 0) {
		const versions = new Map(planned.map(m => [m.name, m.version]));
		trace.warn('install refused', {problems: fresh.length});
		throw new RefusedInstall(refusalText(fresh, name => versions.get(name)));
	}

	const swapped: {name: string; target: string; backup: string; moved: boolean; placed: boolean}[] = [];
	try {
		for (const st of staged) {
			const target = path.join(installDir, st.name);
			const backup = path.join(installDir, `.backup-${randomUUID()}`);
			s.backups.push(backup);
			const rec = {name: st.name, target, backup, moved: false, placed: false};
			swapped.push(rec);
			if (await exists(target)) {
				await rename(target, backup);
				rec.moved = true;
			}
			await rename(st.staging, target);
			rec.placed = true;
			trace.info('swapped into place', {module: st.name, replaced: rec.moved});
			const script = st.manifest.install;
			if (!script) continue;
			s.log(`  $ ${script}`);
			const started = Date.now();
			trace.info('install script started', {module: st.name});
			try {
				await run(script, [], {cwd: target, shell: true, log: s.log, trace, scrubEnv: true});
			} finally {
				trace.info('install script finished', {module: st.name, ms: Date.now() - started});
			}
		}
	} catch (error) {
		trace.warn('rolling back', {modules: swapped.length, err: error});
		const failed: string[] = [];
		for (const rec of swapped.reverse()) {
			try {
				if (rec.placed) await rm(rec.target, {recursive: true, force: true});
				if (rec.moved) await rename(rec.backup, rec.target);
			} catch (rollbackError) {
				trace.error('rollback failed', {module: rec.name, err: rollbackError});
				failed.push(rec.name);
			}
		}
		if (failed.length > 0) {
			throw new Error(`${(error as Error).message}\nRollback failed for ${failed.join(', ')}; remove them and reinstall`);
		}
		throw error;
	}

	for (const st of staged) {
		s.lock.modules[st.name] = {source: st.spec, version: st.manifest.version, commit: st.commit, ...(st.account !== undefined && {account: st.account})};
	}
	await writeLock(s.lock);
	trace.info('lock written', {modules: staged.length});
	for (const st of staged) {
		trace.info('install finished', {module: st.name, version: st.manifest.version});
		s.log(`✓ ${st.name}@${st.manifest.version}`);
		await warnIfShadowed(st.manifest, s.log);
	}
}

async function warnIfShadowed(manifest: Manifest, log: Log) {
	if (overlayDir === undefined) return;
	const image = await readManifest(path.join(modulesDir, manifest.name)).catch(() => undefined);
	if (image && compareVersions(manifest.version, image.version) < 0) {
		log(`! The image has ${manifest.name} ${image.version}, newer than ${manifest.version}; the image copy stays in use`);
	}
}

async function withSession<T>(log: Log, work: (s: Session) => Promise<T>): Promise<T> {
	const s: Session = {
		lock: await readLock(installLockPath),
		image: await imageLock(),
		log,
		seen: new Set(),
		staged: new Map(),
		stagings: [],
		backups: [],
		resolved: (await resolveModules()).modules,
	};
	try {
		return await work(s);
	} catch (error) {
		pmLog().error('install failed', {err: error});
		throw error;
	} finally {
		for (const dir of [...s.stagings, ...s.backups]) await rm(dir, {recursive: true, force: true});
	}
}

export type InstallOptions = {account?: string};

export async function install(specs: string[], log: Log, {account}: InstallOptions = {}) {
	const trace = pmLog();
	trace.info('install command started', {specs: specs.length});
	await withSession(log, async s => {
		if (specs.length > 0) {
			for (const spec of new Set(specs)) {
				const name = officialModuleName(spec);
				if (name && s.seen.has(name)) continue;
				await stageOne(spec, s, {account});
			}
			await applyStaged(s);
			trace.info('install command finished', {specs: specs.length});
			return;
		}

		for (const [name, entry] of Object.entries(s.lock.modules)) {
			if (s.seen.has(name) || (await exists(path.join(installDir, name)))) continue;
			await stageOne(entry.source, s, {pinCommit: entry.commit, account: entry.account});
		}
		const have = new Set(s.resolved.map(m => m.manifest.name));
		for (const {manifest} of s.resolved) {
			for (const [dep, d] of Object.entries(manifest.dependencies)) {
				if (d.optional || have.has(dep) || s.seen.has(dep)) continue;
				const entry = lockEntry(s, dep);
				await stageOne(d.source, s, {pinCommit: entry?.commit, account: entry?.account});
			}
		}
		const restored = s.staged.size;
		await applyStaged(s);
		trace.info('install command finished', {specs: 0, restored});
		log(restored ? `Modules restored: ${restored}` : 'All modules are already installed');
	});
}

export type PinnedItem = {spec: string; commit?: string; account?: string};

export async function installPinned(items: readonly PinnedItem[], log: Log) {
	pmLog().info('install pinned started', {specs: items.length});
	await withSession(log, async s => {
		for (const {spec, commit, account} of items) {
			await stageOne(spec, s, {...(commit !== undefined && {pinCommit: commit}), ...(account !== undefined && {account})});
		}
		await applyStaged(s);
	});
}

export async function update(names: string[], log: Log) {
	await withSession(log, async s => {
		const known = {...s.image.modules, ...s.lock.modules};
		const targets = names.length > 0 ? names : Object.keys(known).sort();
		pmLog().info('update started', {specs: targets.length});
		if (targets.length === 0) return log('No modules installed');

		const inUse = new Map(s.resolved.map(m => [m.manifest.name, m.origin]));
		for (const name of targets) {
			const entry = known[name];
			if (!entry) throw new Error(`Module "${name}" is not installed`);
			if (s.seen.has(name)) continue;
			const origin = inUse.get(name);
			const current = origin === undefined ? undefined : (origin === 'overlay' || overlayDir === undefined ? s.lock : s.image).modules[name]?.commit;
			await stageOne(entry.source, s, {account: entry.account, ...(current !== undefined && {current})});
		}
		await applyStaged(s);
		pmLog().info('update finished', {specs: targets.length});
	});
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
	state: 'ok' | 'missing' | 'untracked' | 'broken' | 'incompatible';
	error?: string;
	origin: ModuleOrigin;
	active: boolean;
};

export const overlayEnabled = overlayDir !== undefined;

export async function list(): Promise<ModuleStatus[]> {
	const winners = await installedModules();
	const inUse = new Set(winners.map(m => m.dir));
	const refused = new Map(loadableModules(winners).refused.map(r => [r.name, r.reasons]));
	const reasonsByDir = new Map(winners.flatMap(m => (refused.has(m.manifest.name) ? [[m.dir, refused.get(m.manifest.name)!] as const] : [])));
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
				const reasons = reasonsByDir.get(dir);
					const shown = {...base, version: m.version, description: m.description};
					result.push(reasons ? {...shown, state: 'incompatible', error: reasons.join('; ')} : {...shown, state: entry ? 'ok' : 'untracked'});
			} catch (error) {
				result.push({...base, state: 'broken', error: (error as Error).message});
			}
		}
	}
	return result.sort((a, b) => a.name.localeCompare(b.name) || (a.origin === b.origin ? 0 : a.origin === 'image' ? -1 : 1));
}

export type LockInfo = {source: string; version: string; commit?: string; account?: string};

export async function lockEntries(): Promise<Record<string, LockInfo>> {
	return {...(await imageLock()).modules, ...(await readLock(installLockPath)).modules};
}

const OFFICIAL_ORIGIN = /^(?:https:\/\/github\.com\/|git@github\.com:)hyenayena\/([a-z0-9][a-z0-9._-]*?)(?:\.git)?$/;

export async function lockRoot(log: Log) {
	if (overlayDir !== undefined) {
		throw new Error('mod lock records the modules of a working copy; run it in dev mode (mode dev)');
	}
	const old = (await readLock(installLockPath)).modules;
	const names = await subdirs(modulesDir);
	const manifests = new Map<string, Manifest>();
	for (const name of names) manifests.set(name, await readManifest(path.join(modulesDir, name)));
	const problems = dependencyProblems([...manifests.values()].map(m => ({name: m.name, version: m.version, dependencies: m.dependencies})));
	if (problems.length > 0) {
		throw new Error(`mod lock refuses an incompatible set: ${problems.map(problemText).join('; ')}`);
	}

	const modules: Record<string, LockEntry> = {};
	for (const name of names) {
		const dir = path.join(modulesDir, name);
		const manifest = manifests.get(name)!;
		const prev = old[name];
		if (!(await exists(path.join(dir, '.git')))) {
			if (prev) modules[name] = {...prev, version: manifest.version};
			else log(`! ${name} is not a git checkout and not in the lock; not locked`);
			continue;
		}
		const git = (...args: string[]) => run('git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], {env: {GIT_OPTIONAL_LOCKS: '0'}});
		let commit: string;
		let dirty: boolean;
		let origin: string | undefined;
		try {
			commit = (await git('rev-parse', 'HEAD')).trim();
			dirty = (await git('status', '--porcelain')).trim() !== '';
			origin = (await git('remote', 'get-url', 'origin').catch(() => '')).trim() || undefined;
		} catch (error) {
			throw new Error(`mod lock: cannot read the commit of modules/${name}: ${(error as Error).message}`);
		}
		if (dirty) {
			log(`! ${name} has uncommitted changes; not locked`);
			if (prev) modules[name] = prev;
			continue;
		}
		const official = origin === undefined ? undefined : OFFICIAL_ORIGIN.exec(origin)?.[1] === name;
		const source = prev?.source ?? (official ? name : origin);
		if (source === undefined) {
			log(`! ${name} has no remote; not locked`);
			continue;
		}
		modules[name] = {source, version: manifest.version, commit, ...(prev?.account !== undefined && {account: prev.account})};
		log(`✓ ${name}@${manifest.version} ${commit.slice(0, 7)}`);
	}
	await writeLock({modules});
	pmLog().info('root lock written', {modules: Object.keys(modules).length});
}
