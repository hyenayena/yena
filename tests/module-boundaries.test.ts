import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

const PUBLIC: Record<string, string[]> = {core: ['src/kit/text.ts', 'src/kit/ui.ts']};
const DEFAULT_PUBLIC = ['src/public.ts', 'src/public-ui.ts'];
const isUiEntry = (rel: string): boolean => {
	const unix = rel.split(path.sep).join('/');
	return unix === 'core/src/kit/ui.ts' || /^[^/]+\/src\/public-ui\.ts$/.test(unix);
};
const KIT_ADAPTERS = ['src/kit.ts', 'src/ui/kit.ts'];
const HOST_TYPES = 'src/api.ts';

type Ref = {spec: string; typeOnly: boolean; kind: 'static' | 'dynamic' | 'url'};

function refs(source: string): Ref[] {
	const out: Ref[] = [];
	const stat = /(?:^|\n)\s*(import|export)(\s+type\b)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
	for (const m of source.matchAll(stat)) out.push({spec: (m[3] ?? m[4]) as string, typeOnly: Boolean(m[2]), kind: 'static'});
	for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)(\.[A-Z])?/g)) out.push({spec: m[1] as string, typeOnly: Boolean(m[2]), kind: 'dynamic'});
	for (const m of source.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
		if (/\.(ts|tsx|mts|js|mjs)$/.test(m[1] as string)) out.push({spec: m[1] as string, typeOnly: false, kind: 'url'});
	}
	return out;
}

function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap(name => {
		if (name === 'node_modules' || name.startsWith('.')) return [];
		const full = path.join(dir, name);
		return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|mts|mjs|js)$/.test(name) ? [full] : [];
	});
}

const toTs = (p: string): string => {
	for (const c of [p, p.replace(/\.js$/, '.ts'), p.replace(/\.js$/, '.tsx'), `${p}.ts`]) if (existsSync(c) && statSync(c).isFile()) return c;
	return p.replace(/\.js$/, '.ts');
};

