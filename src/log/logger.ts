import path from 'node:path';
import type {LogFields, Logger, LogThreshold} from '../api.js';
import {escapes} from '../pm/paths.js';
import {isThreshold, LEVELS, resolveLogLevel, type LogLevel, type LogLevelSource, type ResolvedLogLevel} from './config.js';
import {noopLogger} from './noop.js';
import {createRedactor, type Redactor} from './redact.js';
import {cleanText, escapeLine, MESSAGE_CAP, serializeFields, type Scrub} from './sanitize.js';
import {openSink, type Sink, type SinkIo} from './sink.js';

export type HostLogger = Logger & {
	close(): void;
	readonly file: string;
	level(): LogThreshold;
	onLevel(listener: (level: LogThreshold) => void): () => void;
	levelSource(): {source: LogLevelSource; variable?: 'YENA_LOG' | 'YENA_LOG_LEVEL'};
	setLevel(level: LogThreshold): {ok: true} | {ok: false; code: string};
};

export type HostLoggerOptions = {
	root: string;
	env: NodeJS.ProcessEnv;
	setting?: LogThreshold;
	dir?: string;
	now?: () => Date;
	pid?: number;
	onWarn?: (message: string) => void;
	maxBytes?: number;
	generations?: number;
	io?: Partial<SinkIo>;
};

const MAX_RECORD_BYTES = 8 * 1024;
const SCOPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const MAX_LISTENERS = 64;

const disabled = (redactor: Redactor, resolved: ResolvedLogLevel): HostLogger => {
	const logger: HostLogger = {
		...noopLogger,
		child: () => logger,
		addRedactor: redact => redactor.add(redact),
		redact: text => redactor.apply(text),
		close() {},
		file: '',
		level: () => resolved.level,
		onLevel: () => () => {},
		levelSource: () => ({source: resolved.source, ...(resolved.variable && {variable: resolved.variable})}),
		setLevel: () => ({ok: false, code: 'EPERM'}),
	};
	return logger;
};

export function createHostLogger(opts: HostLoggerOptions): HostLogger {
	const onWarn = opts.onWarn ?? ((message: string) => process.stderr.write(`${message}\n`));
	const warn = (message: string) => {
		try {
			onWarn(message);
		} catch {
		}
	};

	const redactor = createRedactor();
	const config = resolveLogLevel(opts.env, opts.setting);
	for (const message of config.warnings) warn(message);

	const dir = path.resolve(opts.dir ?? path.join(opts.root, 'logs'));
	if (escapes(path.resolve(opts.root), dir)) {
		warn('Warning: cannot write the log file (EPERM); logging is disabled');
		return disabled(redactor, config);
	}

	const now = opts.now ?? (() => new Date());
	const pid = opts.pid ?? process.pid;
	let level: LogThreshold = config.level;
	let source: LogLevelSource = config.source;
	let variable = config.variable;
	let threshold = level === 'off' ? -1 : LEVELS.indexOf(level);
	const listeners = new Set<(level: LogThreshold) => void>();

	const render = (level: LogLevel, scope: string, message: unknown, fields?: LogFields): string => {
		const scrub: Scrub = {redact: redactor.apply, ctl: 0};
		const build = (msg: string, data: Record<string, unknown> | undefined) => {
			const record: Record<string, unknown> = {ts: now().toISOString(), level, scope, pid, msg};
			if (data) record.data = data;
			if (scrub.ctl > 0) record.ctl = scrub.ctl;
			return escapeLine(JSON.stringify(record));
		};
		const msg = cleanText(scrub, message, MESSAGE_CAP);
		let line = build(msg, serializeFields(scrub, fields));
		if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
			line = build(msg, {truncated: true});
			if (Buffer.byteLength(line) > MAX_RECORD_BYTES) line = build(msg.slice(0, 1024), {truncated: true});
		}
		return line;
	};

	let sink: Sink | undefined;
	const openNow = (): Sink =>
		openSink({
			dir,
			maxBytes: opts.maxBytes ?? 4 * 1024 * 1024,
			generations: opts.generations ?? 3,
			io: opts.io,
			dropNotice: n => render('warn', 'log', `log: ${n} records dropped`),
		});
	const codeOf = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';

	if (level !== 'off') {
		try {
			sink = openNow();
		} catch (err) {
			warn(`Warning: cannot write the log file (${codeOf(err)}); logging is disabled`);
			return disabled(redactor, config);
		}
	}

	const subscribe = (listener: (level: LogThreshold) => void) => {
		if (listeners.size >= MAX_LISTENERS) return () => {};
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	const make = (scope: string): Logger => {
		const emit = (at: LogLevel) => (message: string, fields?: LogFields) => {
			try {
				if (LEVELS.indexOf(at) > threshold) return;
				sink?.write(render(at, scope || 'host', message, fields));
			} catch {
			}
		};
		return {
			error: emit('error'),
			warn: emit('warn'),
			info: emit('info'),
			debug: emit('debug'),
			child(name) {
				const valid = typeof name === 'string' && SCOPE.test(name) ? name : 'invalid';
				return make(scope ? `${scope}.${valid}` : valid);
			},
			addRedactor(redact) {
				try {
					redactor.add(redact);
				} catch {
				}
			},
			redact: text => redactor.apply(text),
			level: () => level,
			onLevel: subscribe,
		};
	};

	const noteChange = (from: LogThreshold, to: LogThreshold) => {
		try {
			sink?.write(render('info', 'log', 'level changed', {from, to}));
		} catch {
		}
	};

	const setLevel = (next: LogThreshold): {ok: true} | {ok: false; code: string} => {
		if (!isThreshold(next)) return {ok: false, code: 'EINVAL'};
		if (next === level) return {ok: true};
		if (next !== 'off' && !sink) {
			try {
				sink = openNow();
			} catch (err) {
				return {ok: false, code: codeOf(err)};
			}
		}
		const from = level;
		if (next === 'off') noteChange(from, next);
		level = next;
		threshold = next === 'off' ? -1 : LEVELS.indexOf(next);
		source = 'setting';
		variable = undefined;
		if (next !== 'off') noteChange(from, next);
		for (const listener of [...listeners]) {
			try {
				listener(next);
			} catch {
			}
		}
		return {ok: true};
	};

	return {
		...make(''),
		close: () => sink?.close(),
		get file() {
			return sink?.file ?? '';
		},
		level: () => level,
		onLevel: subscribe,
		levelSource: () => ({source, ...(variable && {variable})}),
		setLevel,
	};
}
