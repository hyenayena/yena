import {stat} from 'node:fs/promises';
import path from 'node:path';
import type {
	ImportPlan,
	ImportRequest,
	ImportResult,
	ImportStep,
	Logger,
	ModuleDataLimits,
	ModuleDataRead,
	ModuleDataReplaced,
	ModuleInfo,
	ModuleLockInfo,
	ModuleRegistry,
	ModuleTarget,
} from '../api.js';
import {hostLog} from '../log/index.js';
import {alignPinned, dataDir, imageVersionOf, locksByOrigin, resolveModules, type AlignItem, type ResolvedModule} from './manager.js';
import {hasControlChars} from './export-rules.js';
import type {Manifest} from './manifest.js';
import {readModuleCode} from './module-code.js';
import {pathProblem, readModuleData, replaceModuleData} from './module-data.js';
import {compareVersions} from './overlay.js';
import {run} from './run.js';
import {parseSource} from './source.js';
import {hostRangeProblem, satisfies} from './versions.js';

export type RegistryDeps = {
	resolveModules: () => Promise<{modules: ResolvedModule[]}>;
	locksByOrigin: () => Promise<{image: Record<string, ModuleLockInfo>; overlay?: Record<string, ModuleLockInfo>}>;
	alignPinned: typeof alignPinned;
	imageVersionOf: (name: string) => Promise<string | undefined>;
	dataRoot: string;
	hostVersion: string;
	log: Logger;
	exec?: typeof run;
};

const COMMIT = /^[0-9a-f]{40}$/;
const ACCOUNT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_SOURCE = 500;

export function sourceRefusal(source: string): string | undefined {
	if (source === '' || source.length > MAX_SOURCE || source.startsWith('-') || /\s/.test(source) || hasControlChars(source)) return 'an unusable source';
	let parsed;
	try {
		parsed = parseSource(source, '/');
	} catch {
		return 'an unrecognized source';
	}
	if (parsed.kind === 'path') return 'a local path';
	const scheme = /^([a-z+]+):\/\//.exec(source)?.[1];
	if (scheme !== undefined && scheme !== 'https' && scheme !== 'ssh') return scheme === 'file' ? 'a file:// URL' : `${scheme}://`;
	return undefined;
}

async function exists(p: string) {
	return stat(p).then(
		() => true,
		() => false,
	);
}

