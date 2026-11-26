import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {LogThreshold} from '../api.js';
import {isThreshold} from './config.js';

const FILE = 'log.json';

export async function readLogSetting(stateDir: string): Promise<LogThreshold | undefined> {
	try {
		const data = JSON.parse(await readFile(path.join(stateDir, FILE), 'utf8')) as {level?: unknown} | null;
		return isThreshold(data?.level) ? data.level : undefined;
	} catch {
		return undefined;
	}
}

export async function writeLogSetting(stateDir: string, level: LogThreshold): Promise<void> {
	await mkdir(stateDir, {recursive: true});
	const file = path.join(stateDir, FILE);
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify({level}, null, '\t') + '\n');
	await rename(tmp, file);
}
