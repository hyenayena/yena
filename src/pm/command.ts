import type {Command, Subcommand} from '../api.js';
import {readImageRecord} from './bake.js';
import {install, list, overlayEnabled, remove, update, type ModuleStatus} from './manager.js';

const subcommands: Subcommand[] = [
	{
		name: 'install',
		aliases: ['i'],
		usage: 'mod install [--account <name>] [source]…',
		description: 'Install modules (no sources: restore all from yena-modules.json)',
		args: [{name: 'source', description: 'Module to install; the forms are in the notes'}],
		options: [{name: '--account', value: '<name>', description: "Fetch private modules with this account's SSH key"}],
		notes: [
			'Sources: core (official module by name), user/repo, gitlab:user/repo, https://host/repo.git, ./folder',
			'Several at once: mod install core dev task',
			'Version: append #branch, #tag or #commit, e.g. core#v1.2',
			'Private module: mod install --account <name> owner/repo (over ssh with that account; kept in the lock file for restores and updates)',
			'With YENA_DATA the modules go to the overlay',
		],
		agent: 'confirm',
	},
	{
		name: 'update',
		aliases: ['up'],
		usage: 'mod update [name]…',
		description: 'Update modules to the latest version (image modules get a newer overlay copy)',
		args: [{name: 'name', description: 'Module to update (none: all)'}],
		agent: 'confirm',
	},
	{
		name: 'remove',
		aliases: ['rm'],
		usage: 'mod remove <name>…',
		description: 'Remove modules (only from the overlay; image modules leave with a rebuild)',
		args: [{name: 'name', description: 'Module to remove'}],
		agent: 'confirm',
	},
	{
		name: 'list',
		aliases: ['ls'],
		usage: 'mod list',
		description: 'Show installed modules',
		agent: 'safe',
	},
];

const USAGE = 'mod <subcommand>';

/** Splits `--account <name>` (once, anywhere) off the sources. */
export function parseInstallArgs(args: string[]): {specs: string[]; account?: string} {
	const specs: string[] = [];
	let account: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--account') {
			const name = args[++i];
			if (name === undefined || name.startsWith('-')) throw new Error('--account needs an account name');
			if (account !== undefined) throw new Error('--account is given more than once');
			account = name;
		} else if (arg.startsWith('-')) {
			throw new Error(`Unknown option "${arg}". See mod help install`);
		} else {
			specs.push(arg);
		}
	}
	if (account !== undefined && specs.length === 0) throw new Error('--account needs the modules to install');
	return {specs, ...(account !== undefined && {account})};
}

const STATE_FLAG: Record<ModuleStatus['state'], string> = {ok: '', missing: 'not downloaded', untracked: 'not in lock file', broken: 'broken'};

/** `[overlay]`, `[image, not used: the overlay is newer]`, `[not downloaded]`…; origins only when there is an overlay. */
export function statusTags(m: ModuleStatus, withOrigin = overlayEnabled): string {
	const tags: string[] = [];
	if (withOrigin) {
		const loaded = m.state === 'ok' || m.state === 'untracked';
		let origin: string = m.origin;
		if (loaded && !m.active) origin += m.origin === 'overlay' ? ', skipped: the image is newer' : ', not used: the overlay is newer';
		tags.push(origin);
	}
	if (STATE_FLAG[m.state]) tags.push(STATE_FLAG[m.state]);
	return tags.length > 0 ? ` [${tags.join(', ')}]` : '';
}

export const modCommand: Command = {
	name: 'mod',
	description: 'Install, update, remove and list modules',
	usage: USAGE,
	args: [{name: 'subcommand', description: 'What to do; see the subcommands'}],
	subcommands,
	agent: 'confirm',
	run: async ([sub, ...args], ctx) => {
		const log = ctx.print;
		switch (sub) {
			case 'install':
			case 'i': {
				const {specs, account} = parseInstallArgs(args);
				return install(specs, log, account === undefined ? {} : {account});
			}
			case 'update':
			case 'up':
				return update(args, log);
			case 'remove':
			case 'rm':
				return remove(args, log);
			case 'list':
			case 'ls': {
				const modules = await list();
				if (modules.length === 0) return log('No modules. Try: mod install user/repo');
				const image = await readImageRecord();
				if (image) log(`  Image built ${image.builtAt}`);
				for (const m of modules) {
					const version = m.version ? `@${m.version}` : '';
					log(`  ${m.name}${version}${statusTags(m)}${m.description ? ` — ${m.description}` : ''}`);
					if (m.source) log(`      ${m.source}${m.commit ? ` @ ${m.commit.slice(0, 7)}` : ''}`);
					if (m.error) log(`      ${m.error}`);
				}
				return;
			}
			case undefined:
			case 'help':
				return ctx.showHelp ? ctx.showHelp() : log(USAGE);
			default:
				throw new Error(`Unknown subcommand "${sub}". See mod help`);
		}
	},
};