export function checkModules(root: string): string[] {
	const modulesDir = path.join(root, 'modules');
	const names = existsSync(modulesDir)
		? readdirSync(modulesDir).filter(n => existsSync(path.join(modulesDir, n, 'yena.json'))).sort()
		: [];
	const problems: string[] = [];
	const declared = new Map<string, Record<string, {optional?: boolean}>>();
	const declaredNames = (name: string) => Object.keys(declared.get(name) ?? {});
	for (const name of names) {
		const manifest = JSON.parse(readFileSync(path.join(modulesDir, name, 'yena.json'), 'utf8')) as {dependencies?: Record<string, {optional?: boolean}>};
		declared.set(name, manifest.dependencies ?? {});
	}
	const publicOf = (name: string) => (PUBLIC[name] ?? DEFAULT_PUBLIC).map(p => path.join(modulesDir, name, p));

	for (const name of names) {
		const dir = path.join(modulesDir, name);
		const used = new Set<string>();
		for (const area of ['src', 'tests']) {
			for (const file of walk(path.join(dir, area))) {
				const rel = path.relative(dir, file);
				const adapter = rel.startsWith(`src${path.sep}deps${path.sep}`) || KIT_ADAPTERS.includes(rel);
				for (const ref of refs(readFileSync(file, 'utf8'))) {
					if (!ref.spec.startsWith('.')) continue;
					const target = path.resolve(path.dirname(file), ref.spec);
					if (target === dir || target.startsWith(dir + path.sep)) continue;
					const where = `${name}/${rel}: ${ref.spec}`;
					if (toTs(target) === path.join(root, HOST_TYPES)) {
						if (!ref.typeOnly) problems.push(`${where} imports host values (only \`import type\` from src/api.ts)`);
						continue;
					}
					const other = path.relative(modulesDir, target).split(path.sep)[0] as string;
					if (target.startsWith(root + path.sep) && !target.startsWith(modulesDir + path.sep)) {
						problems.push(`${where} reaches into the host (only src/api.ts types)`);
						continue;
					}
					if (!names.includes(other)) {
						problems.push(`${where} leaves the modules`);
						continue;
					}
					if (area === 'tests') {
						problems.push(`${where}: tests import their own module and host types only`);
						continue;
					}
					if (!publicOf(other).includes(toTs(target))) problems.push(`${where} is not ${other}'s public entry`);
					if (!adapter) problems.push(`${where}: only adapter files (src/deps/*.ts) import other modules`);
					const dep = declared.get(name)?.[other];
					if (!dep) problems.push(`${where}: ${other} is not in ${name}'s yena.json dependencies`);
					else if (ref.kind === 'url' && dep.optional !== true) problems.push(`${where}: ${other} is loaded at runtime, so ${name}'s yena.json must declare it with "optional": true`);
					else if (ref.kind !== 'url' && dep.optional === true) problems.push(`${where}: ${other} is imported statically, so ${name}'s yena.json must not declare it optional`);
					used.add(other);
				}
			}
		}
		for (const dep of declaredNames(name)) {
			if (!names.includes(dep)) continue;
			if (!used.has(dep)) problems.push(`${name}/yena.json: dependency ${dep} is declared but never imported`);
		}
	}

	const state = new Map<string, 'open' | 'done'>();
	const visit = (n: string, trail: string[]): void => {
		if (state.get(n) === 'done') return;
		if (state.get(n) === 'open') {
			problems.push(`dependency cycle: ${[...trail.slice(trail.indexOf(n)), n].join(' -> ')}`);
			return;
		}
		state.set(n, 'open');
		for (const d of declaredNames(n)) if (names.includes(d)) visit(d, [...trail, n]);
		state.set(n, 'done');
	};
	for (const n of names) visit(n, []);

	for (const name of names) {
		for (const entry of publicOf(name)) {
			if (!existsSync(entry) || isUiEntry(path.relative(modulesDir, entry))) continue;
			const seen = new Set<string>();
			const stack = [entry];
			while (stack.length > 0) {
				const file = stack.pop() as string;
				if (seen.has(file) || !existsSync(file)) continue;
				seen.add(file);
				for (const ref of refs(readFileSync(file, 'utf8'))) {
					if (ref.typeOnly) continue;
					if (/^(react|ink)(\/|$)/.test(ref.spec)) problems.push(`${path.relative(modulesDir, entry)} loads ${ref.spec} (through ${path.relative(modulesDir, file)})`);
					else if (ref.spec.startsWith('.')) {
						const next = toTs(path.resolve(path.dirname(file), ref.spec));
						if (isUiEntry(path.relative(modulesDir, next))) problems.push(`${path.relative(modulesDir, entry)} reaches the UI entry ${path.relative(modulesDir, next)}`);
						else stack.push(next);
					}
				}
			}
		}
	}
	return problems;
}

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('module boundaries', () => {
	it('hold for the installed modules', {skip: !existsSync(path.join(root, 'modules')) && 'no modules installed'}, () => {
		assert.deepEqual(checkModules(root), []);
	});

	const tmp = mkdtempSync(path.join(tmpdir(), 'yena-boundaries-'));
	after(() => rmSync(tmp, {recursive: true, force: true}));
	const make = (files: Record<string, string>): string => {
		const dir = mkdtempSync(path.join(tmp, 'r-'));
		writeFileSync(path.join(mkdir(dir, 'src'), 'api.ts'), 'export type X = 1;\n');
		for (const [p, text] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(dir, p)), {recursive: true});
			writeFileSync(path.join(dir, p), text);
		}
		return dir;
	};
	const mkdir = (a: string, b: string): string => {
		mkdirSync(path.join(a, b), {recursive: true});
		return path.join(a, b);
	};
	const manifest = (deps: string[] = [], optional: string[] = []) =>
		JSON.stringify({
			name: 'x',
			version: '0.0.0',
			dependencies: Object.fromEntries([...deps.map(d => [d, {source: d, version: '^0.0.0'}]), ...optional.map(d => [d, {source: d, version: '^0.0.0', optional: true}])]),
		});

	it('accept adapters into public entries, host types and optional URL imports', () => {
		const dir = make({
			'modules/a/yena.json': manifest(['b'], ['c']),
			'modules/a/src/index.ts': "import type {X} from '../../../src/api.js';\nimport {f} from './deps/b.js';\n",
			'modules/a/src/deps/b.ts': "export {f} from '../../../b/src/public.js';\n",
			'modules/a/src/deps/c.ts': "const u = new URL('../../../c/src/public.ts', import.meta.url);\n",
			'modules/b/yena.json': manifest(),
			'modules/b/src/public.ts': "import {g} from './inner.js';\nexport const f = g;\n",
			'modules/b/src/inner.ts': 'export const g = 1;\n',
			'modules/c/yena.json': manifest(),
			'modules/c/src/public.ts': 'export const h = 1;\n',
		});
		assert.deepEqual(checkModules(dir), []);
	});

	it('require a runtime-loaded dependency to be optional and an optional one not to be imported', () => {
		const dir = make({
			'modules/a/yena.json': manifest(['b', 'c'], []),
			'modules/a/src/deps/b.ts': "export {f} from '../../../b/src/public.js';\n",
			'modules/a/src/deps/c.ts': "const u = new URL('../../../c/src/public.ts', import.meta.url);\n",
			'modules/b/yena.json': manifest(),
			'modules/b/src/public.ts': 'export const f = 1;\n',
			'modules/c/yena.json': manifest(),
			'modules/c/src/public.ts': 'export const h = 1;\n',
		});
		assert.match(checkModules(dir).join('\n'), /a\/src\/deps\/c\.ts: .*c is loaded at runtime.*"optional": true/);
		const other = make({
			'modules/a/yena.json': manifest([], ['b']),
			'modules/a/src/deps/b.ts': "export {f} from '../../../b/src/public.js';\n",
			'modules/b/yena.json': manifest(),
			'modules/b/src/public.ts': 'export const f = 1;\n',
		});
		assert.match(checkModules(other).join('\n'), /a\/src\/deps\/b\.ts: .*b is imported statically.*not declare it optional/);
	});

	it('accept a UI entry src/public-ui.ts through an adapter', () => {
		const dir = make({
			'modules/a/yena.json': manifest(['b']),
			'modules/a/src/index.ts': "const ui = () => import('./deps/b-ui.js');\n",
			'modules/a/src/deps/b-ui.ts': "export {v} from '../../../b/src/public-ui.js';\n",
			'modules/a/src/deps/b.ts': "export {f} from '../../../b/src/public.js';\n",
			'modules/b/yena.json': manifest(),
			'modules/b/src/public.ts': 'export const f = 1;\n',
			'modules/b/src/public-ui.ts': "import {Box} from 'ink';\nexport const v = Box;\n",
		});
		assert.deepEqual(checkModules(dir), []);
	});

	it('find every kind of violation', () => {
		const dir = make({
			'modules/a/yena.json': manifest(['b', 'c']),
			'modules/a/src/index.ts': "import {X} from '../../../src/api.js';\nimport {g} from '../../b/src/inner.js';\nimport {h} from '../../../src/pm/run.js';\n",
			'modules/a/src/deps/b.ts': "export {f} from '../../../b/src/public.js';\n",
			'modules/a/src/deps/d.ts': "export {k} from '../../../d/src/public.js';\n",
			'modules/d/yena.json': manifest(),
			'modules/d/src/public.ts': "import {u} from './public-ui.js';\nexport const k = u;\n",
			'modules/d/src/public-ui.ts': "import React from 'react';\nexport const u = React;\n",
			'modules/a/tests/t.test.ts': "import {f} from '../../b/src/public.js';\n",
			'modules/b/yena.json': manifest(['a']),
			'modules/b/src/public.ts': "import {Box} from 'ink';\nexport const f = 1;\n",
			'modules/b/src/inner.ts': "import {x} from './deps/a.js';\nexport const g = 1;\n",
			'modules/b/src/deps/a.ts': "export {x} from '../../../a/src/public.js';\n",
			'modules/a/src/public.ts': 'export const x = 1;\n',
			'modules/c/yena.json': manifest(),
		});
		const problems = checkModules(dir).join('\n');
		for (const expected of [
			/a\/src\/index\.ts: \.\.\/\.\.\/\.\.\/src\/api\.js imports host values/,
			/a\/src\/index\.ts: \.\.\/\.\.\/b\/src\/inner\.js is not b's public entry/,
			/a\/src\/index\.ts: \.\.\/\.\.\/b\/src\/inner\.js: only adapter files/,
			/a\/src\/index\.ts: \.\.\/\.\.\/\.\.\/src\/pm\/run\.js reaches into the host/,
			/a\/src\/deps\/d\.ts: .*d is not in a's yena\.json dependencies/,
			/a\/tests\/t\.test\.ts: .*tests import their own module/,
			/a\/yena\.json: dependency c is declared but never imported/,
			/dependency cycle: a -> b -> a|dependency cycle: b -> a -> b/,
			/b\/src\/public\.ts loads ink/,
			/d\/src\/public\.ts reaches the UI entry d\/src\/public-ui\.ts/,
		]) {
			assert.match(problems, expected);
		}
	});
});
