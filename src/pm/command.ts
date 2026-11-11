import type {Command, StyledBlock, StyledCell, StyledSpan, Subcommand} from '../api.js';
import {readImageRecord} from './bake.js';
import {fixVersions, parseFixArgs} from './fix.js';
import {install, list, lockRoot, overlayEnabled, remove, update, type ModuleStatus} from './manager.js';

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
		name: 'fix',
		usage: 'mod fix [--ranges] [--yes]',
		description: 'Find and apply compatible module versions after a version conflict',
		options: [
			{name: '--ranges', description: "Developer: move the ranges in a working copy's yena.json to the installed versions"},
			{name: '--yes', description: 'Apply the plan (without it only the plan is shown)'},
		],
		notes: [
			'Default: installs the newest versions inside every dependent\'s range, from the sources in the lock file',
			'--ranges: rewrites dependencies.<name>.version of working copies in modules/ to ^<installed version>',
		],
		agent: 'confirm',
	},
	{
		name: 'lock',
		usage: 'mod lock',
		description: "Record the modules of a working copy (versions and commits) in yena-modules.json",
		notes: ['Only in dev mode; a checkout with uncommitted changes is skipped'],
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

const STATE_FLAG: Record<ModuleStatus['state'], StyledSpan | undefined> = {
	ok: undefined,
	missing: {text: 'not downloaded', tone: 'warn'},
	untracked: {text: 'not in lock file', tone: 'warn'},
	broken: {text: 'broken', tone: 'error'},
	incompatible: {text: 'not loaded', tone: 'error'},
};

function originCell(m: ModuleStatus): StyledCell {
	const loaded = m.state === 'ok' || m.state === 'untracked' || m.state === 'incompatible';
	if (!loaded || m.active) return m.origin;
	const note = m.origin === 'overlay' ? ', skipped: the image is newer' : ', not used: the overlay is newer';
	return [m.origin, {text: note, tone: 'muted'}];
}

export function modListBlocks(modules: readonly ModuleStatus[], image: {builtAt: string} | undefined, withOrigin = overlayEnabled): StyledBlock[] {
	const blocks: StyledBlock[] = [];
	if (image) blocks.push({kind: 'line', spans: [{text: `Image built ${image.builtAt}`, tone: 'muted'}]});
	const withState = modules.some(m => STATE_FLAG[m.state] !== undefined);
	const head = ['Module', 'Version', ...(withOrigin ? ['Origin'] : []), ...(withState ? ['State'] : []), 'Source', 'Description'];
	const rows = modules.map(m => {
		const source = m.source ? `${m.source}${m.commit ? ` @ ${m.commit.slice(0, 7)}` : ''}` : '';
		const row: StyledCell[] = [{text: m.name, bold: true}, m.version ?? ''];
		if (withOrigin) row.push(originCell(m));
		if (withState) row.push(STATE_FLAG[m.state] ?? '');
		row.push(source ? {text: source, tone: 'muted'} : '', m.description ? {text: m.description, tone: 'muted'} : '');
		return row;
	});
	blocks.push({kind: 'table', head, rows, flex: head.length - 1});
	for (const m of modules) {
		if (m.error) blocks.push({kind: 'line', spans: [{text: `${m.name}: `, bold: true}, {text: m.error, tone: 'error'}]});
	}
	return blocks;
}

function plainSpans(spans: StyledCell): string {
	if (typeof spans === 'string') return spans;
	const list = Array.isArray(spans) ? (spans as readonly (string | StyledSpan)[]) : [spans as StyledSpan];
	return list.map(s => (typeof s === 'string' ? s : s.decor ? '' : s.text)).join('');
}

export function plainBlockLines(blocks: readonly StyledBlock[]): string[] {
	const lines: string[] = [];
	for (const block of blocks) {
		switch (block.kind) {
			case 'line': {
				if (block.decor || (block.spans.length > 0 && block.spans.every(s => typeof s !== 'string' && s.decor))) break;
				lines.push(plainSpans(block.spans).trimEnd());
				break;
			}
			case 'table':
				for (const row of block.rows) lines.push(row.map(plainSpans).filter(c => c.trim() !== '').join('  ').trimEnd());
				break;
			case 'text':
				for (const line of block.text.split('\n')) lines.push(line.trimEnd());
				break;
			case 'rule':
				break;
		}
	}
	return lines.every(l => l === '') ? [] : lines;
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
			case 'fix':
				return fixVersions(parseFixArgs(args), log);
			case 'lock':
				if (args.length > 0) throw new Error('mod lock takes no arguments');
				return lockRoot(log);
			case 'list':
			case 'ls': {
				const modules = await list();
				if (modules.length === 0) return log('No modules. Try: mod install user/repo');
				const blocks = modListBlocks(modules, await readImageRecord());
				return ctx.printStyled ? ctx.printStyled(blocks) : log(plainBlockLines(blocks).join('\n'));
			}
			case undefined:
			case 'help':
				return ctx.showHelp ? ctx.showHelp() : log(USAGE);
			default:
				throw new Error(`Unknown subcommand "${sub}". See mod help`);
		}
	},
};
