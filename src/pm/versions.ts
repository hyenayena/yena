import type {Dependency, Manifest} from './manifest.js';

export type Range = {kind: 'caret' | 'exact'; version: [number, number, number]};

const RANGE = /^(\^?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseRange(text: string): Range | undefined {
	const m = RANGE.exec(text);
	if (!m) return undefined;
	return {kind: m[1] ? 'caret' : 'exact', version: [Number(m[2]), Number(m[3]), Number(m[4])]};
}

export function parsePlainVersion(text: string): [number, number, number] | undefined {
	const m = PLAIN.exec(text);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const cmp = (a: readonly number[], b: readonly number[]) => {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
	return 0;
};

function upperBound([x, y, z]: [number, number, number]): [number, number, number] {
	if (x > 0) return [x + 1, 0, 0];
	if (y > 0) return [0, y + 1, 0];
	return [0, 0, z + 1];
}

// A version that is not plain x.y.z (pre-release, build suffix, junk) never satisfies a range.
export function satisfies(version: string, range: string): boolean {
	const v = parsePlainVersion(version);
	const r = parseRange(range);
	if (!v || !r) return false;
	if (r.kind === 'exact') return cmp(v, r.version) === 0;
	return cmp(v, r.version) >= 0 && cmp(v, upperBound(r.version)) < 0;
}

export type DependencyProblem = {
	kind: 'missing' | 'too-old' | 'too-new' | 'unversioned';
	dependent: string;
	dependency: string;
	range: string;
	source: string;
	installed?: string;
};

export type ModuleVersion = {name: string; version: string; dependencies: Record<string, Dependency>};

export function dependencyProblems(set: readonly ModuleVersion[]): DependencyProblem[] {
	const byName = new Map(set.map(m => [m.name, m]));
	const problems: DependencyProblem[] = [];
	for (const m of set) {
		for (const [name, dep] of Object.entries(m.dependencies)) {
			const base = {dependent: m.name, dependency: name, range: dep.range, source: dep.source};
			const found = byName.get(name);
			if (!found) {
				if (!dep.optional) problems.push({...base, kind: 'missing'});
				continue;
			}
			if (satisfies(found.version, dep.range)) continue;
			const have = parsePlainVersion(found.version);
			const range = parseRange(dep.range)!;
			const kind = !have ? 'unversioned' : cmp(have, range.version) < 0 ? 'too-old' : 'too-new';
			problems.push({...base, kind, installed: found.version});
		}
	}
	return problems;
}

export function problemText(p: DependencyProblem): string {
	const head = `${p.dependent} needs ${p.dependency} ${p.range}`;
	if (p.kind === 'missing') return `${head}, which is not installed; run "mod install ${p.source}"`;
	const fix = p.kind === 'too-new' ? p.dependent : p.dependency;
	return `${head}, installed ${p.installed}; run "mod update ${fix}"`;
}

export const problemKey = (p: DependencyProblem) => `${p.dependent}\u0000${p.dependency}`;

export type RefusedModule = {name: string; reasons: string[]};

export function loadableModules<T extends {manifest: Pick<Manifest, 'name' | 'version' | 'dependencies'>}>(
	modules: readonly T[],
): {modules: T[]; refused: RefusedModule[]} {
	const set = modules.map(m => ({name: m.manifest.name, version: m.manifest.version, dependencies: m.manifest.dependencies}));
	const reasons = new Map<string, string[]>();
	const refuse = (name: string, reason: string) => {
		if (name === 'core') return false;
		const list = reasons.get(name) ?? [];
		if (list.includes(reason)) return false;
		reasons.set(name, [...list, reason]);
		return true;
	};
	for (const p of dependencyProblems(set)) refuse(p.dependent, problemText(p));
	for (let changed = true; changed; ) {
		changed = false;
		for (const m of set) {
			for (const name of Object.keys(m.dependencies)) {
				if (reasons.has(name) && refuse(m.name, `${m.name} needs ${name}, which is not loaded`)) changed = true;
			}
		}
	}
	return {
		modules: modules.filter(m => !reasons.has(m.manifest.name)),
		refused: [...reasons].map(([name, list]) => ({name, reasons: list})).sort((a, b) => a.name.localeCompare(b.name)),
	};
}
