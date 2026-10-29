import {spawn, type ChildProcess} from 'node:child_process';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {constants} from 'node:os';
import path from 'node:path';
import type {DevFailure as PublicDevFailure} from './api.js';
import {terminalText} from './log/sanitize.js';
import type {ModeState} from './mode.js';

export const DEV_CHILD_ENV = 'YENA_DEV_CHILD';
export const STABLE_ENV = 'YENA_STABLE';
const READY_MS_ENV = 'YENA_DEV_READY_MS';
const DEFAULT_READY_MS = 60_000;
const FAILURE_FILE = 'dev-failure.json';

export const isDevChild = (env: NodeJS.ProcessEnv): boolean => env[DEV_CHILD_ENV] === '1';

export function devLaunchTarget(env: NodeJS.ProcessEnv, codeRoot: string, state: ModeState): string | undefined {
	if (state.mode !== 'dev' || isDevChild(env) || env[STABLE_ENV] || !env.YENA_DATA) return undefined;
	return path.resolve(codeRoot) === path.resolve(state.devRoot) ? undefined : state.devRoot;
}

export type DevFailure = {
	at: string;
	devRoot: string;
	pid?: number;
	name: string;
	message: string;
	stack?: string;
};

const failureFile = (stateDir: string) => path.join(stateDir, FAILURE_FILE);

export async function writeDevFailure(stateDir: string, failure: Omit<DevFailure, 'at'>): Promise<void> {
	const record: DevFailure = {
		at: new Date().toISOString(),
		devRoot: failure.devRoot,
		...(failure.pid !== undefined && {pid: failure.pid}),
		name: terminalText(failure.name, 200),
		message: terminalText(failure.message, 4 * 1024),
		...(failure.stack !== undefined && {stack: terminalText(failure.stack, 8 * 1024)}),
	};
	await mkdir(stateDir, {recursive: true});
	const file = failureFile(stateDir);
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(record, null, '\t') + '\n');
	await rename(tmp, file);
}

export async function readDevFailure(stateDir: string): Promise<DevFailure | undefined> {
	try {
		const data = JSON.parse(await readFile(failureFile(stateDir), 'utf8')) as Partial<DevFailure>;
		if (typeof data.message !== 'string' || typeof data.name !== 'string') return undefined;
		return data as DevFailure;
	} catch {
		return undefined;
	}
}

export async function publicDevFailure(stateDir: string): Promise<PublicDevFailure | undefined> {
	const rec = await readDevFailure(stateDir);
	if (!rec) return undefined;
	return {at: String(rec.at), devRoot: String(rec.devRoot), name: rec.name, message: rec.message, ...(typeof rec.stack === 'string' && {stack: rec.stack})};
}

export const clearDevFailure = (stateDir: string): Promise<void> => rm(failureFile(stateDir), {force: true});

export function errorFailure(error: unknown): Pick<DevFailure, 'name' | 'message' | 'stack'> {
	if (error instanceof Error) return {name: error.name, message: error.message, ...(error.stack !== undefined && {stack: error.stack})};
	return {name: 'Error', message: String(error)};
}

export function reportReady(): void {
	if (!process.send) return;
	process.send({type: 'ready'});
	process.channel?.unref();
}

export type DevOutcome =
	| {kind: 'done'; code: number}
	| {kind: 'failed'; reason: string};

export type RunDevChildOptions = {
	devRoot: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	stateDir: string;
	spawnChild?: typeof spawn;
};

const statusOf = (code: number | null, signal: NodeJS.Signals | null): number =>
	code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);

const describeEnd = (code: number | null, signal: NodeJS.Signals | null): string =>
	signal ? `ended by ${signal} before it was ready` : `exited with code ${code ?? 'unknown'} before it was ready`;

export function runDevChild(opts: RunDevChildOptions): Promise<DevOutcome> {
	const readyMs = Number(opts.env[READY_MS_ENV]) > 0 ? Number(opts.env[READY_MS_ENV]) : DEFAULT_READY_MS;
	const child: ChildProcess = (opts.spawnChild ?? spawn)(process.execPath, ['--import', 'tsx', path.join(opts.devRoot, 'src', 'cli.ts'), ...opts.args], {
		cwd: opts.devRoot,
		env: {...opts.env, YENA_HOME: opts.devRoot, [DEV_CHILD_ENV]: '1'},
		stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
	});

	return new Promise(resolve => {
		let ready = false;
		let settled = false;
		let failing = false;
		let stopping: NodeJS.Signals | undefined;
		const forward = (signal: NodeJS.Signals) => () => {
			stopping ??= signal;
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
		};
		const handlers = (['SIGTERM', 'SIGHUP', 'SIGINT'] as const).map(s => [s, forward(s)] as const);
		for (const [s, h] of handlers) process.on(s, h);

		const settle = (outcome: DevOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			for (const [s, h] of handlers) process.off(s, h);
			resolve(outcome);
		};
		const fail = async (reason: string) => {
			if (failing) return;
			failing = true;
			if (stopping) {
				settle({kind: 'done', code: statusOf(null, stopping)});
				return;
			}
			const own = await readDevFailure(opts.stateDir);
			if (!own || own.pid !== child.pid) {
				await writeDevFailure(opts.stateDir, {devRoot: opts.devRoot, ...(child.pid !== undefined && {pid: child.pid}), name: 'DevStartFailed', message: reason}).catch(() => {});
			}
			settle({kind: 'failed', reason: own && own.pid === child.pid ? own.message : reason});
		};

		const timer = setTimeout(() => {
			if (ready) return;
			child.kill('SIGKILL');
			void fail(`did not get ready within ${readyMs} ms`);
		}, readyMs);

		child.on('message', message => {
			if ((message as {type?: unknown})?.type !== 'ready' || ready) return;
			ready = true;
			clearTimeout(timer);
			if (child.connected) child.disconnect();
		});
		child.once('error', error => void fail(`could not start: ${error.message}`));
		child.once('exit', (code, signal) => {
			if (ready) settle({kind: 'done', code: statusOf(code, signal)});
			else if (!settled) void fail(describeEnd(code, signal));
		});
	});
}

const ESC = String.fromCharCode(27);

export function resetTerminal(stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout): void {
	if (stdin.isTTY) {
		try {
			stdin.setRawMode(false);
		} catch {
		}
	}
	if (stdout.isTTY) {
		stdout.write(`${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l${ESC}[0m${ESC}[?25h${ESC}[?1049l`);
	}
}
