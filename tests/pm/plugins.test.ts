import assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {Command, Logger} from '../../src/api.js';
import {createEventBus} from '../../src/events.js';
import type {Manifest} from '../../src/pm/manifest.js';
import {loadPlugins} from '../../src/pm/plugins.js';

type Spec = {name: string; source?: string; runtime?: string; entry?: string | null};

const cmd = (name: string) => `{name: '${name}', description: '', run() {}}`;
const ok = (...names: string[]) => `export default () => [${names.map(cmd).join(', ')}];`;

async function setup(specs: Spec[], extra?: (base: string) => Promise<void>) {
	const base = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-plugins-')));
	const modules: {dir: string; manifest: Manifest}[] = [];
	for (const spec of specs) {
		const dir = path.join(base, 'modules', spec.name);
		await mkdir(dir, {recursive: true});
		if (spec.source !== undefined) await writeFile(path.join(dir, 'index.mjs'), spec.source);
		const entry = spec.entry === null ? undefined : (spec.entry ?? 'index.mjs');
		modules.push({
			dir,
			manifest: {name: spec.name, version: '1.0.0', runtime: spec.runtime ?? 'node', entry} as unknown as Manifest,
		});
	}
	await extra?.(base);
	return {base, modules};
}

async function load(
	modules: {dir: string; manifest: Manifest}[],
	base: string,
	over: Partial<Parameters<typeof loadPlugins>[0]> = {},
) {
	const logs: string[] = [];
	const events = createEventBus();
	const commands = await loadPlugins({
		modules,
		host: {commands: [{name: 'mod', description: '', run() {}}]},
		events,
		dataDirFor: async name => path.join(base, 'data', name),
		log: line => logs.push(line),
		...over,
	});
	return {commands, logs, events};
}

const names = (commands: Command[]) => commands.map(c => c.name);

test('loads plugins in name order with their own data dir and the shared bus', async () => {
	const probe = `export default host => [{name: 'a-cmd', description: '', run() {}, host}];`;
	const {base, modules} = await setup([
		{name: 'b', source: ok('b-cmd')},
		{name: 'a', source: probe},
	]);
	const {commands, logs, events} = await load(modules, base);
	assert.deepEqual(names(commands), ['a-cmd', 'b-cmd']);
	assert.deepEqual(logs, []);
	const host = (commands[0] as unknown as {host: {dataDir: string; events: unknown}}).host;
	assert.equal(host.dataDir, path.join(base, 'data', 'a'));
	assert.equal(host.events, events);
});

test('passes the build info to every plugin, and omits it when the host has none', async () => {
	const probe = (name: string) => `export default host => [{name: '${name}', description: '', run() {}, host}];`;
	const {base, modules} = await setup([
		{name: 'a', source: probe('a-cmd')},
		{name: 'b', source: probe('b-cmd')},
	]);
	const build = {version: '1.2.3', modules: [{name: 'a', version: '1.0.0'}]};
	const hostOf = (c: Command) => (c as unknown as {host: {build?: unknown}}).host;
	const {commands} = await load(modules, base, {build});
	assert.deepEqual(commands.map(c => hostOf(c).build), [build, build]);
	const {commands: bare} = await load(modules, base);
	assert.equal('build' in hostOf(bare[0]!), false);
});

test('missing entry file is skipped and others load', async () => {
	const {base, modules} = await setup([{name: 'x'}, {name: 'y', source: ok('y')}]);
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(names(commands), ['y']);
	assert.match(logs[0] ?? '', /plugin "x" skipped/);
});

test('entry escaping with ../ is skipped', async () => {
	const {base, modules} = await setup([{name: 'x', entry: '../../x.mjs'}], async b => {
		await writeFile(path.join(b, 'x.mjs'), ok('x'));
	});
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(commands, []);
	assert.match(logs[0] ?? '', /plugin "x" skipped/);
});

test('entry escaping through a symlink is skipped', async () => {
	const {base, modules} = await setup([{name: 'x', entry: 'link.mjs'}], async b => {
		await writeFile(path.join(b, 'outside.mjs'), ok('x'));
		await symlink(path.join(b, 'outside.mjs'), path.join(b, 'modules', 'x', 'link.mjs'));
	});
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(commands, []);
	assert.match(logs[0] ?? '', /points outside the module/);
});

test('throwing and rejecting plugins are skipped', async () => {
	const {base, modules} = await setup([
		{name: 'a', source: `export default () => { throw new Error('sync boom'); };`},
		{name: 'b', source: `export default async () => { throw new Error('async boom'); };`},
		{name: 'c', source: ok('c')},
	]);
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(names(commands), ['c']);
	assert.equal(logs.length, 2);
});

