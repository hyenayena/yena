import type {Logger} from '../api.js';
import {createRedactor} from './redact.js';

// No registered redactors, but the built-in secret patterns still apply to text a module shows.
const builtins = createRedactor();

export const noopLogger: Logger = {
	error() {},
	warn() {},
	info() {},
	debug() {},
	child() {
		return noopLogger;
	},
	addRedactor() {},
	redact: text => builtins.apply(text),
};
