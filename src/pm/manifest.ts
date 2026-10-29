import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {CredentialAccess} from '../api.js';

export const MANIFEST_FILE = 'yena.json';

export type Manifest = {
	name: string;
	version: string;
	description?: string;
	runtime?: string;
	entry?: string;
	install?: string;
	headless?: string;
	dependencies: Record<string, string>;
	/** Credential kinds the module uses through `host.credentials`; `{}` when it declares none. */
	credentials?: Record<string, CredentialAccess>;
};

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const KIND = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_KINDS = 20;

/** `host` is the host's own state directory in `YENA_DATA`, next to the modules' data directories. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['host']);

export async function readManifest(dir: string): Promise<Manifest> {
	const file = path.join(dir, MANIFEST_FILE);
	let raw: string;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		throw new Error(`Module has no ${MANIFEST_FILE}`);
	}

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

	const deps = m.dependencies ?? {};
	if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) {
		fail('"dependencies" must be an object { name: source }');
	}
	for (const [name, source] of Object.entries(deps as object)) {
		if (!NAME.test(name) || typeof source !== 'string') fail(`invalid dependency "${name}"`);
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
		dependencies: deps as Record<string, string>,
		credentials: Object.fromEntries(kinds) as Record<string, CredentialAccess>,
	};
}
