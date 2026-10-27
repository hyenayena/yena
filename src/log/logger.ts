import path from 'node:path';
import type {LogFields, Logger} from '../api.js';
import {escapes} from '../pm/paths.js';
import {LEVELS, readLogConfig, type LogLevel} from './config.js';
import {noopLogger} from './noop.js';
import {createRedactor, type Redactor} from './redact.js';
import {cleanText, escapeLine, MESSAGE_CAP, serializeFields, type Scrub} from './sanitize.js';
import {openSink, type SinkIo} from './sink.js';

export type HostLogger = Logger & {
	close(): void;
	// Empty when logging is disabled.
	readonly file: string;
};

export type HostLoggerOptions = {
	root: string;
	env: NodeJS.ProcessEnv;
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

// Redaction keeps working with logging off: modules use it for output, not only for the log.
const disabled = (redactor: Redactor): HostLogger => {
	const logger: HostLogger = {
		...noopLogger,
		child: () => logger,
		addRedactor: redact => redactor.add(redact),
		redact: text => redactor.apply(text),
		close() {},
		file: '',
	};
	return logger;
};

export function createHostLogger(opts: HostLoggerOptions): HostLogger {
	const onWarn = opts.onWarn ?? ((message: string) => process.stderr.write(`${message}\n`));
	const warn = (message: string) => {
		try {
			onWarn(message);
		} catch {
			// The logger must not throw.
		}
	};

	const redactor = createRedactor();
	const config = readLogConfig(opts.env);
	for (const message of config.warnings) warn(message);
	if (!config.enabled) return disabled(redactor);

	const dir = path.resolve(opts.dir ?? path.join(opts.root, 'logs'));
	if (escapes(path.resolve(opts.root), dir)) {
		warn('Warning: cannot write the log file (EPERM); logging is disabled');
		return disabled(redactor);
	}

	const now = opts.now ?? (() => new Date());
	const pid = opts.pid ?? process.pid;
	const threshold = LEVELS.indexOf(config.level);

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

	let sink;
	try {
		sink = openSink({
			dir,
			maxBytes: opts.maxBytes ?? 1024 * 1024,
			generations: opts.generations ?? 3,
			io: opts.io,
			dropNotice: n => render('warn', 'log', `log: ${n} records dropped`),
		});
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
		warn(`Warning: cannot write the log file (${code}); logging is disabled`);
		return disabled(redactor);
	}
	const active = sink;

	const make = (scope: string): Logger => {
		const emit = (level: LogLevel) => (message: string, fields?: LogFields) => {
			try {
				if (LEVELS.indexOf(level) > threshold) return;
				active.write(render(level, scope || 'host', message, fields));
			} catch {
				// The logger must never throw into callers.
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
					// Ignore.
				}
			},
			redact: text => redactor.apply(text),
		};
	};

	return {...make(''), close: () => active.close(), file: active.file};
}
