import {readFile} from 'node:fs/promises';
import path from 'node:path';

export const MANIFEST_FILE = 'yena.json';

export type Manifest = {
	name: string;
	version: string;
	description?: string;
	runtime?: string;
	entry?: string;
	install?: string;
	dependencies: Record<string, string>;
};

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

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
	if (typeof m.version !== 'string' || !m.version) fail('"version" is required');

	for (const key of ['description', 'runtime', 'entry', 'install'] as const) {
		if (m[key] !== undefined && typeof m[key] !== 'string') fail(`"${key}" must be a string`);
	}

	const deps = m.dependencies ?? {};
	if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) {
		fail('"dependencies" must be an object { name: source }');
	}
	for (const [name, source] of Object.entries(deps as object)) {
		if (!NAME.test(name) || typeof source !== 'string') fail(`invalid dependency "${name}"`);
	}

	return {
		name: m.name as string,
		version: m.version as string,
		description: m.description as string | undefined,
		runtime: m.runtime as string | undefined,
		entry: m.entry as string | undefined,
		install: m.install as string | undefined,
		dependencies: deps as Record<string, string>,
	};
}
