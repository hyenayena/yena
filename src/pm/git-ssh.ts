import type {GitSshResolver} from '../api.js';

// Set by the module that owns accounts while plugins load; `mod install --account` asks it.
let resolver: GitSshResolver | undefined;

/** Registers the resolver; false when another one is already set (it stays). */
export function registerGitSsh(resolve: GitSshResolver): boolean {
	if (resolver) return false;
	resolver = resolve;
	return true;
}

export async function gitSshFor(account: string): Promise<string> {
	if (!resolver) throw new Error('--account needs the account module (mod install account)');
	return resolver(account);
}

/** For tests. */
export function resetGitSsh(): void {
	resolver = undefined;
}
