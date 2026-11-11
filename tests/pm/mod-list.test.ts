import assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {CommandContext, StyledBlock} from '../../src/api.js';
import type {ModuleStatus} from '../../src/pm/manager.js';

const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-modlist-')));
process.env.YENA_HOME = home;
delete process.env.YENA_DATA;
const {modCommand, modListBlocks, plainBlockLines} = await import('../../src/pm/command.js');

const core: ModuleStatus = {name: 'core', version: '0.14.0', description: 'Core UI', source: 'core', commit: '59ae70d1234abcd', state: 'ok', origin: 'image', active: true};

function ctxWith(styled: boolean) {
	const printed: string[] = [];
	const blocks: StyledBlock[][] = [];
	const ctx: CommandContext = {
		print: t => void printed.push(...t.split('\n')),
		clear: () => {},
		exit: () => {},
		...(styled && {printStyled: (b: readonly StyledBlock[]) => void blocks.push([...b])}),
	};
	return {ctx, printed, blocks};
}

test('the table has a head, bold names and muted source and description', () => {
	const blocks = modListBlocks([core], {builtAt: '2026-11-01'}, true);
	assert.deepEqual(blocks[0], {kind: 'line', spans: [{text: 'Image built 2026-11-01', tone: 'muted'}]});
	const table = blocks[1]!;
	assert.equal(table.kind, 'table');
	if (table.kind !== 'table') return;
	assert.deepEqual(table.head, ['Module', 'Version', 'Origin', 'Source', 'Description']);
	assert.equal(table.flex, 4);
	assert.deepEqual(table.rows[0], [{text: 'core', bold: true}, '0.14.0', 'image', {text: 'core @ 59ae70d', tone: 'muted'}, {text: 'Core UI', tone: 'muted'}]);
	assert.deepEqual(plainBlockLines(blocks), ['Image built 2026-11-01', 'core  0.14.0  image  core @ 59ae70d  Core UI']);
});

test('state flags add a State column with warn and error tones', () => {
	const rows: ModuleStatus[] = [
		{...core, name: 'a', state: 'missing'},
		{...core, name: 'b', state: 'untracked'},
		{...core, name: 'c', state: 'broken', error: 'yena.json is invalid'},
		core,
	];
	const blocks = modListBlocks(rows, undefined, false);
	const table = blocks[0]!;
	if (table.kind !== 'table') throw new Error('expected a table');
	assert.deepEqual(table.head, ['Module', 'Version', 'State', 'Source', 'Description']);
	assert.deepEqual(table.rows.map(r => r[2]), [
		{text: 'not downloaded', tone: 'warn'},
		{text: 'not in lock file', tone: 'warn'},
		{text: 'broken', tone: 'error'},
		'',
	]);
	assert.deepEqual(blocks[1], {kind: 'line', spans: [{text: 'c: ', bold: true}, {text: 'yena.json is invalid', tone: 'error'}]});
	assert.equal(blocks.length, 2);
	assert.equal(plainBlockLines(blocks).at(-1), 'c: yena.json is invalid');
});

test('Origin is absent without the overlay; an inactive copy gets a muted note', () => {
	const noOrigin = modListBlocks([core], undefined, false)[0]!;
	if (noOrigin.kind !== 'table') throw new Error('expected a table');
	assert.ok(!noOrigin.head?.includes('Origin'));
	const inactive = modListBlocks([{...core, active: false}, {...core, origin: 'overlay', active: false}], undefined, true)[0]!;
	if (inactive.kind !== 'table') throw new Error('expected a table');
	assert.deepEqual(inactive.rows[0]![2], ['image', {text: ', not used: the overlay is newer', tone: 'muted'}]);
	assert.deepEqual(inactive.rows[1]![2], ['overlay', {text: ', skipped: the image is newer', tone: 'muted'}]);
});

test('plainBlockLines drops decor, rules and empty cells and splits text', () => {
	const lines = plainBlockLines([
		{kind: 'line', spans: [{text: '──', decor: true}]},
		{kind: 'line', spans: ['a ', {text: '•', decor: true}, 'b  ']},
		{kind: 'rule'},
		{kind: 'table', head: ['X', 'Y'], rows: [['x', '', [{text: 'y'}, ' z']]]},
		{kind: 'text', text: 'one  \ntwo'},
	]);
	assert.deepEqual(lines, ['a b', 'x  y z', 'one', 'two']);
});

test('mod list prints styled blocks, or plain lines without printStyled', async () => {
	await mkdir(path.join(home, 'modules', 'core'), {recursive: true});
	await writeFile(path.join(home, 'modules', 'core', 'yena.json'), JSON.stringify({name: 'core', version: '0.14.0', description: 'Core UI'}));

	const styled = ctxWith(true);
	await modCommand.run(['list'], styled.ctx);
	assert.equal(styled.printed.length, 0);
	assert.equal(styled.blocks.length, 1);
	assert.equal(styled.blocks[0]!.find(b => b.kind === 'table')?.kind, 'table');

	const plain = ctxWith(false);
	await modCommand.run(['list'], plain.ctx);
	assert.ok(plain.printed.some(l => l.startsWith('core  0.14.0  ') && l.endsWith('Core UI')), plain.printed.join('|'));
});

test('an active copy outside its dependency range is listed as not loaded with the reason', async () => {
	await mkdir(path.join(home, 'modules', 'needy'), {recursive: true});
	await writeFile(
		path.join(home, 'modules', 'needy', 'yena.json'),
		JSON.stringify({name: 'needy', version: '1.0.0', dependencies: {core: {source: 'core', version: '^0.15.0'}}}),
	);
	const {list} = await import('../../src/pm/manager.js');
	const rows = await list();
	const needy = rows.find(r => r.name === 'needy')!;
	assert.equal(needy.state, 'incompatible');
	assert.equal(needy.error, 'needy needs core ^0.15.0, installed 0.14.0; run "mod update core"');
	assert.equal(rows.find(r => r.name === 'core')!.state, 'untracked');
	const blocks = modListBlocks(rows, undefined, false);
	const table = blocks[0]!;
	if (table.kind !== 'table') throw new Error('expected a table');
	assert.ok(table.rows.some(r => JSON.stringify(r).includes('{"text":"not loaded","tone":"error"}')));
	assert.ok(plainBlockLines(blocks).includes('needy: needy needs core ^0.15.0, installed 0.14.0; run "mod update core"'));
});
