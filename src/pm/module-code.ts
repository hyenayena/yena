import {readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import type {ExportFilter, Logger, ModuleDataFile, ModuleDataLimits, ModuleDataRead} from '../api.js';
import {MANIFEST_FILE} from './manifest.js';
import {pathProblem, readRegularFile, sizeText} from './module-data.js';
import {run} from './run.js';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', '.yena']);
const SECRET_NAMES = new Set(['.env', '.envrc', '.netrc', '.npmrc', '.pgpass']);
const ENV_VARIANT = /^\.env[._-]/;
const ENV_TEMPLATE = /^\.env(\.[^.]+)*\.(example|sample|template|dist)$/;
const SECRET_SUFFIX = /\.(pem|key|p12|pfx)$/i;
const SECRET_KEY_FILE = /^id_(rsa|dsa|ecdsa|ed25519)/;

export function isSecretLikeName(name: string): boolean {
	if (SECRET_NAMES.has(name)) return true;
	if (ENV_VARIANT.test(name)) return !ENV_TEMPLATE.test(name);
	return SECRET_SUFFIX.test(name) || SECRET_KEY_FILE.test(name);
}

async function exists(p: string) {
	return stat(p).then(
		() => true,
		() => false,
	);
}

type Counts = {secret: number; ignored: number; links: number; big: number; odd: number; unreadable: number; closed: number};

async function countFiles(dir: string): Promise<number> {
	const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
	let count = 0;
	for (const entry of entries) count += entry.isDirectory() ? await countFiles(path.join(dir, entry.name)) : 1;
	return count;
}

async function walkCandidates(dir: string, counts: Counts): Promise<string[]> {
	const found: string[] = [];
	const visit = async (current: string, rel: string) => {
		const entries = await readdir(current, {withFileTypes: true});
		for (const entry of entries) {
			const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
			const abs = path.join(current, entry.name);
			if (entry.isSymbolicLink()) counts.links++;
			else if (entry.isDirectory()) {
				if (EXCLUDED_DIRS.has(entry.name)) counts.ignored += await countFiles(abs);
				else await visit(abs, relPath);
			} else if (isSecretLikeName(entry.name)) counts.secret++;
			else found.push(relPath);
		}
	};
	await visit(dir, '');
	return found;
}

async function gitCandidates(dir: string, counts: Counts): Promise<string[]> {
	const out = await run('git', ['-c', 'core.fsmonitor=false', '-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
		env: {GIT_OPTIONAL_LOCKS: '0'},
		scrubEnv: true,
	});
	const found: string[] = [];
	for (const rel of new Set(out.split('\0').filter(Boolean))) {
		const parts = rel.split('/');
		if (parts.some(part => EXCLUDED_DIRS.has(part))) counts.ignored++;
		else if (isSecretLikeName(parts[parts.length - 1]!)) counts.secret++;
		else found.push(rel);
	}
	return found;
}

export async function readModuleCode(dir: string, limits: ModuleDataLimits, log?: Logger, filter?: ExportFilter): Promise<ModuleDataRead> {
	const name = path.basename(dir);
	const started = Date.now();
	const counts: Counts = {secret: 0, ignored: 0, links: 0, big: 0, odd: 0, unreadable: 0, closed: 0};
	const git = await exists(path.join(dir, '.git'));
	const candidates = git ? await gitCandidates(dir, counts) : await walkCandidates(dir, counts);

	const files: ModuleDataFile[] = [];
	let total = 0;
	for (const rel of candidates.sort()) {
		if (filter && (await filter.denied(rel, false))) {
			counts.closed++;
			continue;
		}
		if (pathProblem(rel)) {
			counts.odd++;
			continue;
		}
		const read = await readRegularFile(path.join(dir, ...rel.split('/')), limits.maxFileBytes);
		if (read.kind === 'big') counts.big++;
		else if (read.kind === 'special') counts.links++;
		else if (read.kind === 'file') {
			if (files.length + 1 > limits.maxFiles || total + read.file.data.byteLength > limits.maxTotalBytes) {
				throw new Error(`${name}'s code is larger than the export limit (${limits.maxFiles} files, ${sizeText(limits.maxTotalBytes)})`);
			}
			total += read.file.data.byteLength;
			files.push({path: rel, ...read.file});
		} else if (!git) counts.unreadable++;
	}
	if (!files.some(f => f.path === MANIFEST_FILE)) throw new Error(`${name}: its ${MANIFEST_FILE} would not be packed`);

	const notes: string[] = [];
	if (filter?.note !== undefined) notes.push(filter.note);
	if (counts.closed > 0) notes.push(`${counts.closed} files closed by its .yenarules not packed`);
	if (counts.secret > 0) notes.push(`${counts.secret} secret-like files not packed`);
	if (!git && counts.ignored > 0) notes.push(`${counts.ignored} ignored or dependency files not packed`);
	if (counts.big > 0) notes.push(`${counts.big} files over ${sizeText(limits.maxFileBytes)} skipped`);
	if (counts.links > 0) notes.push(`${counts.links} links or special files skipped`);
	if (counts.odd > 0) notes.push(`${counts.odd} files with unusable paths skipped`);
	if (counts.unreadable > 0) notes.push(`${counts.unreadable} unreadable files skipped`);
	const skipped = Object.values(counts).reduce((a, b) => a + b, 0);
	log?.info('module code read', {module: name, files: files.length, skipped, bytes: total, ms: Date.now() - started});
	return {files, skipped, notes, defaultDeny: false};
}
