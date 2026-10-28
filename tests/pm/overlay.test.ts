import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Manifest} from '../../src/pm/manifest.js';
import {compareVersions, pickCopy} from '../../src/pm/overlay.js';

test('compareVersions follows semver order', () => {
	assert.equal(compareVersions('0.4.0', '0.3.9'), 1);
	assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
	assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
	assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
	assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
	assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
	assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
	assert.equal(compareVersions('1.0.0+build', '1.0.0'), 0);
});

test('versions that are not semver compare equal', () => {
	assert.equal(compareVersions('dev', '1.0.0'), 0);
	assert.equal(compareVersions('1.0', '2.0.0'), 0);
});

const copy = (dir: string, version: string) => ({dir, manifest: {name: 'm', version, dependencies: {}} as Manifest});

test('pickCopy: the newer version wins, the overlay on a tie', () => {
	assert.equal(pickCopy(copy('img', '0.4.0'), copy('ov', '0.3.0'))?.origin, 'image');
	assert.equal(pickCopy(copy('img', '0.3.0'), copy('ov', '0.4.0'))?.origin, 'overlay');
	assert.equal(pickCopy(copy('img', '0.4.0'), copy('ov', '0.4.0'))?.winner.dir, 'ov');
	assert.equal(pickCopy(copy('img', '1.0.0'), undefined)?.origin, 'image');
	assert.equal(pickCopy(undefined, copy('ov', '1.0.0'))?.origin, 'overlay');
	assert.equal(pickCopy(undefined, undefined), undefined);
});
