import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {CredentialAccess} from '../api.js';
import {parseRange} from './versions.js';

export const MANIFEST_FILE = 'yena.json';

export type Dependency = {source: string; range: string; optional: boolean};

export type Manifest = {
	name: string;
	version: string;
	description?: string;
	runtime?: string;
	entry?: string;
	install?: string;
	headless?: string;
	dependencies: Record<string, Dependency>;
	credentials?: Record<string, CredentialAccess>;
};

const DEP_FIELDS = new Set(['source', 'version', 'optional']);
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const KIND = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_KINDS = 20;

export const RESERVED_NAMES: ReadonlySet<string> = new Set(['host']);

export async function readManifest(dir: string): Promise<Manifest> {
	const file = path.join(dir, MANIFEST_FILE);
	let raw: string;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		throw new Error(`Module has no ${MANIFEST_FILE}`);
	}

	return parseManifest(raw);
}

export function parseManifest(raw: string): Manifest {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`);
	}
	return validate(data);
}

function validate(data: unknown): Manifest {
	const fail = (msg: string): never => {
		throw new Error(`${MANIFEST_FILE}: ${msg}`);
	};
	if (typeof data !== 'object' || data === null || Array.isArray(data)) fail('expected an object');
	const m = data as Record<string, unknown>;

	if (typeof m.name !== 'string' || !NAME.test(m.name)) {
		fail('"name" is required: lowercase letters, digits, ".", "_" or "-"');
	}
	if (RESERVED_NAMES.has(m.name as string)) fail(`"name" "${m.name as string}" is reserved by yena`);
	if (typeof m.version !== 'string' || !m.version) fail('"version" is required');

	for (const key of ['description', 'runtime', 'entry', 'install', 'headless'] as const) {
		if (m[key] !== undefined && typeof m[key] !== 'string') fail(`"${key}" must be a string`);
	}

	const rawDeps = m.dependencies ?? {};
	if (typeof rawDeps !== 'object' || rawDeps === null || Array.isArray(rawDeps)) {
		fail('"dependencies" must be an object { name: {"source": "<source>", "version": "^x.y.z"} }');
	}
	const deps: Record<string, Dependency> = {};
	for (const [name, value] of Object.entries(rawDeps as object)) {
		if (!NAME.test(name)) fail(`invalid dependency "${name}"`);
		if (name === m.name) fail(`"${name}" cannot depend on itself`);
		const noVersion = `dependency "${name}" has no version; write {"source": "${name}", "version": "^x.y.z"}`;
		if (typeof value === 'string') fail(noVersion);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`invalid dependency "${name}"`);
		const d = value as Record<string, unknown>;
		for (const key of Object.keys(d)) if (!DEP_FIELDS.has(key)) fail(`dependency "${name}" has an unknown field "${key}"`);
		const {source, version} = d;
		if (typeof source !== 'string' || !source) fail(`dependency "${name}" needs "source": a non-empty string`);
		if (version === undefined) fail(noVersion);
		if (typeof version !== 'string' || !parseRange(version)) {
			fail(`dependency "${name}" has an invalid version ${JSON.stringify(version)}; use "^x.y.z" or "x.y.z"`);
		}
		if (d.optional !== undefined && typeof d.optional !== 'boolean') fail(`dependency "${name}": "optional" must be true or false`);
		deps[name] = {source: source as string, range: version as string, optional: d.optional === true};
	}

	const creds = m.credentials ?? {};
	if (typeof creds !== 'object' || creds === null || Array.isArray(creds)) {
		fail('"credentials" must be an object { kind: "read" | "write" }');
	}
	const kinds = Object.entries(creds as object);
	if (kinds.length > MAX_KINDS) fail(`"credentials" declares more than ${MAX_KINDS} kinds`);
	for (const [kind, access] of kinds) {
		if (!KIND.test(kind) || (access !== 'read' && access !== 'write')) fail(`invalid credentials "${kind}"`);
	}

	return {
		name: m.name as string,
		version: m.version as string,
		description: m.description as string | undefined,
		runtime: m.runtime as string | undefined,
		entry: m.entry as string | undefined,
		install: m.install as string | undefined,
		headless: m.headless as string | undefined,
		dependencies: deps,
		credentials: Object.fromEntries(kinds) as Record<string, CredentialAccess>,
	};
}
