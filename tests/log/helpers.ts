import {mkdtempSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHostLogger, type HostLoggerOptions} from '../../src/log/index.js';

export const SECRET = 'sk-ant-oat-TESTVALUE0123456789abcdef';

export const tmp = () => mkdtempSync(path.join(tmpdir(), 'yena-log-'));

export function setup(extra: Partial<HostLoggerOptions> & {env?: NodeJS.ProcessEnv} = {}) {
	const root = tmp();
	const warnings: string[] = [];
	const logger = createHostLogger({
		root,
		env: {},
		now: () => new Date('2026-10-18T09:12:03.456Z'),
		pid: 412,
		onWarn: m => warnings.push(m),
		...extra,
	});
	const read = () => (existsSync(logger.file) ? readFileSync(logger.file, 'utf8') : '');
	const lines = () => read().split('\n').filter(Boolean);
	const records = () => lines().map(l => JSON.parse(l) as Record<string, any>);
	return {root, logger, warnings, read, lines, records};
}
