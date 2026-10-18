import type {Logger} from '../api.js';
import {noopLogger} from './noop.js';

let current: Logger = noopLogger;

export const setHostLog = (logger: Logger): void => {
	current = logger;
};

export const hostLog = (): Logger => current;
