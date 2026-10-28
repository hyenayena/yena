import assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {Logger} from '../../src/api.js';

type Rec = {scope: string; level: string; msg: string; fields?: Record<string, unknown>};

test('install, broken manifest and remove log pm lifecycle records', async () => {
	const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-manager-')));
	process.env.YENA_HOME = home;
	process.env.YENA_DATA = path.join(home, 'data');

	const recs: Rec[] = [];
	const make = (scope: string): Logger => {
		const at = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
			void recs.push({scope, level, msg, fields});
		return {
			error: at('error'),
			warn: at('warn'),
			info: at('info'),
			debug: at('debug'),
			child: s => make(s),
			addRedactor() {},
		};
	};
	const {setHostLog} = await import('../../src/log/index.js');
	setHostLog(make('host'));
	const {install, installedModules, remove} = await import('../../src/pm/manager.js');

	const src = path.join(home, 'src-mod');
	await mkdir(src);
	await writeFile(path.join(src, 'yena.json'), JSON.stringify({name: 'demo', version: '1.2.3', install: 'true'}));
	const out: string[] = [];
	await install([src], l => out.push(l));

	const msgs = recs.filter(r => r.scope === 'pm').map(r => r.msg);
	for (const m of ['install command started', 'install started', 'fetched', 'swapped into place', 'install script started', 'install script finished', 'lock written', 'install finished', 'install command finished']) {
		assert.ok(msgs.includes(m), `missing ${m}`);
	}
	assert.ok(recs.some(r => r.msg === 'child exited' && r.fields?.code === 0));

	await mkdir(path.join(home, 'modules', 'broken'), {recursive: true});
	await writeFile(path.join(home, 'modules', 'broken', 'yena.json'), '{nope');
	await installedModules();
	const warn = recs.find(r => r.msg === 'module manifest unreadable');
	assert.equal(warn?.level, 'warn');
	assert.equal(warn?.fields?.dir, 'broken');

	await remove(['demo'], () => {});
	assert.ok(recs.some(r => r.msg === 'remove finished'));
});

test('a failing install script logs a rollback warning and an install failure', async () => {
	const home = await realpath(await mkdtemp(path.join(tmpdir(), 'yena-manager-')));
	process.env.YENA_HOME = home;
	const recs: {level: string; msg: string}[] = [];
	const make = (): Logger => ({
		error: msg => void recs.push({level: 'error', msg}),
		warn: msg => void recs.push({level: 'warn', msg}),
		info() {},
		debug() {},
		child: () => make(),
		addRedactor() {},
	});
	const {setHostLog} = await import('../../src/log/index.js');
	setHostLog(make());
	const {install} = await import('../../src/pm/manager.js');
	const src = path.join(home, 'bad');
	await mkdir(src);
	await writeFile(path.join(src, 'yena.json'), JSON.stringify({name: 'bad', version: '1.0.0', install: 'exit 4'}));
	await assert.rejects(install([src], () => {}), /exited with code 4/);
	assert.ok(recs.some(r => r.level === 'warn' && r.msg === 'rolling back'));
	assert.ok(recs.some(r => r.level === 'error' && r.msg === 'install failed'));
});
