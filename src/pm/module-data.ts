import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, open, readdir, rename, rmdir, unlink, utimes} from 'node:fs/promises';
import path from 'node:path';
import type {Logger, ModuleDataFile, ModuleDataLimits, ModuleDataRead, ModuleDataReplace, ModuleDataReplaced, ModuleExportRules} from '../api.js';
import {hasControlChars, isDenied} from './export-rules.js';
import {MODULE_NAME, RESERVED_NAMES} from './manifest.js';

export const MAX_PATH_BYTES = 240;
export const MAX_DEPTH = 32;

const MIB = 1024 * 1024;

export const sizeText = (bytes: number) => (bytes >= MIB ? `${Math.round(bytes / MIB)} MiB` : `${bytes} bytes`);

export function pathProblem(rel: string): string | undefined {
	if (rel === '') return 'is empty';
	if (rel.startsWith('/')) return 'is absolute';
	if (rel.includes('\\')) return 'has a backslash';
	if (hasControlChars(rel)) return 'has a control character';
	const parts = rel.split('/');
	if (parts.some(part => part === '' || part === '.' || part === '..')) return 'has an empty, "." or ".." segment';
	if (Buffer.byteLength(rel) > MAX_PATH_BYTES) return `is longer than ${MAX_PATH_BYTES} bytes`;
	if (parts.length > MAX_DEPTH) return `is deeper than ${MAX_DEPTH} levels`;
	return undefined;
}

export function checkModuleName(name: string) {
	if (RESERVED_NAMES.has(name)) throw new Error(`Module name "${name}" is reserved by yena`);
	if (!MODULE_NAME.test(name)) throw new Error('Invalid module name');
}

export type FileRead = {kind: 'file'; file: Omit<ModuleDataFile, 'path'>} | {kind: 'big'} | {kind: 'special'} | {kind: 'gone'};

export async function readRegularFile(abs: string, maxFileBytes: number): Promise<FileRead> {
	let handle;
	try {
		handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ELOOP' || code === 'ENXIO') return {kind: 'special'};
		return {kind: 'gone'};
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) return {kind: 'special'};
		if (info.size > maxFileBytes) return {kind: 'big'};
		const data = await handle.readFile();
		return {kind: 'file', file: {mode: info.mode & 0o777, mtimeMs: info.mtimeMs, data}};
	} catch {
		return {kind: 'gone'};
	} finally {
		await handle.close();
	}
}

async function countFiles(dir: string): Promise<number> {
	const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
	let count = 0;
	for (const entry of entries) count += entry.isDirectory() ? await countFiles(path.join(dir, entry.name)) : 1;
	return count;
}

const byPath = (a: {path: string}, b: {path: string}) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export async function readModuleData(
	root: string,
	name: string,
	rules: ModuleExportRules | undefined,
	limits: ModuleDataLimits,
	log?: Logger,
): Promise<ModuleDataRead> {
	checkModuleName(name);
	const started = Date.now();
	const base = path.join(root, name);
	const files: ModuleDataFile[] = [];
	const counts = {skipped: 0, big: 0, links: 0, odd: 0, unreadable: 0};
	let total = 0;

	if (rules === undefined) {
		const count = await countFiles(base);
		log?.info('module data read', {module: name, files: 0, skipped: count, bytes: 0, ms: Date.now() - started});
		return {files: [], skipped: count, notes: [], defaultDeny: true};
	}

	const tooLarge = () =>
		new Error(`${name}'s data is larger than the export limit (${limits.maxFiles} files, ${sizeText(limits.maxTotalBytes)})`);

	async function walk(dir: string, rel: string) {
		const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
			const abs = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				counts.links++;
				continue;
			}
			if (entry.isDirectory()) {
				if (isDenied(rules, relPath)) counts.skipped += await countFiles(abs);
				else if (pathProblem(relPath)) counts.odd += await countFiles(abs);
				else await walk(abs, relPath);
				continue;
			}
			if (isDenied(rules, relPath)) {
				counts.skipped++;
				continue;
			}
			if (!entry.isFile()) {
				counts.links++;
				continue;
			}
			if (pathProblem(relPath)) {
				counts.odd++;
				continue;
			}
			const read = await readRegularFile(abs, limits.maxFileBytes);
			if (read.kind === 'big') counts.big++;
			else if (read.kind === 'special') counts.links++;
			else if (read.kind === 'gone') counts.unreadable++;
			else {
				if (files.length + 1 > limits.maxFiles || total + read.file.data.byteLength > limits.maxTotalBytes) throw tooLarge();
				total += read.file.data.byteLength;
				files.push({path: relPath, ...read.file});
			}
		}
	}
	await walk(base, '');

	const notes: string[] = [];
	if (counts.big > 0) notes.push(`${counts.big} files over ${sizeText(limits.maxFileBytes)} skipped`);
	if (counts.links > 0) notes.push(`${counts.links} links or special files skipped`);
	if (counts.odd > 0) notes.push(`${counts.odd} files with unusable paths skipped`);
	if (counts.unreadable > 0) notes.push(`${counts.unreadable} unreadable files skipped`);
	const skipped = counts.skipped + counts.big + counts.links + counts.odd + counts.unreadable;
	files.sort(byPath);
	log?.info('module data read', {module: name, files: files.length, skipped, bytes: total, ms: Date.now() - started});
	return {files, skipped, notes, defaultDeny: false};
}

