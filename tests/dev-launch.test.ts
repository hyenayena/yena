import assert from 'node:assert/strict';
import {mkdtemp, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {clearDevFailure, devLaunchTarget, readDevFailure, writeDevFailure} from '../src/dev-launch.js';

const dev = {mode: 'dev' as const, devRoot: '/workplace/yena'};
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({YENA_DATA: '/data', ...extra});

test('devLaunchTarget starts the dev root only from another root, with YENA_DATA, not stable, not as the child', () => {
	assert.equal(devLaunchTarget(env(), '/app', dev), '/workplace/yena');
	assert.equal(devLaunchTarget(env(), '/app', {...dev, mode: 'image'}), undefined);
	assert.equal(devLaunchTarget(env(), '/workplace/yena/', dev), undefined);
	assert.equal(devLaunchTarget(env({YENA_STABLE: '1'}), '/app', dev), undefined);
	assert.equal(devLaunchTarget(env({YENA_DEV_CHILD: '1'}), '/app', dev), undefined);
	assert.equal(devLaunchTarget({}, '/app', dev), undefined);
});

test('the failure record is sanitized, capped, read back and cleared', async () => {
	const dir = path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'yena-devfail-'))), 'host');
	const ESC = String.fromCharCode(27);
	await writeDevFailure(dir, {devRoot: '/w', pid: 7, name: 'TypeError', message: `bad ${ESC}[31mred${ESC}[0m`, stack: 'x'.repeat(20_000)});
	const rec = await readDevFailure(dir);
	assert.equal(rec?.message, 'bad red');
	assert.equal(rec?.pid, 7);
	assert.ok((rec?.stack?.length ?? 0) < 9 * 1024);
	assert.match(rec?.stack ?? '', /…\[truncated \d+ chars\]$/);
	assert.match(rec?.at ?? '', /^\d{4}-\d\d-\d\dT/);
	await clearDevFailure(dir);
	assert.equal(await readDevFailure(dir), undefined);
});
