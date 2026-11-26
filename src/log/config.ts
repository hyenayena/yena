import type {LogLevel, LogThreshold} from '../api.js';

export type {LogLevel, LogThreshold};

export const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

export const THRESHOLDS: readonly LogThreshold[] = ['off', 'error', 'warn', 'info', 'debug'];

export type LogLevelSource = 'environment' | 'setting' | 'default';

export type ResolvedLogLevel = {
	level: LogThreshold;
	source: LogLevelSource;
	variable?: 'YENA_LOG' | 'YENA_LOG_LEVEL';
	warnings: string[];
};

export const isThreshold = (value: unknown): value is LogThreshold =>
	typeof value === 'string' && (THRESHOLDS as readonly string[]).includes(value);

export function resolveLogLevel(env: NodeJS.ProcessEnv, stored?: LogThreshold): ResolvedLogLevel {
	const warnings: string[] = [];
	const fallback: Pick<ResolvedLogLevel, 'level' | 'source'> =
		stored !== undefined && isThreshold(stored) ? {level: stored, source: 'setting'} : {level: 'info', source: 'default'};
	const usingFallback = fallback.source === 'setting' ? 'the setting' : 'info';

	const rawOn = env.YENA_LOG?.trim().toLowerCase();
	if (rawOn) {
		if (['off', '0', 'false', 'no'].includes(rawOn)) return {level: 'off', source: 'environment', variable: 'YENA_LOG', warnings};
		if (!['on', '1', 'true', 'yes'].includes(rawOn)) {
			warnings.push(`Warning: YENA_LOG=${JSON.stringify(env.YENA_LOG)} is not valid (on|off); ignoring it`);
		}
	}

	const rawLevel = env.YENA_LOG_LEVEL?.trim().toLowerCase();
	if (rawLevel) {
		if (isThreshold(rawLevel)) return {level: rawLevel, source: 'environment', variable: 'YENA_LOG_LEVEL', warnings};
		warnings.push(
			`Warning: YENA_LOG_LEVEL=${JSON.stringify(env.YENA_LOG_LEVEL)} is not valid (error|warn|info|debug|off); using ${usingFallback}`,
		);
	}
	return {...fallback, warnings};
}
