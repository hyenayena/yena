import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';

/** Where yena starts from: the image (`/app`) or a working copy of the repo (dev mode, IMG-6). */
export type RootMode = 'image' | 'dev';

export type ModeState = {mode: RootMode; devRoot: string};

export const DEFAULT_DEV_ROOT = '/workplace/yena';
const FILE = 'mode.json';

/** Read before any module loads, so it is host state, not a module's. A missing or broken file means the image. */
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

/** A dev root must be able to start: the host source, its packages (`./yena install`) and core. */
export async function checkDevRoot(dir: string): Promise<void> {
	if (!path.isAbsolute(dir)) throw new Error(`The dev root must be an absolute path: ${dir}`);
	const missing: string[] = [];
	for (const {rel, dir: isDir} of REQUIRED) {
		const st = await stat(path.join(dir, rel)).catch(() => undefined);
		if (!st || st.isDirectory() !== isDir) missing.push(rel);
	}
	if (missing.length > 0) throw new Error(`${dir} cannot run yena: missing ${missing.join(', ')}`);
}

/** The mode the running process is in: dev when its code root is the configured dev root. */
export function runningMode(codeRoot: string, state: ModeState): RootMode {
	return path.resolve(codeRoot) === path.resolve(state.devRoot) ? 'dev' : 'image';
}
