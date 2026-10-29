import type {CredentialAccess, CredentialCaller, CredentialCreateInput, CredentialProvider, Credentials} from './api.js';

export type CredentialBroker = {
	/** First wins: false when a provider is already registered. */
	register(provider: CredentialProvider, module: string): boolean;
	/** The handle given to `module`; every call reaches the provider with this module as the caller. */
	handleFor(module: string, declared: Record<string, CredentialAccess>): Credentials;
};

const OPERATIONS = ['grants', 'list', 'read', 'write', 'create', 'remove'] as const;

export function createCredentialBroker(): CredentialBroker {
	let current: CredentialProvider | undefined;

	const provider = (): CredentialProvider => {
		if (!current) throw new Error('No credential store is installed (mod install account)');
		return current;
	};

	return {
		register(candidate, module) {
			if (typeof candidate !== 'object' || candidate === null || OPERATIONS.some(op => typeof candidate[op] !== 'function')) {
				throw new Error(`invalid credential provider from ${module}`);
			}
			if (current) return false;
			current = candidate;
			return true;
		},
		handleFor(module, declared) {
			const caller: CredentialCaller = Object.freeze({module, declared: Object.freeze({...declared})});
			return Object.freeze({
				available: () => current !== undefined,
				grants: async () => provider().grants(caller),
				list: async (kind?: string) => provider().list(kind, caller),
				read: async (account: string, field: string) => provider().read(account, field, caller),
				write: async (account: string, field: string, value: string | undefined) => provider().write(account, field, value, caller),
				create: async (input: CredentialCreateInput) => provider().create(input, caller),
				remove: async (account: string) => provider().remove(account, caller),
			});
		},
	};
}