type Journal =
	| {op: 'wrote'; file: string}
	| {op: 'mkdir'; dir: string}
	| {op: 'moved'; from: string; to: string}
	| {op: 'rmdir'; dir: string; mode: number};

export type ReplaceOptions = {
	backupDir: string;
	rulesFor: (name: string) => ModuleExportRules | undefined;
	log?: Logger;
	beforeWrite?: (name: string, rel: string) => void | Promise<void>;
};

async function moveFile(from: string, to: string) {
	try {
		await rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
		const info = await lstat(from);
		if (!info.isFile()) throw error;
		await copyFile(from, to, constants.COPYFILE_EXCL);
		await utimes(to, info.atimeMs / 1000, info.mtimeMs / 1000);
		await unlink(from);
	}
}

async function exists(p: string) {
	return lstat(p).then(
		() => true,
		() => false,
	);
}

type Plan = {moves: string[]; dirs: {rel: string; mode: number}[]; kept: number};

async function planTarget(dir: string, rel: string, rules: ModuleExportRules, plan: Plan) {
	const entries = await readdir(dir, {withFileTypes: true});
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
		const abs = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) {
			plan.kept++;
		} else if (isDenied(rules, relPath)) {
			plan.kept += entry.isDirectory() ? await countFiles(abs) : 1;
		} else if (entry.isDirectory()) {
			await planTarget(abs, relPath, rules, plan);
			plan.dirs.push({rel: relPath, mode: (await lstat(abs)).mode & 0o777});
		} else {
			plan.moves.push(relPath);
		}
	}
}

