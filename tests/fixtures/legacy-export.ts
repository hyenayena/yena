import type {ExportFilter, ModuleExportRules, RulesProvider} from '../../src/api.js';

const regexCache = new Map<string, RegExp>();

function segmentRegExp(segment: string): RegExp {
	let re = regexCache.get(segment);
	if (!re) {
		let source = '';
		for (const ch of segment) {
			if (ch === '*') source += '[^/]*';
			else if (ch === '?') source += '[^/]';
			else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
		re = new RegExp(`^${source}$`, 's');
		regexCache.set(segment, re);
	}
	return re;
}

function matchSegments(pattern: readonly string[], p: number, parts: readonly string[], i: number): boolean {
	if (p === pattern.length) return i === parts.length;
	const head = pattern[p]!;
	if (head === '**') {
		for (let k = i; k <= parts.length; k++) if (matchSegments(pattern, p + 1, parts, k)) return true;
		return false;
	}
	if (i === parts.length) return false;
	return segmentRegExp(head).test(parts[i]!) && matchSegments(pattern, p + 1, parts, i + 1);
}

export function isDenied(rules: ModuleExportRules, rel: string): boolean {
	const parts = rel.split('/');
	for (const pattern of rules.deny) {
		const segments = pattern.split('/');
		for (let end = 1; end <= parts.length; end++) {
			if (matchSegments(segments, 0, parts.slice(0, end), 0)) return true;
		}
	}
	return false;
}

export const filterFor = (rules: ModuleExportRules, note?: string): ExportFilter => ({
	denied: async rel => isDenied(rules, rel),
	...(note !== undefined && {note}),
});

// A stand-in for the rules module: the legacy yena.json export list decides the data, the code is unfiltered.
export const legacyProvider: RulesProvider = {
	exportFilter: async (target, part) => (part === 'code' ? {denied: async () => false} : target.legacyExport && filterFor(target.legacyExport)),
};
