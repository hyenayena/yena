import type {Logger} from './api.js';

export const RELOAD_STATUS = 75;
export const RELAUNCH_ENV = 'YENA_RELAUNCH';

export function takeRelaunch(env: NodeJS.ProcessEnv): boolean {
	const set = env[RELAUNCH_ENV] === '1';
	delete env[RELAUNCH_ENV];
	return set;
}

export type ReloadOptions = {
	log: Logger;
	setExitCode?: (code: number) => void;
	exit?: (code: number) => void;
	delayMs?: number;
};

export function createReload(options: ReloadOptions): () => void {
	const {log, setExitCode = code => void (process.exitCode = code), exit = code => process.exit(code), delayMs = 10_000} = options;
	let requested = false;
	return () => {
		if (requested) return;
		requested = true;
		setExitCode(RELOAD_STATUS);
		log.info('reload requested');
		// A handle left open must not hang a reload.
		setTimeout(() => exit(RELOAD_STATUS), delayMs).unref();
	};
}
