import type {ModuleExportRules} from '../api.js';

const MAX_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 200;
const FORM = '"export" must be {"deny": ["<pattern>", …]}';

export function hasControlChars(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
	}
	return false;
}

export function parseExportRules(raw: unknown): ModuleExportRules {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(FORM);
	const keys = Object.keys(raw);
	if (keys.length !== 1 || keys[0] !== 'deny') throw new Error(FORM);
	const deny = (raw as {deny: unknown}).deny;
	if (!Array.isArray(deny)) throw new Error(FORM);
	if (deny.length > MAX_PATTERNS) throw new Error(`"export.deny" has more than ${MAX_PATTERNS} patterns`);
	for (const pattern of deny) {
		if (typeof pattern !== 'string') throw new Error(FORM);
		const shown = JSON.stringify(pattern.slice(0, 64));
		if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
			throw new Error(`"export.deny" patterns must be 1 to ${MAX_PATTERN_LENGTH} characters`);
		}
		if (pattern.startsWith('/') || pattern.includes('\\')) {
			throw new Error(`"export.deny" pattern ${shown} must be relative and use "/" separators`);
		}
		if (hasControlChars(pattern)) throw new Error(`"export.deny" pattern ${shown} has a control character`);
		if (pattern.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
			throw new Error(`"export.deny" pattern ${shown} has an empty, "." or ".." segment`);
		}
	}
	return {deny: [...(deny as string[])]};
}
