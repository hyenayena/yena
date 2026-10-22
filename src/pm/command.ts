import type {Command, Subcommand} from '../api.js';
import {install, list, remove, update} from './manager.js';

const subcommands: Subcommand[] = [
	{
		name: 'install',
		aliases: ['i'],
		usage: 'mod install [source]…',
		description: 'Install modules (no arguments: restore all from yena-modules.json)',
		agent: 'confirm',
	},
	{
		name: 'update',
		aliases: ['up'],
		usage: 'mod update [name]…',
		description: 'Update modules to the latest version',
		agent: 'confirm',
	},
	{
		name: 'remove',
		aliases: ['rm'],
		usage: 'mod remove <name>…',
		description: 'Remove modules',
		agent: 'confirm',
	},
	{
		name: 'list',
		aliases: ['ls'],
		usage: 'mod list',
		description: 'Show installed modules',
		agent: 'safe',
	},
	{
		name: 'help',
		usage: 'mod help [subcommand]',
		description: 'Show this help or help for one subcommand',
		agent: 'safe',
	},
];

const notes = [
	'Sources: user/repo, gitlab:user/repo, https://host/repo.git, ./folder',
	'Version: append #branch, #tag or #commit, e.g. user/repo#v1.2',
];

const find = (name: string) => subcommands.find(s => s.name === name || s.aliases?.includes(name));

export const modCommand: Command = {
	name: 'mod',
	description: 'Module manager (mod help)',
	usage: 'mod <install|update|remove|list|help> [args]',
	subcommands,
	agent: 'confirm',
	run: async ([sub, ...args], ctx) => {
		const log = ctx.print;
		switch (sub) {
			case 'install':
			case 'i':
				return install(args, log);
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
				for (const m of modules) {
					const version = m.version ? `@${m.version}` : '';
					const flag = {ok: '', missing: ' [not downloaded]', untracked: ' [not in lock file]', broken: ' [broken]'}[m.state];
					log(`  ${m.name}${version}${flag}${m.description ? ` — ${m.description}` : ''}`);
					if (m.source) log(`      ${m.source}${m.commit ? ` @ ${m.commit.slice(0, 7)}` : ''}`);
					if (m.error) log(`      ${m.error}`);
				}
				return;
			}
			case undefined:
			case 'help': {
				const one = args[0] === undefined ? undefined : find(args[0]);
				if (args[0] !== undefined && !one) throw new Error(`Unknown subcommand "${args[0]}"`);
				if (one) {
					log(`  ${one.usage}`);
					log(`  ${one.description}`);
					if (one.aliases) log(`  Aliases: ${one.aliases.join(', ')}`);
					return;
				}
				const width = Math.max(...subcommands.map(s => s.usage.length));
				for (const s of subcommands) log(`  ${s.usage.padEnd(width)}   ${s.description}`);
				log('');
				for (const line of notes) log(`  ${line}`);
				return;
			}
			default:
				throw new Error(`Unknown subcommand "${sub}". See mod help`);
		}
	},
};
