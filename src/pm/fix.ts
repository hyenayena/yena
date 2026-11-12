import {readFile, realpath, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {terminalText} from '../log/sanitize.js';
import {usageError} from '../usage-error.js';
import {installPinned, installedModules, lockEntries, modulesDir, overlayDir, type LockInfo, type PinnedItem} from './manager.js';
import {parseManifest, type Manifest} from './manifest.js';
import {compareVersions} from './overlay.js';
import {findRelease} from './releases.js';
import type {Log} from './run.js';
import {dependencyProblems, parsePlainVersion, problemKey, problemText, satisfies, type DependencyProblem, type ModuleVersion} from './versions.js';

export type FixOptions = {yes: boolean; ranges: boolean};

const MAX_ROUNDS = 5;

export function parseFixArgs(args: string[]): FixOptions {
	const options: FixOptions = {yes: false, ranges: false};
	for (const arg of args) {
		if (arg === '--yes') options.yes = true;
		else if (arg === '--ranges') options.ranges = true;
		else if (arg.startsWith('-')) throw usageError(`Unknown option "${arg}". See mod help fix`);
		else throw usageError(`mod fix takes no arguments, got "${arg}". See mod help fix`);
	}
	return options;
}

const exists = (p: string) =>
	stat(p).then(
		() => true,
		() => false,
	);

type Active = ModuleVersion & {dir: string; checkout: boolean};

async function activeSet(): Promise<Active[]> {
	const winners = await installedModules();
	return Promise.all(
		winners.map(async m => ({
			name: m.manifest.name,
			version: m.manifest.version,
			dependencies: m.manifest.dependencies,
			dir: m.dir,
			checkout: await exists(path.join(m.dir, '.git')),
		})),
	);
}

type Pick = {name: string; from: string | undefined; manifest: Manifest; commit: string | undefined; spec: string; account: string | undefined};

const short = (commit: string | undefined) => (commit ? commit.slice(0, 7) : 'folder');

function pickLine(p: Pick): string {
	const what = p.from === undefined ? `install ${p.name} ${p.manifest.version}` : `update ${p.name} ${p.from} → ${p.manifest.version}`;
	return `${what} (${short(p.commit)} from ${p.spec})`;
}

async function planInstalls(active: Active[], lock: Record<string, LockInfo>, log: Log): Promise<{picks: Pick[]; conflicts: DependencyProblem[]; notes: string[]}> {
	const planned = new Map<string, ModuleVersion>(active.map(a => [a.name, {name: a.name, version: a.version, dependencies: a.dependencies}]));
	const original = new Map(active.map(a => [a.name, a]));
	const picks = new Map<string, Pick>();
	const notes = new Set<string>();
	const problemsNow = () => dependencyProblems([...planned.values()]);
	const conflicts = problemsNow();
	if (conflicts.length === 0) return {picks: [], conflicts, notes: []};

	const movable = (name: string): boolean => {
		if (original.get(name)?.checkout) {
			notes.add(`${name} is a git checkout; update it with git or use mod fix --ranges`);
			return false;
		}
		return true;
	};
	const dependentsFit = (name: string, version: string) =>
		[...planned.values()].every(m => {
			const dep = m.dependencies[name];
			return dep === undefined || satisfies(version, dep.range);
		});
	const ownFit = (manifest: Manifest) =>
		Object.entries(manifest.dependencies).every(([dep, d]) => {
			const have = planned.get(dep);
			return have === undefined ? d.optional : satisfies(have.version, d.range);
		});
	const choose = (name: string, release: {commit: string | undefined; manifest: Manifest}, spec: string, account: string | undefined) => {
		picks.set(name, {name, from: original.get(name)?.version, manifest: release.manifest, commit: release.commit, spec, account});
		planned.set(name, {name, version: release.manifest.version, dependencies: release.manifest.dependencies});
	};

	const newerThanPlanned = (name: string, version: string) => {
		const have = planned.get(name);
		return have === undefined || compareVersions(version, have.version) > 0;
	};

	const viaDependency = async (p: DependencyProblem): Promise<boolean> => {
		const name = p.dependency;
		if (!movable(name)) return false;
		const spec = lock[name]?.source ?? p.source;
		const account = lock[name]?.account;
		const release = await findRelease(
			spec,
			account,
			m => m.name === name && newerThanPlanned(name, m.version) && dependentsFit(name, m.version) && ownFit(m),
			log,
		);
		if (!release) return false;
		choose(name, release, spec, account);
		return true;
	};

	const viaDependent = async (p: DependencyProblem): Promise<boolean> => {
		const name = p.dependent;
		const entry = lock[name];
		if (!entry) {
			notes.add(`${name} has no recorded source; update it by hand`);
			return false;
		}
		if (!movable(name)) return false;
		const have = planned.get(p.dependency);
		const release = await findRelease(
			entry.source,
			entry.account,
			m => {
				if (m.name !== name || !newerThanPlanned(name, m.version) || !dependentsFit(name, m.version) || !ownFit(m)) return false;
				const dep = m.dependencies[p.dependency];
				return dep === undefined || (have !== undefined && satisfies(have.version, dep.range));
			},
			log,
		);
		if (!release) return false;
		choose(name, release, entry.source, entry.account);
		return true;
	};

	for (let round = 0; round < MAX_ROUNDS; round++) {
		const problems = problemsNow();
		if (problems.length === 0) break;
		let progressed = false;
		for (const p of problems) {
			const still = problemsNow().some(q => problemKey(q) === problemKey(p));
			if (!still) continue;
			if (p.kind !== 'too-new' && (await viaDependency(p))) progressed = true;
			else if (await viaDependent(p)) progressed = true;
		}
		if (!progressed) break;
	}
	const left = problemsNow();
	if (left.length > 0) {
		const extra = [...notes].length > 0 ? ` (${[...notes].join('; ')})` : '';
		throw new Error(`mod fix cannot resolve: ${left.map(problemText).join('; ')}; nothing was changed${extra}. In a working copy, mod fix --ranges moves the ranges`);
	}
	return {picks: [...picks.values()].sort((a, b) => a.name.localeCompare(b.name)), conflicts, notes: [...notes]};
}

type RangeChange = {dependent: string; file: string; changes: {dependency: string; from: string; to: string}[]};

async function planRanges(active: Active[], log: Log): Promise<{changes: RangeChange[]; others: DependencyProblem[]; conflicts: DependencyProblem[]}> {
	const conflicts = dependencyProblems(active);
	const others = conflicts.filter(p => p.kind !== 'too-new');
	const byDependent = new Map<string, RangeChange>();
	const codeModules = await realpath(modulesDir);
	for (const p of conflicts.filter(c => c.kind === 'too-new')) {
		const dependent = active.find(a => a.name === p.dependent)!;
		const dir = await realpath(dependent.dir);
		const inside = dir.startsWith(codeModules + path.sep) && (await exists(path.join(dir, '.git')));
		if (!inside) {
			log(`! ${p.dependent} is not a working copy; change its yena.json in its repo`);
			continue;
		}
		const caret = p.range.startsWith('^');
		const to = `${caret ? '^' : ''}${p.installed}`;
		const entry = byDependent.get(p.dependent) ?? {dependent: p.dependent, file: path.join(dir, 'yena.json'), changes: []};
		entry.changes.push({dependency: p.dependency, from: p.range, to});
		byDependent.set(p.dependent, entry);
	}
	return {changes: [...byDependent.values()], others, conflicts};
}

async function writeRanges(change: RangeChange) {
	const raw = await readFile(change.file, 'utf8');
	parseManifest(raw);
	const data = JSON.parse(raw) as {dependencies: Record<string, {version: string}>};
	for (const c of change.changes) data.dependencies[c.dependency]!.version = c.to;
	await writeFile(change.file, JSON.stringify(data, null, '\t') + '\n');
}

export async function fixVersions({yes, ranges}: FixOptions, rawLog: Log): Promise<void> {
	const log: Log = line => rawLog(terminalText(line, 2000));
	const active = await activeSet();

	if (ranges) {
		if (overlayDir !== undefined) {
			throw new Error('mod fix --ranges edits the yena.json of working copies; run it in dev mode (mode dev)');
		}
		const {changes, others, conflicts} = await planRanges(active, log);
		if (conflicts.length === 0) return log('No version conflicts');
		for (const p of others) log(`! ${problemText(p)}; run "mod fix"`);
		if (changes.length === 0) return;
		for (const c of changes) for (const x of c.changes) log(`${c.dependent}/yena.json: ${x.dependency} ${x.from} → ${x.to}`);
		if (!yes) return log('Run "mod fix --ranges --yes" to apply');
		for (const c of changes) {
			await writeRanges(c);
			const summary = c.changes.map(x => `${x.dependency} ${x.from} → ${x.to}`).join(', ');
			log(`Changed ${c.dependent}/yena.json: ${summary}. Test it, bump ${c.dependent}'s version and commit; restart yena to load it`);
		}
		return;
	}

	const lock = await lockEntries();
	const {picks, conflicts, notes} = await planInstalls(active, lock, log);
	if (conflicts.length === 0) return log('No version conflicts');
	for (const p of conflicts) log(`! ${problemText(p)}`);
	for (const note of notes) log(`  ${note}`);
	for (const p of picks) log(pickLine(p));
	if (!yes) return log('Run "mod fix --yes" to apply');
	const items: PinnedItem[] = picks.map(p => ({spec: p.spec, ...(p.commit !== undefined && {commit: p.commit}), ...(p.account !== undefined && {account: p.account})}));
	await installPinned(items, rawLog);
}
