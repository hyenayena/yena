import type {CommandError} from './api.js';

export function usageError(message: string): CommandError {
	return Object.assign(new Error(message), {kind: 'usage' as const});
}
