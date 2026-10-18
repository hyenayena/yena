import type {Logger} from '../api.js';

export const noopLogger: Logger = {
	error() {},
	warn() {},
	info() {},
	debug() {},
	child() {
		return noopLogger;
	},
	addRedactor() {},
};
