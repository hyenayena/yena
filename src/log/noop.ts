import type {Logger} from '../api.js';
import {createRedactor} from './redact.js';

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
