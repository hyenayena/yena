import {readdir, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readManifest} from './manifest.js';
import {install, modulesDir, root} from './manager.js';
import {run, type Log} from './run.js';

/** What went into the image (`/app/yena-image.json`), for `mod list`. */
export type ImageRecord = {
	builtAt: string;
	modules: {name: string; version: string; from: 'local' | 'lock'; source?: string; commit?: string}[];
};

export const IMAGE_RECORD = 'yena-image.json';
const LOCK_FILE = 'yena-modules.json';

const subdirs = async (dir: string): Promise<string[]> =>
	(await readdir(dir, {withFileTypes: true}).catch(() => []))
		.filter(e => e.isDirectory() && !e.name.startsWith('.'))
		.map(e => e.name)
		.sort();

const exists = (p: string) =>
	stat(p).then(
		() => true,
		() => false,
	);

/**
 * Runs in `docker build`, without `YENA_DATA`, so the root's `modules/` is writable: the local module
 * copies came with the build context (no `.git`, no `node_modules`), so their install scripts run here;
 * modules the lock lists but the context lacks are fetched (https) and installed by the usual pipeline.
 */
export async function bakeModules(log: Log): Promise<ImageRecord> {
	if (process.env.YENA_DATA) throw new Error('bakeModules runs at image build time, without YENA_DATA');
	const local = await subdirs(modulesDir);
	// Missing modules first: their dependencies may be what a local copy's install script needs.
	await install([], log);
	if (!(await exists(path.join(modulesDir, 'core')))) await install(['core'], log);
	for (const name of local) {
		const dir = path.join(modulesDir, name);
		const manifest = await readManifest(dir);
		if (!manifest.install) continue;
		log(`$ ${name}: ${manifest.install}`);
		await run(manifest.install, [], {cwd: dir, shell: true, log, scrubEnv: true});
	}

	const lock = JSON.parse(await readFile(path.join(root, LOCK_FILE), 'utf8').catch(() => '{}')) as {
		modules?: Record<string, {source?: string; commit?: string}>;
	};
	const record: ImageRecord = {builtAt: new Date().toISOString(), modules: []};
	for (const name of await subdirs(modulesDir)) {
		const manifest = await readManifest(path.join(modulesDir, name));
		const entry = lock.modules?.[name];
		const fromLock = !local.includes(name);
		record.modules.push({
			name,
			version: manifest.version,
			from: fromLock ? 'lock' : 'local',
			...(entry?.source && {source: entry.source}),
			...(fromLock && entry?.commit && {commit: entry.commit}),
		});
	}
	await writeFile(path.join(root, IMAGE_RECORD), JSON.stringify(record, null, '\t') + '\n');
	return record;
}

export async function readImageRecord(codeRoot: string = root): Promise<ImageRecord | undefined> {
	try {
		const data = JSON.parse(await readFile(path.join(codeRoot, IMAGE_RECORD), 'utf8')) as Partial<ImageRecord>;
		return typeof data.builtAt === 'string' && Array.isArray(data.modules) ? (data as ImageRecord) : undefined;
	} catch {
		return undefined;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const record = await bakeModules(line => console.log(line));
	console.log(`Image modules: ${record.modules.map(m => `${m.name}@${m.version} (${m.from})`).join(', ')}`);
}
