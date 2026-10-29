import type {Command, SettingsTab, Subcommand} from './api.js';
import {checkDevRoot, readMode, runningMode, writeMode, type ModeState, type RootMode} from './mode.js';

export type ModeCommandOptions = {
	stateDir: string;
	codeRoot: string;
	writable: boolean;
};

const subcommands: Subcommand[] = [
	{name: 'show', usage: 'mode show', description: 'Show where yena starts from and where it runs now', agent: 'safe'},
	{name: 'image', usage: 'mode image', description: 'Start from the image (/app) from the next start on', agent: 'confirm'},
	{
		name: 'dev',
		usage: 'mode dev [path]',
		description: 'Start from a working copy of the repo from the next start on',
		args: [{name: 'path', description: 'The working copy (default /workplace/yena)'}],
		agent: 'confirm',
	},
];

const NEXT_START = 'Takes effect on the next start.';
const USAGE = 'mode [subcommand]';

export async function createModeCommand(opts: ModeCommandOptions): Promise<Command> {
	let state: ModeState = await readMode(opts.stateDir);
	const running = (): RootMode => runningMode(opts.codeRoot, state);
	const where = (mode: RootMode, s: ModeState) => (mode === 'dev' ? `dev (${s.devRoot})` : 'image');

	const save = async (mode: RootMode, devRoot = state.devRoot): Promise<void> => {
		if (!opts.writable) throw new Error('The start mode needs YENA_DATA: it is kept in the host state there');
		if (mode === 'dev') await checkDevRoot(devRoot);
		const next = {mode, devRoot};
		await writeMode(opts.stateDir, next);
		state = next;
	};

	const tab = (): SettingsTab => ({
		title: 'Yena',
		settings: [
			{
				key: 'mode',
				label: 'Start from',
				description: `${NEXT_START} Running now: ${running() === 'dev' ? `dev, ${opts.codeRoot}` : `image, ${opts.codeRoot}`}.`,
				options: [
					{value: 'image', label: 'Image', description: 'The built image; it changes only with ./yena build'},
					{value: 'dev', label: 'Working copy', description: `${state.devRoot}; falls back to the image when it cannot start`},
				],
				get: () => state.mode,
				set: value => save(value === 'dev' ? 'dev' : 'image'),
			},
		],
	});

	return {
		name: 'mode',
		description: 'Start yena from the image or from a working copy',
		usage: USAGE,
		args: [{name: 'subcommand', description: 'What to do (none: show)'}],
		subcommands,
		agent: 'confirm',
		get settings() {
			return tab();
		},
		run: async ([sub, ...args], ctx) => {
			const log = ctx.print;
			switch (sub) {
				case undefined:
				case 'show': {
					log(`Start from: ${where(state.mode, state)}`);
					log(`Running now: ${running() === 'dev' ? 'dev' : 'image'} (${opts.codeRoot})`);
					if (state.mode !== running()) log(NEXT_START);
					return;
				}
				case 'image':
				case 'dev': {
					if (sub === 'image' && args.length > 0) throw new Error('mode image takes no arguments');
					if (args.length > 1) throw new Error('mode dev takes at most one path');
					await save(sub, args[0]);
					log(`Start from: ${where(state.mode, state)}. ${state.mode === running() ? 'Already running so.' : NEXT_START}`);
					return;
				}
				case 'help':
					return ctx.showHelp ? ctx.showHelp() : log(USAGE);
				default:
					throw new Error(`Unknown subcommand "${sub}". See mode help`);
			}
		},
	};
}
