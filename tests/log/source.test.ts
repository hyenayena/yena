import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

const dir = path.resolve(import.meta.dirname, '../../src/log');

test('src/log is isolated from env, credentials and modules', () => {
	const files = readdirSync(dir).filter(f => f.endsWith('.ts'));
	assert.ok(files.length >= 7);
	for (const f of files) {
		const code = readFileSync(path.join(dir, f), 'utf8');
		assert.ok(!/process\.env/.test(code), `${f}: process.env`);
		assert.ok(!/ANTHROPIC|CLAUDE_CODE|OAUTH|credentials|\.token/.test(code), `${f}: credential name`);
		assert.ok(!/from ['"][^'"]*modules\//.test(code), `${f}: modules import`);
	}
});
