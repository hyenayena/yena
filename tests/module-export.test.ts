import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseManifest} from '../src/pm/manifest.js';
import {officialModuleName} from '../src/pm/source.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const lockFile = path.join(root, 'yena-modules.json');
const skip = (!existsSync(path.join(root, 'modules')) || !existsSync(lockFile)) && 'no modules installed';

test('every official module in the lock still has a valid legacy export list or a .yenarules [deny export] header', {skip}, () => {
	const lock = (JSON.parse(readFileSync(lockFile, 'utf8')) as {modules?: Record<string, {source: string}>}).modules ?? {};
	const missing: string[] = [];
	for (const [name, entry] of Object.entries(lock)) {
		if (officialModuleName(entry.source) !== name) continue;
		const file = path.join(root, 'modules', name, 'yena.json');
		if (!existsSync(file)) continue;
		const manifest = parseManifest(readFileSync(file, 'utf8'));
		const rules = path.join(root, 'modules', name, '.yenarules');
		const header = existsSync(rules) && /^\[deny export\]\s*$/m.test(readFileSync(rules, 'utf8'));
		if (manifest.export === undefined && !header) missing.push(`${name}: neither "export" in yena.json nor [deny export] in .yenarules`);
	}
	assert.deepEqual(missing, []);
});
