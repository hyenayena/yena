export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

export type LogConfig = {enabled: boolean; level: LogLevel; warnings: string[]};

export function readLogConfig(env: NodeJS.ProcessEnv): LogConfig {
	const warnings: string[] = [];
	let enabled = true;
	let level: LogLevel = 'info';

	const rawOn = env.YENA_LOG?.trim().toLowerCase();
	if (rawOn) {
		if (['off', '0', 'false', 'no'].includes(rawOn)) enabled = false;
		else if (!['on', '1', 'true', 'yes'].includes(rawOn)) {
			warnings.push(`Warning: YENA_LOG=${JSON.stringify(env.YENA_LOG)} is not valid (on|off); using on`);
		}
	}

	const rawLevel = env.YENA_LOG_LEVEL?.trim().toLowerCase();
	if (rawLevel) {
		if ((LEVELS as readonly string[]).includes(rawLevel)) level = rawLevel as LogLevel;
		else {
			warnings.push(
				`Warning: YENA_LOG_LEVEL=${JSON.stringify(env.YENA_LOG_LEVEL)} is not valid (error|warn|info|debug); using info`,
			);
		}
	}
	return {enabled, level, warnings};
}
