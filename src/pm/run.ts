import {spawn} from 'node:child_process';
import type {Logger} from '../api.js';

export type Log = (line: string) => void;

type Options = {
	cwd?: string;
	shell?: boolean;
	log?: Log;
	trace?: Logger;
};

const LINE_CAP = 500;
const STDERR_TAIL = 5;

const cap = (text: string) => (text.length > LINE_CAP ? `${text.slice(0, LINE_CAP)}…` : text);

export function run(cmd: string, args: string[], {cwd, shell, log, trace}: Options = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		if (shell) trace?.info('child spawned', {shell: true, command: cap(cmd)});
		else trace?.info('child spawned', {cmd, sub: args[0]});
		const child = spawn(cmd, args, {
			cwd,
			shell,
			stdio: ['ignore', 'pipe', 'pipe'],
			// Never let git wait for a password prompt that nobody can answer
			env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
		});

		let stdout = '';
		let stderr = '';
		const pending = {out: '', err: ''};

		const forward = (key: 'out' | 'err', chunk: string) => {
			if (!log && !trace) return;
			const lines = (pending[key] + chunk).split('\n');
			pending[key] = lines.pop()!;
			for (const line of lines) {
				if (!line.trim()) continue;
				trace?.debug('child output', {stream: key, line: cap(line)});
				log?.(`  ${line}`);
			}
		};

		child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk;
			forward('out', chunk);
		});
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk;
			forward('err', chunk);
		});

		child.on('error', error => {
			const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
			trace?.warn('child failed to start', {cmd: shell ? undefined : cmd, err: error});
			reject(new Error(missing ? `Program "${cmd}" not found` : error.message));
		});

		child.on('close', code => {
			for (const rest of [pending.out, pending.err]) if (log && rest.trim()) log(`  ${rest}`);
			const ms = Date.now() - started;
			trace?.info('child exited', {code, ms});
			if (code === 0) return resolve(stdout);
			if (trace) {
				const lines = stderr.trim().split('\n').slice(-STDERR_TAIL).map(cap);
				trace.warn('child failed', {code, stderrTail: lines.join('\n')});
			}
			const tail = log ? '' : stderr.trim().split('\n').slice(-3).join('\n');
			const name = shell ? cmd : [cmd, ...args].join(' ');
			reject(new Error(`"${name}" exited with code ${code}${tail ? `\n${tail}` : ''}`));
		});
	});
}