async function git(dir: string, args: string[]): Promise<string> {
	return run('git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], {env: {GIT_OPTIONAL_LOCKS: '0'}, scrubEnv: true});
}

async function carryReason(dir: string, manifest: Manifest, lock: ModuleLockInfo | undefined): Promise<string | undefined> {
	if (!lock) return 'not in the module lock';
	const refused = sourceRefusal(lock.source);
	if (refused) return `installed from ${refused}`;
	if (lock.commit === undefined || !COMMIT.test(lock.commit)) return 'no commit in the module lock';
	if (lock.version !== manifest.version) return `the lock records ${lock.version}, the code is ${manifest.version}`;
	if (await exists(path.join(dir, '.git'))) {
		let head: string;
		let dirty: boolean;
		try {
			head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
			dirty = (await git(dir, ['status', '--porcelain'])).trim() !== '';
		} catch {
			return 'cannot read its git state';
		}
		if (head !== lock.commit) return 'HEAD is not the locked commit';
		if (dirty) return 'uncommitted changes';
	}
	return undefined;
}

export function createModuleRegistry(overrides: Partial<RegistryDeps> = {}): ModuleRegistry {
	const deps: RegistryDeps = {
		resolveModules,
		locksByOrigin,
		alignPinned,
		imageVersionOf,
		dataRoot: dataDir,
		hostVersion: 'unknown',
		log: hostLog().child('registry'),
		...overrides,
	};

	const lockFor = (m: ResolvedModule, locks: Awaited<ReturnType<RegistryDeps['locksByOrigin']>>): ModuleLockInfo | undefined => {
		const name = m.manifest.name;
		if (m.origin === 'overlay') return locks.overlay?.[name] ?? locks.image[name];
		return locks.image[name];
	};

	async function installed(): Promise<Map<string, ResolvedModule>> {
		return new Map((await deps.resolveModules()).modules.map(m => [m.manifest.name, m]));
	}

	async function infoOf(m: ResolvedModule, locks: Awaited<ReturnType<RegistryDeps['locksByOrigin']>>): Promise<ModuleInfo> {
		const lock = lockFor(m, locks);
		const reason = await carryReason(m.dir, m.manifest, lock);
		return {
			name: m.manifest.name,
			version: m.manifest.version,
			origin: m.origin,
			...(m.manifest.export && {export: m.manifest.export}),
			...(lock && {lock: {...lock}}),
			...(m.manifest.host !== undefined && {host: m.manifest.host}),
			code: reason === undefined ? {carry: false} : {carry: true, reason},
		};
	}

	async function need(name: string): Promise<ResolvedModule> {
		const found = (await installed()).get(name);
		if (!found) throw new Error(`Module "${name.slice(0, 64)}" is not installed`);
		return found;
	}

	async function list(): Promise<ModuleInfo[]> {
		const locks = await deps.locksByOrigin();
		const infos: ModuleInfo[] = [];
		for (const m of (await deps.resolveModules()).modules) infos.push(await infoOf(m, locks));
		return infos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	async function readData(name: string, limits: ModuleDataLimits): Promise<ModuleDataRead> {
		const m = await need(name);
		return readModuleData(deps.dataRoot, name, m.manifest.export, limits, deps.log);
	}

	async function readCode(name: string, limits: ModuleDataLimits): Promise<ModuleDataRead> {
		const m = await need(name);
		const info = await infoOf(m, await deps.locksByOrigin());
		if (!info.code.carry) throw new Error(`Module "${name}" can be installed from its source; its code is not carried`);
		return readModuleCode(m.dir, limits, deps.log);
	}

	async function planImport(targets: readonly ModuleTarget[]): Promise<ImportPlan> {
		const have = await installed();
		const locks = await deps.locksByOrigin();
		const steps: ImportStep[] = [];
		const problems: string[] = [];
		for (const t of targets) {
			const cur = have.get(t.name);
			const lock = cur && lockFor(cur, locks);
			const carried = t.code !== undefined;
			let action: ImportStep['action'];
			if (!cur) action = 'install';
			else if (carried) action = compareVersions(t.version, cur.manifest.version) < 0 ? 'downgrade' : 'update';
			else if (cur.manifest.version === t.version && (t.commit === undefined || lock?.commit === t.commit)) action = 'unchanged';
			else action = compareVersions(t.version, cur.manifest.version) < 0 ? 'downgrade' : 'update';
			steps.push({
				name: t.name,
				action,
				...(cur && {from: cur.manifest.version}),
				to: t.version,
				...(lock?.commit !== undefined && {fromCommit: lock.commit}),
				...(t.commit !== undefined && {toCommit: t.commit}),
				...(t.source !== undefined && {source: t.source}),
				...(carried && {fromFile: true}),
			});

			if (t.host !== undefined && !satisfies(deps.hostVersion, t.host)) {
				problems.push(hostRangeProblem(t.name, t.version, t.host, deps.hostVersion));
			}
			if (action === 'unchanged') continue;

			if (t.code !== undefined) {
				for (const file of t.code) {
					const problem = pathProblem(file.path);
					if (problem) {
						problems.push(`${t.name}: a code path in the file ${problem}`);
						break;
					}
				}
				if (!t.code.some(f => f.path === 'yena.json')) problems.push(`${t.name}: the file has no yena.json for its code`);
			} else if (t.source === undefined) {
				problems.push(`${t.name}: the export has no source for it (it was not in the module lock where it was exported)`);
			} else if (t.commit === undefined) {
				problems.push(`${t.name}: the export has no commit for it`);
			} else {
				const refused = sourceRefusal(t.source);
				if (refused) problems.push(`${t.name}: ${t.source.slice(0, 64)} cannot be installed from an export (${refused})`);
				else if (!COMMIT.test(t.commit)) problems.push(`${t.name}: the export has a malformed commit for it`);
				else if (t.account !== undefined && !ACCOUNT.test(t.account)) {
					problems.push(`${t.name}: ${t.source.slice(0, 64)} cannot be installed from an export (a malformed account name)`);
				}
			}

			const image = await deps.imageVersionOf(t.name);
			if (image !== undefined && compareVersions(t.version, image) < 0) {
				problems.push(`${t.name} ${t.version} cannot replace the image's ${image}: a newer image copy always wins`);
			}
			if (cur && (await exists(path.join(cur.dir, '.git')))) {
				problems.push(`${t.name} is a git checkout (dev mode); align it with git or run the import in image mode`);
			}
		}
		const named = new Set(targets.map(t => t.name));
		const untouched = [...have.keys()].filter(name => !named.has(name)).sort();
		return {hostVersion: deps.hostVersion, steps, untouched, problems};
	}

	async function applyImport(request: ImportRequest, log: (line: string) => void): Promise<ImportResult> {
		const plan = await planImport(request.targets);
		if (plan.problems.length > 0) {
			throw new Error(`Import refused, nothing was changed:\n${plan.problems.map(p => `- ${p}`).join('\n')}`);
		}
		const targets = new Map(request.targets.map(t => [t.name, t]));
		for (const item of request.data) {
			if (!targets.has(item.name)) throw new Error(`Import refused, nothing was changed: "${item.name.slice(0, 64)}" has data but is not in the export's module list`);
		}
		const have = await installed();
		let replaced: ModuleDataReplaced[] = [];
		const replace = async (stagedRules?: Map<string, Manifest>) => {
			replaced = await replaceModuleData(deps.dataRoot, request.data, {
				backupDir: request.backupDir,
				rulesFor: name => (stagedRules?.has(name) ? stagedRules.get(name)!.export : have.get(name)?.manifest.export),
				log: deps.log,
			});
		};

		const items: AlignItem[] = [];
		for (const step of plan.steps) {
			if (step.action === 'unchanged') continue;
			const t = targets.get(step.name)!;
			if (t.code !== undefined) items.push({name: t.name, version: t.version, files: t.code});
			else items.push({name: t.name, version: t.version, spec: t.source!, commit: t.commit!, ...(t.account !== undefined && {account: t.account})});
		}
		if (items.length === 0) {
			await replace();
		} else {
			await deps.alignPinned(items, log, staged => replace(staged), {hostVersion: deps.hostVersion, ...(deps.exec && {exec: deps.exec})});
		}
		deps.log.info('import applied', {aligned: items.length, modules: request.data.length});
		return {plan, replaced};
	}

	return {list, readData, readCode, planImport, applyImport};
}
