import type {GitSshResolver} from '../api.js';

let resolver: GitSshResolver | undefined;

export function registerGitSsh(resolve: GitSshResolver): boolean {
	if (resolver) return false;
	resolver = resolve;
	return true;
}

export async function gitSshFor(account: string): Promise<string> {
	if (!resolver) throw new Error('--account needs the account module (mod install account)');
	return resolver(account);
}

export function resetGitSsh(): void {
	resolver = undefined;
}
