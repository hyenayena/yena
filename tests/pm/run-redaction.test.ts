import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createHostLogger} from '../../src/log/index.js';
import {run} from '../../src/pm/run.js';
import {tmp} from '../log/helpers.js';

test('a credentialed URL on the stderr tail is redacted by the real logger', async () => {
	const root = tmp();
	const logger = createHostLogger({root, env: {}});
	const code = `console.error('fatal: unable to access https://user:pass@127.0.0.1:1/x.git/'); process.exit(128)`;
	await assert.rejects(run(process.execPath, ['-e', code], {trace: logger.child('pm')}), /exited with code 128/);
	logger.close();
	const text = readFileSync(logger.file, 'utf8');
	const failed = text
		.split('\n')
		.filter(Boolean)
		.map(l => JSON.parse(l) as {level: string; msg: string; data?: {stderrTail?: string}})
		.find(r => r.msg === 'child failed');
	assert.equal(failed?.level, 'warn');
	assert.match(failed?.data?.stderrTail ?? '', /unable to access/);
	assert.ok(!text.includes('user:pass'));
	assert.ok(!text.includes('pass@'));
});
