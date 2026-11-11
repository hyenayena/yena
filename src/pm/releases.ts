import {randomUUID} from 'node:crypto';
import {mkdir, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {hostLog} from '../log/index.js';
import {gitSshFor} from './git-ssh.js';
import {installDir, root} from './manager.js';
import {parseManifest, readManifest, type Manifest} from './manifest.js';
import {run, type Log} from './run.js';
import {officialModuleName, parseSource} from './source.js';

const MAX_COMMITS = 300;

export type Release = {commit: string | undefined; manifest: Manifest};

// The repos carry no tags, so a version is the yena.json of a commit; the newest accepted one wins.
export async function findRelease(
	spec: string,
	account: string | undefined,
	accept: (manifest: Manifest) => boolean,
	log: Log,
): Promise<Release | undefined> {
	const name = officialModuleName(spec) ?? spec;
	const src = parseSource(spec, root, {ssh: account !== undefined});
	const where = src.kind === 'git' ? src.url : src.path;
	const trace = hostLog().child('pm');
	const fail = (error: unknown): never => {
		trace.warn('release lookup failed', {err: error});
		throw new Error(`Cannot read the versions of ${name} from ${where}: ${(error as Error).message}`);
	};

	if (src.kind === 'path') {
		try {
			if (!(await stat(src.path).then(() => true, () => false))) throw new Error(`Folder ${src.path} does not exist`);
			const manifest = await readManifest(src.path);
			return accept(manifest) ? {commit: undefined, manifest} : undefined;
		} catch (error) {
			return fail(error);
		}
	}

	const probe = path.join(installDir, `.probe-${randomUUID()}`);
	try {
		await mkdir(probe, {recursive: true});
		await run('git', ['init', '-q'], {cwd: probe, trace});
		const env = account === undefined ? undefined : {GIT_SSH_COMMAND: await gitSshFor(account)};
		await run('git', ['fetch', '-q', src.url, src.ref ?? 'HEAD'], {cwd: probe, log, trace, scrubEnv: true, ...(env && {env})});
		const commits = (await run('git', ['log', '--format=%H', '-n', String(MAX_COMMITS), 'FETCH_HEAD', '--', 'yena.json'], {cwd: probe, trace}))
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean);
		for (const commit of commits) {
			let manifest: Manifest;
			try {
				manifest = parseManifest(await run('git', ['show', `${commit}:yena.json`], {cwd: probe, trace}));
			} catch {
				continue;
			}
			if (accept(manifest)) return {commit, manifest};
		}
		trace.info('no release accepted', {module: name, commits: commits.length});
		return undefined;
	} catch (error) {
		return fail(error);
	} finally {
		await rm(probe, {recursive: true, force: true});
	}
}
