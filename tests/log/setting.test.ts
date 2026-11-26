import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {readLogSetting, writeLogSetting} from '../../src/log/setting.js';
import {tmp} from './helpers.js';

test('round trip, creating the state directory', async () => {
	const dir = path.join(tmp(), 'state');
	assert.equal(await readLogSetting(dir), undefined);
	await writeLogSetting(dir, 'debug');
	assert.equal(await readLogSetting(dir), 'debug');
	await writeLogSetting(dir, 'off');
	assert.equal(await readLogSetting(dir), 'off');
});

test('a broken or invalid file reads as undefined', async () => {
	const dir = tmp();
	mkdirSync(dir, {recursive: true});
	for (const body of ['{', 'null', '{"level":"loud"}', '{"level":3}', '[]']) {
		writeFileSync(path.join(dir, 'log.json'), body);
		assert.equal(await readLogSetting(dir), undefined, body);
	}
});
