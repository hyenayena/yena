import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';

export type RootMode = 'image' | 'dev';

export type ModeState = {mode: RootMode; devRoot: string};

export const DEFAULT_DEV_ROOT = '/workplace/yena';
const FILE = 'mode.json';

export async function readMode(stateDir: string): Promise<ModeState> {
	let data: unknown;
	try {
		data = JSON.parse(await readFile(path.join(stateDir, FILE), 'utf8'));
	} catch {
		return {mode: 'image', devRoot: DEFAULT_DEV_ROOT};
	}
	const raw = (data ?? {}) as Partial<Record<keyof ModeState, unknown>>;
	const devRoot = typeof raw.devRoot === 'string' && path.isAbsolute(raw.devRoot) ? raw.devRoot : DEFAULT_DEV_ROOT;
	return {mode: raw.mode === 'dev' ? 'dev' : 'image', devRoot};
}

export async function writeMode(stateDir: string, state: ModeState): Promise<void> {
	await mkdir(stateDir, {recursive: true});
	const file = path.join(stateDir, FILE);
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(state, null, '\t') + '\n');
	await rename(tmp, file);
}

const REQUIRED: {rel: string; dir: boolean}[] = [
	{rel: 'src/cli.ts', dir: false},
	{rel: 'node_modules', dir: true},
	{rel: 'modules/core', dir: true},
];

export async function checkDevRoot(dir: string): Promise<void> {
	if (!path.isAbsolute(dir)) throw new Error(`The dev root must be an absolute path: ${dir}`);
	const missing: string[] = [];
	for (const {rel, dir: isDir} of REQUIRED) {
		const st = await stat(path.join(dir, rel)).catch(() => undefined);
		if (!st || st.isDirectory() !== isDir) missing.push(rel);
	}
	if (missing.length > 0) throw new Error(`${dir} cannot run yena: missing ${missing.join(', ')}`);
}

export function runningMode(codeRoot: string, state: ModeState): RootMode {
	return path.resolve(codeRoot) === path.resolve(state.devRoot) ? 'dev' : 'image';
}
