import path from 'node:path';

export type Source = {kind: 'git'; url: string; ref?: string} | {kind: 'path'; path: string};

const hosts: Record<string, string> = {
	github: 'https://github.com',
	gitlab: 'https://gitlab.com',
	bitbucket: 'https://bitbucket.org',
};

export function parseSource(spec: string, baseDir: string): Source {
	if (/^(\.{1,2}|~)?\//.test(spec)) {
		const home = process.env.HOME ?? '';
		return {kind: 'path', path: path.resolve(baseDir, spec.replace(/^~(?=\/)/, home))};
	}

	const hash = spec.lastIndexOf('#');
	const target = hash === -1 ? spec : spec.slice(0, hash);
	const ref = hash === -1 ? undefined : spec.slice(hash + 1) || undefined;

	const short = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(target);
	if (short) {
		const host = hosts[short[1] ?? 'github']!;
		return {kind: 'git', url: `${host}/${short[2]}.git`, ref};
	}

	if (/^[a-z+]+:\/\//.test(target) || /^[\w.-]+@[\w.-]+:/.test(target)) {
		return {kind: 'git', url: target, ref};
	}

	throw new Error(
		`Unrecognized source "${spec}". Examples: user/repo, https://host/repo.git, ./local-dir`,
	);
}
