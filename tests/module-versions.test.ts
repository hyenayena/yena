import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseManifest} from '../src/pm/manifest.js';
import {dependencyProblems, problemText} from '../src/pm/versions.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const modulesDir = path.join(root, 'modules');
const skip = !existsSync(modulesDir) && 'no modules installed';

const installed = skip
	? []
	: readdirSync(modulesDir)
			.filter(n => existsSync(path.join(modulesDir, n, 'yena.json')))
			.sort()
			.map(n => parseManifest(readFileSync(path.join(modulesDir, n, 'yena.json'), 'utf8')));
const asSet = (list: {name: string; version: string; dependencies: ReturnType<typeof parseManifest>['dependencies']}[]) =>
	list.map(m => ({name: m.name, version: m.version, dependencies: m.dependencies}));

test('every installed module satisfies the ranges its dependents declare (a release of a dependency means updating its dependents)', {skip}, () => {
	assert.deepEqual(dependencyProblems(asSet(installed)).map(problemText), []);
});

test('the lock records the installed versions, and the locked versions satisfy the ranges', {skip}, () => {
	const lockFile = path.join(root, 'yena-modules.json');
	if (!existsSync(lockFile)) return;
	const lock = (JSON.parse(readFileSync(lockFile, 'utf8')) as {modules?: Record<string, {version: string}>}).modules ?? {};
	const byName = new Map(installed.map(m => [m.name, m]));
	const stale = Object.entries(lock).flatMap(([name, entry]) => {
		const have = byName.get(name);
		return have && have.version !== entry.version ? [`${name}: lock has ${entry.version}, installed ${have.version}; run "mod lock"`] : [];
	});
	assert.deepEqual(stale, []);
	const locked = installed.filter(m => lock[m.name]).map(m => ({...m, version: lock[m.name]!.version}));
	const all = installed.map(m => locked.find(l => l.name === m.name) ?? m);
	assert.deepEqual(dependencyProblems(asSet(all)).map(problemText), []);
});