test('plugin without a default function is skipped', async () => {
	const {base, modules} = await setup([{name: 'a', source: 'export const x = 1;'}]);
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(commands, []);
	assert.match(logs[0] ?? '', /default function/);
});

test('non-array result and invalid items are skipped', async () => {
	const {base, modules} = await setup([
		{name: 'a', source: `export default () => 42;`},
		{name: 'b', source: `export default () => [{name: 'b'}];`},
		{name: 'c', source: `export default () => [{name: '', run() {}}];`},
	]);
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(commands, []);
	assert.equal(logs.length, 3);
});

test('duplicate across plugins skips the later plugin entirely', async () => {
	const {base, modules} = await setup([
		{name: 'a', source: ok('dup', 'a-only')},
		{name: 'b', source: ok('b-only', 'dup')},
	]);
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(names(commands), ['dup', 'a-only']);
	assert.match(logs[0] ?? '', /plugin "b" skipped/);
});

test('duplicate against a host command is skipped', async () => {
	const {base, modules} = await setup([{name: 'a', source: ok('mod')}]);
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(commands, []);
	assert.equal(logs.length, 1);
});

test('duplicate inside one plugin is skipped', async () => {
	const {base, modules} = await setup([{name: 'a', source: ok('x', 'x')}]);
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(commands, []);
	assert.equal(logs.length, 1);
});

test('binary runtime or missing entry is silently skipped', async () => {
	const {base, modules} = await setup([
		{name: 'a', source: ok('a'), runtime: 'binary'},
		{name: 'b', source: ok('b'), entry: null},
	]);
	const {commands, logs} = await load(modules, base);
	assert.deepEqual(commands, []);
	assert.deepEqual(logs, []);
});

test('core is never imported', async () => {
	const {base, modules} = await setup([{name: 'core', source: ok('c')}]);
	let called = false;
	const {commands, logs} = await load(modules, base, {
		importer: async () => {
			called = true;
			return {};
		},
	});
	assert.equal(called, false);
	assert.deepEqual(commands, []);
	assert.deepEqual(logs, []);
});

test('a plugin that never resolves times out', async () => {
	const {base, modules} = await setup([{name: 'a', source: `export default () => new Promise(() => {});`}]);
	const {commands, logs} = await load(modules, base, {timeoutMs: 20});
	assert.deepEqual(commands, []);
	assert.match(logs[0] ?? '', /plugin "a" skipped: timed out/);
});

test('log lines carry only the name and message, no stack', async () => {
	const {base, modules} = await setup([{name: 'a', source: `export default () => { throw new Error('boom'); };`}]);
	const {logs} = await load(modules, base);
	assert.deepEqual(logs, ['plugin "a" skipped: boom']);
	assert.ok(!logs[0]?.includes(' at '));
});

function spyLogger() {
	const recs: {scope: string; level: string; msg: string; fields?: Record<string, unknown>}[] = [];
	const make = (scope: string): Logger => {
		const at = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
			void recs.push({scope, level, msg, fields});
		return {error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), child: s => make(s), addRedactor() {}};
	};
	return {logger: make('root'), recs};
}

test('host.log is a child logger named after the module', async () => {
	const probe = `export default host => { host.log.info('hi'); return [{name: 'a-cmd', description: '', run() {}}]; };`;
	const {base, modules} = await setup([{name: 'a', source: probe}]);
	const {logger, recs} = spyLogger();
	await load(modules, base, {logger});
	assert.ok(recs.some(r => r.scope === 'a' && r.msg === 'hi'));
});

test('loaded and skipped plugins are logged, console text unchanged', async () => {
	const {base, modules} = await setup([
		{name: 'a', source: ok('a-cmd')},
		{name: 'b', source: `export default () => { throw new Error('boom'); };`},
	]);
	const {logger, recs} = spyLogger();
	const {logs} = await load(modules, base, {logger});
	assert.deepEqual(logs, ['plugin "b" skipped: boom']);
	const loaded = recs.find(r => r.msg === 'plugin loaded');
	assert.equal(loaded?.level, 'info');
	assert.deepEqual(loaded?.fields?.commands, ['a-cmd']);
	const skipped = recs.find(r => r.msg === 'plugin skipped');
	assert.equal(skipped?.level, 'warn');
	assert.equal(skipped?.fields?.module, 'b');
	assert.equal(skipped?.fields?.reason, 'boom');
});

test('an old-style plugin that ignores log still loads without a logger option', async () => {
	const {base, modules} = await setup([{name: 'a', source: `export default ({dataDir}) => [{name: 'old', description: '', run() {}}];`}]);
	const {commands} = await load(modules, base);
	assert.deepEqual(names(commands), ['old']);
});
