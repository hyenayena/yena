import type {LogFields} from '../api.js';

export type Scrub = {
	redact: (text: string) => string;
	ctl: number;
};

const PRE_CAP = 32 * 1024;
export const MESSAGE_CAP = 4 * 1024;
const FIELD_CAP = 1024;
const STACK_CAP = 4 * 1024;
const KEY_CAP = 64;
const MAX_DEPTH = 3;
const MAX_ITEMS = 20;

// Order matters: OSC/DCS-style strings and CSI must be consumed whole before the generic ESC fallback.
const ESCAPES = new RegExp(
	[
		'\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?',
		'\\u001b[PX^_][^\\u001b]*(?:\\u001b\\\\)?',
		'\\u001b\\[[0-?]*[ -/]*[@-~]?',
		'\\u001b[\\s\\S]?',
	].join('|'),
	'g',
);
const INVISIBLE = /[\u0080-\u009f\u2028\u2029]|\p{Cf}/gu;
const POST_ESCAPE = /[\u007f-\u009f\u2028\u2029]/g;

const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential/i;
const OMIT_KEY = /^(prompt|text|content|body|input|output|stdin|stdout|env|headers)$/i;
const ERROR_PRIMITIVES = ['code', 'status', 'errno', 'syscall'] as const;

export function cleanText(scrub: Scrub, input: unknown, cap: number): string {
	let text = typeof input === 'string' ? input : safeString(input);
	if (text.length > PRE_CAP) text = text.slice(0, PRE_CAP);
	text = text.replace(ESCAPES, () => {
		scrub.ctl++;
		return '';
	});
	text = text.replace(INVISIBLE, () => {
		scrub.ctl++;
		return '';
	});
	text = scrub.redact(text);
	if (text.length > cap) {
		const removed = text.length - cap;
		text = `${text.slice(0, cap)}…[truncated ${removed} chars]`;
	}
	return text;
}

function safeString(value: unknown): string {
	try {
		return String(value);
	} catch {
		return '[Unserializable]';
	}
}

export function escapeLine(json: string): string {
	return json.replace(POST_ESCAPE, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function omitted(value: unknown): string {
	if (typeof value === 'string') return `[omitted ${value.length} chars]`;
	if (ArrayBuffer.isView(value)) return `[omitted ${value.byteLength} bytes]`;
	return '[omitted]';
}

function className(scrub: Scrub, value: object): string {
	try {
		const name = (Object.getPrototypeOf(value) as {constructor?: {name?: unknown}} | null)?.constructor?.name;
		return typeof name === 'string' && name ? cleanText(scrub, name, KEY_CAP) : 'Object';
	} catch {
		return 'Object';
	}
}

export function serializeValue(scrub: Scrub, value: unknown, depth: number, seen: Set<object>): unknown {
	try {
		return convert(scrub, value, depth, seen);
	} catch {
		return '[Unserializable]';
	}
}

function convert(scrub: Scrub, value: unknown, depth: number, seen: Set<object>): unknown {
	switch (typeof value) {
		case 'string':
			return cleanText(scrub, value, FIELD_CAP);
		case 'number':
			return Number.isFinite(value) ? value : String(value);
		case 'boolean':
			return value;
		case 'undefined':
			return null;
		case 'bigint':
			return `${value}n`;
		case 'symbol':
			return '[Symbol]';
		case 'function':
			return '[Function]';
	}
	if (value === null) return null;
	const obj = value as object;

	if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
		return `[Buffer ${obj.byteLength} bytes]`;
	}
	if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
	if (obj instanceof Map) return `[Map ${obj.size}]`;
	if (obj instanceof Set) return `[Set ${obj.size}]`;
	if (seen.has(obj)) return '[Circular]';
	if (obj instanceof Error) return serializeError(scrub, obj, depth, seen);

	if (Array.isArray(obj)) {
		if (depth >= MAX_DEPTH) return '[Array]';
		seen.add(obj);
		try {
			const out: unknown[] = [];
			const length = obj.length;
			for (let i = 0; i < Math.min(length, MAX_ITEMS); i++) {
				out.push(serializeValue(scrub, obj[i], depth + 1, seen));
			}
			if (length > MAX_ITEMS) out.push(`[${length - MAX_ITEMS} more]`);
			return out;
		} finally {
			seen.delete(obj);
		}
	}

	const proto = Object.getPrototypeOf(obj);
	if (proto !== Object.prototype && proto !== null) return `[${className(scrub, obj)}]`;
	if (depth >= MAX_DEPTH) return '[Object]';
	return serializeObject(scrub, obj as Record<string, unknown>, depth + 1, seen);
}

export function serializeObject(
	scrub: Scrub,
	obj: Record<string, unknown>,
	depth: number,
	seen: Set<object>,
): Record<string, unknown> {
	seen.add(obj);
	try {
		const out: Record<string, unknown> = {};
		const keys = Object.keys(obj);
		for (const key of keys.slice(0, MAX_ITEMS)) {
			const safeKey = cleanText(scrub, key, KEY_CAP);
			let raw: unknown;
			try {
				raw = obj[key];
			} catch {
				out[safeKey] = '[Unserializable]';
				continue;
			}
			if (SECRET_KEY.test(key) && !(typeof raw === 'number' && /tokens$/i.test(key))) {
				out[safeKey] = '[redacted]';
			} else if (OMIT_KEY.test(key)) {
				out[safeKey] = omitted(raw);
			} else {
				out[safeKey] = serializeValue(scrub, raw, depth, seen);
			}
		}
		if (keys.length > MAX_ITEMS) out['…'] = `${keys.length - MAX_ITEMS} more keys`;
		return out;
	} finally {
		seen.delete(obj);
	}
}

function serializeError(scrub: Scrub, err: Error, depth: number, seen: Set<object>): Record<string, unknown> {
	seen.add(err);
	try {
		const out: Record<string, unknown> = {};
		out.name = cleanText(scrub, readProp(err, 'name'), KEY_CAP);
		out.message = cleanText(scrub, readProp(err, 'message'), MESSAGE_CAP);
		const stack = readProp(err, 'stack');
		if (typeof stack === 'string') out.stack = cleanText(scrub, stack, STACK_CAP);
		for (const key of ERROR_PRIMITIVES) {
			const v = readProp(err, key);
			if (typeof v === 'string') out[key] = cleanText(scrub, v, KEY_CAP);
			else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
		}
		if (depth >= MAX_DEPTH) return out;
		const cause = readProp(err, 'cause');
		if (cause !== undefined) out.cause = serializeValue(scrub, cause, depth + 1, seen);
		const members = readProp(err, 'errors');
		if (err instanceof AggregateError && Array.isArray(members)) {
			out.errors = members.slice(0, 3).map(m => serializeValue(scrub, m, depth + 1, seen));
		}
		return out;
	} finally {
		seen.delete(err);
	}
}

function readProp(obj: object, key: string): unknown {
	try {
		return (obj as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

export function serializeFields(scrub: Scrub, fields: LogFields | undefined): Record<string, unknown> | undefined {
	if (fields === undefined || fields === null || typeof fields !== 'object') return undefined;
	const out = serializeObject(scrub, fields, 0, new Set());
	return Object.keys(out).length ? out : undefined;
}
