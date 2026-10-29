import type {Logger} from '../api.js';

let installed: {uninstall: () => void; setTarget: (l: Logger) => void} | undefined;

export function installProcessHooks(logger: Logger): () => void {
	if (installed) {
		installed.setTarget(logger);
		return installed.uninstall;
	}
	let log = logger.child('process');
	const guard = (fn: () => void) => {
		try {
			fn();
		} catch {
		}
	};

	const onExit = (code: number) => guard(() => log.info('exit', {code}));
	const onUncaught = (err: Error, origin: string) => guard(() => log.error('uncaught', {origin, err}));
	const onWarning = (warning: Error) => guard(() => log.warn('process warning', {err: warning}));

	process.on('exit', onExit);
	process.on('uncaughtExceptionMonitor', onUncaught);
	process.on('warning', onWarning);

	const uninstall = () => {
		process.off('exit', onExit);
		process.off('uncaughtExceptionMonitor', onUncaught);
		process.off('warning', onWarning);
		installed = undefined;
	};
	installed = {uninstall, setTarget: l => (log = l.child('process'))};
	return uninstall;
}
