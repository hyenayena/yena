import type {Command, LogThreshold, Setting, Subcommand} from './api.js';
import {isThreshold, THRESHOLDS} from './log/config.js';
import type {HostLogger} from './log/logger.js';
import {writeLogSetting} from './log/setting.js';
import {usageError} from './usage-error.js';

export type LogCommandOptions = {
	logger: HostLogger;
	stateDir: string;
	writable: boolean;
};

const USAGE = 'log <subcommand>';
const ECHO_CAP = 64;

const VALUE_DOCS: Record<LogThreshold, string> = {
	error: 'Write only errors',
	warn: 'Write warnings and errors',
	info: 'Write the default records',
	debug: 'Write detailed records; treat the log as sensitive',
	off: 'Write no log file',
};

const LEVEL_VALUES: readonly LogThreshold[] = [...THRESHOLDS.slice(1), 'off'];

const subcommands: Subcommand[] = [
	{
		name: 'level',
		usage: 'log level [level]',
		description: 'Show the log level, or change it at once',
		args: [{name: 'level', description: 'error, warn, info, debug or off (none: show)', optional: true}],
		agent: 'safe',
		subcommands: LEVEL_VALUES.map(value => ({
			name: value,
			usage: `log level ${value}`,
			description: VALUE_DOCS[value],
			agent: 'confirm' as const,
		})),
	},
];

const clip = (text: string) => (text.length > ECHO_CAP ? `${text.slice(0, ECHO_CAP)}…` : text);

const fixedBy = (logger: HostLogger): string | undefined => {
	const {source, variable} = logger.levelSource();
	return source === 'environment' ? variable : undefined;
};

const describe = (logger: HostLogger): string => {
	const {source, variable} = logger.levelSource();
	const where = source === 'environment' ? `environment: ${variable}` : source;
	return `Log level: ${logger.level()} (${where})`;
};

async function change(opts: LogCommandOptions, value: LogThreshold): Promise<void> {
	const {logger} = opts;
	const variable = fixedBy(logger);
	if (variable) {
		throw new Error(`The log level is set by ${variable} in the environment and cannot be changed here; unset it and restart yena`);
	}
	if (!opts.writable) throw new Error('The log level setting needs YENA_DATA: it is kept in the host state there');
	const previous = logger.level();
	const applied = logger.setLevel(value);
	if (!applied.ok) throw new Error(`Cannot write the log file (${applied.code}); the log level is unchanged`);
	try {
		await writeLogSetting(opts.stateDir, value);
	} catch (err) {
		logger.setLevel(previous);
		throw err;
	}
}

export function createLogCommand(opts: LogCommandOptions): Command {
	return {
		name: 'log',
		description: 'Show or change what yena writes to its log',
		usage: USAGE,
		args: [{name: 'subcommand', description: 'What to do (none: help)'}],
		subcommands,
		agent: 'safe',
		run: async ([sub, ...rest], ctx) => {
			if (sub === undefined) return ctx.showHelp ? ctx.showHelp() : ctx.print(USAGE);
			if (sub === 'help') return ctx.showHelp ? ctx.showHelp() : ctx.print(USAGE);
			if (sub !== 'level') throw usageError(`Unknown subcommand "${clip(sub)}". See log help`);
			const [value, ...extra] = rest;
			if (value === undefined) {
				ctx.print(describe(opts.logger));
				return;
			}
			if (extra.length > 0) throw usageError('log level takes at most one level');
			if (!isThreshold(value)) {
				throw Object.assign(new Error(`Unknown log level "${clip(value)}". Use error, warn, info, debug or off`), {kind: 'invalid' as const});
			}
			await change(opts, value);
			ctx.print(`Log level: ${value}. Applies now; other running yena processes follow on their next start.`);
		},
	};
}

export function logLevelSetting(opts: LogCommandOptions): Setting {
	const variable = fixedBy(opts.logger);
	const reason = `Set by ${variable} in the environment; unset it and restart yena to change it here`;
	return {
		key: 'log-level',
		label: 'Log level',
		description: variable ? reason : 'Applies at once.',
		options: [
			{value: 'error', label: 'error', description: VALUE_DOCS.error},
			{value: 'warn', label: 'warn', description: VALUE_DOCS.warn},
			{value: 'info', label: 'info', description: 'Default'},
			{value: 'debug', label: 'debug', description: VALUE_DOCS.debug},
			{value: 'off', label: 'off', description: 'No log file is written'},
		],
		get: () => opts.logger.level(),
		set: async value => {
			if (!isThreshold(value)) throw new Error(`Unknown log level "${clip(value)}"`);
			await change(opts, value);
		},
		...(variable && {readOnly: reason}),
	};
}
