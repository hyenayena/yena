import assert from 'node:assert/strict';
import type {ResolveHookContext, ResolveFnOutput} from 'node:module';
import path from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {mapModulePath, resolveAcrossRoots, type ModuleMap} from '../../src/pm/module-hooks.js';

const image = path.resolve('/img/modules');
const overlay = path.resolve('/data/host/modules');
const map: ModuleMap = {
	roots: [image, overlay],
	winners: new Map([
		['core', path.join(image, 'core')],
		['claude', path.join(overlay, 'claude')],
	]),
	hostRoot: path.resolve('/img'),
	overlay,
};
const url = (p: string) => pathToFileURL(p).href;

test('mapModulePath rewrites a path to the winning copy of its module', () => {
	assert.equal(mapModulePath(path.join(overlay, 'core/src/kit/text.js'), map), path.join(image, 'core/src/kit/text.js'));
	assert.equal(mapModulePath(path.join(image, 'claude/src/public.ts'), map), path.join(overlay, 'claude/src/public.ts'));
	assert.equal(mapModulePath(path.join(image, 'core'), map), undefined);
});

test('mapModulePath leaves winners, unknown modules and other paths alone', () => {
	assert.equal(mapModulePath(path.join(image, 'core/src/a.ts'), map), undefined);
	assert.equal(mapModulePath(path.join(image, 'nope/src/a.ts'), map), undefined);
	assert.equal(mapModulePath(path.resolve('/img/src/api.ts'), map), undefined);
	assert.equal(mapModulePath(path.resolve('/img/modules-other/core/a.ts'), map), undefined);
});

type Call = {specifier: string; parentURL?: string};
const ctx = (parent: string): ResolveHookContext => ({conditions: ['import'], importAttributes: {}, parentURL: url(parent)});

function recorder(fail: (c: Call) => boolean = () => false) {
	const calls: Call[] = [];
	const next = (specifier: string, context?: Partial<ResolveHookContext>): ResolveFnOutput => {
		const call = {specifier, parentURL: context?.parentURL};
		calls.push(call);
		if (fail(call)) throw Object.assign(new Error('not found'), {code: 'ERR_MODULE_NOT_FOUND'});
		return {url: specifier.startsWith('file:') ? specifier : `resolved:${specifier}`};
	};
	return {calls, next};
}

test('a relative import into another module goes to its winner, keeping the query', () => {
	const {calls, next} = recorder();
	resolveAcrossRoots('../../core/src/kit/text.js?x=1', ctx(path.join(overlay, 'claude/src/kit.ts')), next, map);
	assert.equal(calls[0]?.specifier, `${url(path.join(image, 'core/src/kit/text.js'))}?x=1`);
});

test('a file URL import (optional adapters) is mapped too', () => {
	const {calls, next} = recorder();
	resolveAcrossRoots(url(path.join(image, 'claude/src/public.ts')), ctx(path.join(image, 'core/src/a.ts')), next, map);
	assert.equal(calls[0]?.specifier, url(path.join(overlay, 'claude/src/public.ts')));
});

test('imports inside a module pass through unchanged', () => {
	const {calls, next} = recorder();
	resolveAcrossRoots('./b.js', ctx(path.join(overlay, 'claude/src/a.ts')), next, map);
	assert.deepEqual(calls.map(c => c.specifier), ['./b.js']);
});

test('a bare import an overlay module cannot resolve is retried from the host root', () => {
	const {calls, next} = recorder(c => c.parentURL !== url(path.resolve('/img') + path.sep));
	const out = resolveAcrossRoots('react', ctx(path.join(overlay, 'claude/src/a.ts')), next, map);
	assert.equal(out.url, 'resolved:react');
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.parentURL, url(path.resolve('/img') + path.sep));
});

test('a failing require() from an overlay module is retried too', () => {
	const calls: string[] = [];
	const next = (specifier: string, context?: Partial<ResolveHookContext>): ResolveFnOutput => {
		calls.push(context?.parentURL ?? '');
		if (calls.length === 1) throw Object.assign(new Error('not found'), {code: 'MODULE_NOT_FOUND'});
		return {url: `resolved:${specifier}`};
	};
	assert.equal(resolveAcrossRoots('ink', ctx(path.join(overlay, 'claude/src/a.ts')), next, map).url, 'resolved:ink');
	assert.equal(calls[1], url(path.resolve('/img') + path.sep));
});

test('bare imports from image modules and other errors are not retried', () => {
	const fromImage = recorder(() => true);
	assert.throws(() => resolveAcrossRoots('react', ctx(path.join(image, 'core/src/a.ts')), fromImage.next, map), /not found/);
	assert.equal(fromImage.calls.length, 1);
	const other = (s: string): ResolveFnOutput => {
		throw Object.assign(new Error(`bad ${s}`), {code: 'ERR_INVALID_PACKAGE_CONFIG'});
	};
	assert.throws(() => resolveAcrossRoots('react', ctx(path.join(overlay, 'claude/src/a.ts')), other, map), /bad react/);
});