export async function replaceModuleData(root: string, items: readonly ModuleDataReplace[], options: ReplaceOptions): Promise<ModuleDataReplaced[]> {
	const {backupDir, rulesFor, log} = options;
	const seen = new Set<string>();
	for (const item of items) {
		checkModuleName(item.name);
		if (seen.has(item.name)) throw new Error(`Module "${item.name}" is listed twice`);
		seen.add(item.name);
		const paths = new Set<string>();
		for (const file of item.files) {
			const problem = pathProblem(file.path);
			if (problem) throw new Error(`Invalid path in the data of ${item.name}: it ${problem}`);
			if (paths.has(file.path)) throw new Error(`Duplicate path in the data of ${item.name}`);
			paths.add(file.path);
		}
	}
	if (!path.isAbsolute(backupDir)) throw new Error('The backup folder must be an absolute path');
	if (await exists(backupDir)) throw new Error('The backup folder already exists');
	const rules = new Map(items.map(item => [item.name, rulesFor(item.name)]));
	for (const item of items) {
		const itemRules = rules.get(item.name);
		if (itemRules === undefined) continue;
		const rel = path.relative(path.join(root, item.name), backupDir);
		if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !isDenied(itemRules, rel.split(path.sep).join('/'))) {
			throw new Error(`The backup folder is inside the data of ${item.name}`);
		}
	}

	const journal: Journal[] = [];
	const results: ModuleDataReplaced[] = [];
	await mkdir(path.dirname(backupDir), {recursive: true});
	await mkdir(backupDir, {mode: 0o700});
	journal.push({op: 'mkdir', dir: backupDir});

	const ensureDir = async (dir: string, mode: number) => {
		const missing: string[] = [];
		for (let current = dir; !(await exists(current)); current = path.dirname(current)) missing.unshift(current);
		for (const d of missing) {
			await mkdir(d, {mode});
			journal.push({op: 'mkdir', dir: d});
		}
	};

	try {
		for (const item of items) {
			const itemRules = rules.get(item.name);
			if (itemRules === undefined) {
				results.push({name: item.name, written: 0, removed: 0, kept: 0, skipped: item.files.length, defaultDeny: true});
				log?.info('module data replaced', {module: item.name, written: 0, removed: 0, kept: 0, skipped: item.files.length});
				continue;
			}
			const target = path.join(root, item.name);
			await ensureDir(target, 0o755);
			const info = await lstat(target);
			if (!info.isDirectory()) throw new Error(`The data of ${item.name} is not a folder`);

			const plan: Plan = {moves: [], dirs: [], kept: 0};
			await planTarget(target, '', itemRules, plan);
			for (const rel of plan.moves) {
				const dest = path.join(backupDir, item.name, rel);
				await ensureDir(path.dirname(dest), 0o700);
				await moveFile(path.join(target, rel), dest);
				journal.push({op: 'moved', from: path.join(target, rel), to: dest});
			}
			for (const dir of plan.dirs) {
				const abs = path.join(target, dir.rel);
				const left = await readdir(abs).catch(() => ['?']);
				if (left.length > 0) continue;
				await rmdir(abs);
				journal.push({op: 'rmdir', dir: abs, mode: dir.mode});
			}

			let written = 0;
			let skipped = 0;
			for (const file of item.files) {
				if (isDenied(itemRules, file.path)) {
					skipped++;
					continue;
				}
				const parts = file.path.split('/');
				const abs = path.join(target, ...parts);
				let blocked = false;
				let current = target;
				for (const part of parts.slice(0, -1)) {
					current = path.join(current, part);
					const stat = await lstat(current).catch(() => undefined);
					if (stat === undefined) {
						await mkdir(current, {mode: 0o755});
						journal.push({op: 'mkdir', dir: current});
					} else if (!stat.isDirectory()) {
						blocked = true;
						break;
					}
				}
				if (blocked) {
					skipped++;
					continue;
				}
				await options.beforeWrite?.(item.name, file.path);
				const mode = file.mode & 0o777;
				let handle;
				try {
					handle = await open(abs, 'wx', mode);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
						skipped++;
						continue;
					}
					throw error;
				}
				journal.push({op: 'wrote', file: abs});
				try {
					await handle.writeFile(file.data);
					await handle.chmod(mode);
					const seconds = file.mtimeMs / 1000;
					await handle.utimes(seconds, seconds);
				} finally {
					await handle.close();
				}
				written++;
			}
			results.push({name: item.name, written, removed: plan.moves.length, kept: plan.kept, skipped, defaultDeny: false});
			log?.info('module data replaced', {module: item.name, written, removed: plan.moves.length, kept: plan.kept, skipped});
		}
	} catch (error) {
		const failures = await rollback(journal);
		const message = (error as Error).message;
		if (failures > 0) {
			throw new Error(`Import failed and could not be fully rolled back: ${message}. The replaced files are in ${backupDir}`);
		}
		throw new Error(`Import failed and was rolled back: ${message}`);
	}
	return results;
}

async function rollback(journal: readonly Journal[]): Promise<number> {
	let failures = 0;
	for (const entry of [...journal].reverse()) {
		try {
			if (entry.op === 'wrote') await unlink(entry.file);
			else if (entry.op === 'moved') await moveFile(entry.to, entry.from);
			else if (entry.op === 'rmdir') await mkdir(entry.dir, {mode: entry.mode});
			else await rmdir(entry.dir);
		} catch {
			failures++;
		}
	}
	return failures;
}
