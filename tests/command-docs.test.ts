import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {Command, EventBus, Logger, ModulePlugin, PluginHost} from '../src/api.js';
import {createModeCommand} from '../src/mode-command.js';
import {modCommand} from '../src/pm/command.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = path.join(ROOT, 'modules');
const CORE = path.join(MODULES, 'core');

const temps: string[] = [];
const temp = (prefix: string) => {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
};
after(() => {
	for (const dir of temps) rmSync(dir, {recursive: true, force: true});
});

const noopLog: Logger = {
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
	child: () => noopLog,
	addRedactor: () => {},
	redact: text => text,
};

const events: EventBus = {emit: () => {}, on: () => () => {}};

type CheckDocs = (command: Command) => string[];

async function checkDocs(): Promise<CheckDocs> {
	const kit = (await import(pathToFileURL(path.join(CORE, 'src/kit/text.ts')).href)) as {checkCommandDocs: CheckDocs};
	return kit.checkCommandDocs;
}

async function assertDocs(commands: readonly Command[]): Promise<void> {
	const check = await checkDocs();
	const problems = commands.flatMap(c => check(c).map(p => `${c.name}: ${p}`));
	assert.deepEqual(problems, [], `command docs:\n  ${problems.join('\n  ')}`);
}

function pluginModules(): {name: string; entry: string}[] {
	if (!existsSync(MODULES)) return [];
	return readdirSync(MODULES)
		.sort()
		.filter(name => name !== 'core' && existsSync(path.join(MODULES, name, 'yena.json')))
		.flatMap(name => {
			const manifest = JSON.parse(readFileSync(path.join(MODULES, name, 'yena.json'), 'utf8')) as {entry?: string};
			return manifest.entry ? [{name, entry: path.join(MODULES, name, manifest.entry)}] : [];
		});
}

const modules = pluginModules();
const hasCore = existsSync(path.join(CORE, 'src/kit/text.ts'));

describe('command docs', {skip: hasCore ? false : 'core is not installed'}, () => {
	it('finds the installed modules', () => {
		assert.ok(modules.length > 0, 'no module with an entry under modules/');
	});

	it('host: mod', async () => {
		await assertDocs([modCommand]);
	});

	it('host: mode', async () => {
		await assertDocs([await createModeCommand({stateDir: temp('yena-docs-mode-'), codeRoot: '/app', writable: false})]);
	});

	it('core: built-in commands', async () => {
		const core = (await import(pathToFileURL(path.join(CORE, 'src/commands.ts')).href)) as {
			createRegistry: (extra: Command[]) => {commands: Command[]};
		};
		const commands = core.createRegistry([]).commands;
		assert.ok(commands.length > 0);
		await assertDocs(commands);
	});

	for (const m of modules) {
		it(`module: ${m.name}`, async () => {
			const mod = (await import(pathToFileURL(m.entry).href)) as {default?: ModulePlugin};
			assert.equal(typeof mod.default, 'function', `${m.name} has no default plugin export`);
			const host: PluginHost = {dataDir: temp(`yena-docs-${m.name}-`), events, log: noopLog};
			const commands = await mod.default!(host);
			assert.ok(Array.isArray(commands));
			await assertDocs(commands);
		});
	}
});
