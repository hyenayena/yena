import path from 'node:path';
import type {ModuleDirs, RulesLayout, RulesProvider} from './api.js';

export const RULES_MODULE = 'rules';

export type RulesSlot = {
	register(provider: RulesProvider, module: string): boolean;
	current(): RulesProvider | undefined;
};

export function createRulesSlot(): RulesSlot {
	let current: RulesProvider | undefined;
	return {
		register(candidate, module) {
			if (module !== RULES_MODULE) return false;
			if (typeof candidate !== 'object' || candidate === null || typeof candidate.exportFilter !== 'function') {
				throw new Error(`invalid rules provider from ${module}`);
			}
			if (current) return false;
			current = candidate;
			return true;
		},
		current: () => current,
	};
}

export function rulesLayout(
	modules: readonly {dir: string; manifest: {name: string; export?: {deny: string[]}}}[],
	root: string | undefined,
	dataRoot: string,
): RulesLayout {
	const dirs: ModuleDirs[] = modules.map(m => ({
		name: m.manifest.name,
		codeDir: path.resolve(m.dir),
		dataDir: path.join(dataRoot, m.manifest.name),
		...(m.manifest.export && {legacyExport: {deny: [...m.manifest.export.deny]}}),
	}));
	return {...(root !== undefined && {root}), modules: dirs};
}
