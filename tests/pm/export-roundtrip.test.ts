import assert from 'node:assert/strict';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, symlink, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {Logger} from '../../src/api.js';
import {parseManifest} from '../../src/pm/manifest.js';
import type {AlignItem, ResolvedModule} from '../../src/pm/manager.js';
import {readModuleCode} from '../../src/pm/module-code.js';
import {replaceModuleData} from '../../src/pm/module-data.js';
import {createModuleRegistry} from '../../src/pm/registry.js';

const C1 = 'a'.repeat(40);
const limits = {maxFiles: 100, maxFileBytes: 4096, maxTotalBytes: 100_000};
const noopLog = {error() {}, warn() {}, info() {}, debug() {}, child: () => noopLog, addRedactor() {}} as Logger;
const tmp = () => mkdtemp(path.join(tmpdir(), 'yena-rt-'));
const RULES = {deny: ['secret.key', 'private/**', '.env*']};

async function put(root: string, rel: string, text: string, mode = 0o644, mtime?: number) {
	const file = path.join(root, ...rel.split('/'));
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, text);
	await chmod(file, mode);
	if (mtime !== undefined) await utimes(file, mtime, mtime);
}

async function snapshot(dir: string, rel = ''): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const e of await readdir(path.join(dir, rel), {withFileTypes: true})) {
		const r = rel === '' ? e.name : `${rel}/${e.name}`;
		const abs = path.join(dir, r);
		if (e.isSymbolicLink()) out[r] = `-> ${await readlink(abs)}`;
		else if (e.isDirectory()) {
			out[r] = `dir ${((await lstat(abs)).mode & 0o777).toString(8)}`;
			Object.assign(out, await snapshot(dir, r));
		} else {
			const info = await stat(abs);
			out[r] = `${await readFile(abs, 'utf8')} ${(info.mode & 0o777).toString(8)} ${Math.floor(info.mtimeMs / 1000)}`;
		}
	}
	return out;
}

async function mkModule(name: string, version: string, extra: Record<string, unknown> = {}): Promise<ResolvedModule> {
	const dir = path.join(await tmp(), name);
	await mkdir(dir, {recursive: true});
	const raw = JSON.stringify({name, version, ...extra});
	await writeFile(path.join(dir, 'yena.json'), raw);
	return {dir, manifest: parseManifest(raw), origin: 'image'};
}

function registry(modules: ResolvedModule[], dataRoot: string, imageVersions: Record<string, string> = {}, onAlign?: (items: AlignItem[]) => void) {
	return createModuleRegistry({
		resolveModules: async () => ({modules}),
		locksByOrigin: async () => ({image: Object.fromEntries(modules.map(m => [m.manifest.name, {source: m.manifest.name, version: m.manifest.version, commit: C1}]))}),
		alignPinned: async (items, _log, after) => {
			onAlign?.([...items]);
			await after(new Map());
		},
		imageVersionOf: async name => imageVersions[name],
		dataRoot,
		hostVersion: '0.9.0',
		log: noopLog,
	});
}

async function source() {
	const root = await tmp();
	await put(root, 'md/notes.md', 'N', 0o600, 1_600_000_000);
	await put(root, 'md/deep/er/a.json', '{"a":1}', 0o755, 1_600_000_100);
	await put(root, 'md/secret.key', 'TOP-SECRET-SOURCE');
	await put(root, 'md/private/x', 'TOP-SECRET-SOURCE');
	await put(root, 'md/.env.local', 'TOP-SECRET-SOURCE');
	return root;
}

test('round trip: exported data lands in the target, denied files never leave the source or touch the target', async () => {
	const srcRoot = await source();
	const mod = await mkModule('md', '1.0.0', {export: RULES});
	const exported = await registry([mod], srcRoot).readData('md', limits);
	assert.deepEqual(exported.files.map(f => f.path), ['deep/er/a.json', 'notes.md']);
	for (const f of exported.files) assert.equal(Buffer.from(f.data).toString().includes('TOP-SECRET'), false);

	const dstRoot = await tmp();
	await put(dstRoot, 'md/secret.key', 'TARGET-PRIVATE', 0o600);
	await put(dstRoot, 'md/private/keep', 'TARGET-PRIVATE');
	await put(dstRoot, 'md/.env.local', 'TARGET-PRIVATE');
	await put(dstRoot, 'md/stale.md', 'OLD');
	await put(dstRoot, 'md/stale/dir/f', 'OLD');
	await symlink('/etc/hostname', path.join(dstRoot, 'md', 'link'));
	const backupDir = path.join(await tmp(), 'bk');
	const dst = registry([await mkModule('md', '1.0.0', {export: RULES})], dstRoot);
	const result = await dst.applyImport({targets: [{name: 'md', version: '1.0.0'}], data: [{name: 'md', files: exported.files}], backupDir}, () => {});

	assert.equal(result.replaced[0]!.written, 2);
	const after = await snapshot(path.join(dstRoot, 'md'));
	assert.equal(after['notes.md'], 'N 600 1600000000');
	assert.equal(after['deep/er/a.json'], '{"a":1} 755 1600000100');
	assert.equal(after['secret.key']?.startsWith('TARGET-PRIVATE'), true);
	assert.equal(after['private/keep']?.startsWith('TARGET-PRIVATE'), true);
	assert.equal(after['.env.local']?.startsWith('TARGET-PRIVATE'), true);
	assert.equal(after['link'], '-> /etc/hostname');
	assert.equal('stale.md' in after, false);
	assert.equal('stale/dir/f' in after, false);
	assert.equal(await readFile(path.join(backupDir, 'md', 'stale.md'), 'utf8'), 'OLD');
	assert.equal(await readFile(path.join(backupDir, 'md', 'stale', 'dir', 'f'), 'utf8'), 'OLD');
	assert.deepEqual(Object.keys(await snapshot(backupDir)).filter(k => /secret|private|env|link/.test(k)), []);
});

test('round trip: an archive that names denied files cannot write them or reach outside the target', async () => {
	const dstRoot = await tmp();
	await put(dstRoot, 'md/secret.key', 'TARGET-PRIVATE');
	const mod = await mkModule('md', '1.0.0', {export: RULES});
	const before = await snapshot(dstRoot);
	const hostile = (p: string) => ({path: p, mode: 0o644, mtimeMs: 0, data: Buffer.from('X')});
	for (const bad of ['../escape', '/abs', 'a/../../b', 'a\\b', 'nul\0x', 'a//b', './a']) {
		const backupDir = path.join(await tmp(), 'bk');
		await assert.rejects(
			registry([mod], dstRoot).applyImport({targets: [{name: 'md', version: '1.0.0'}], data: [{name: 'md', files: [hostile('ok'), hostile(bad)]}], backupDir}, () => {}),
			/Invalid path/,
			JSON.stringify(bad),
		);
	}
	assert.deepEqual(await snapshot(dstRoot), before);
	const backupDir = path.join(await tmp(), 'bk');
	const r = await registry([mod], dstRoot).applyImport(
		{targets: [{name: 'md', version: '1.0.0'}], data: [{name: 'md', files: [hostile('secret.key'), hostile('private/x'), hostile('.env.prod'), hostile('fine')]}], backupDir},
		() => {},
	);
	assert.equal(r.replaced[0]!.written, 1);
	assert.equal(r.replaced[0]!.skipped, 3);
	assert.equal(await readFile(path.join(dstRoot, 'md', 'secret.key'), 'utf8'), 'TARGET-PRIVATE');
	await assert.rejects(stat(path.join(dstRoot, 'md', 'private')));
});

test('round trip: a write that fails midway restores files, modes, mtimes, folders and the denied files exactly', async () => {
	const root = await tmp();
	await put(root, 'md/keep.json', 'K', 0o600, 1_500_000_000);
	await put(root, 'md/sub/inner/a', 'A', 0o640, 1_500_000_001);
	await put(root, 'md/secret.key', 'PRIVATE', 0o600, 1_500_000_002);
	await put(root, 'md/private/p', 'PRIVATE', 0o600, 1_500_000_003);
	await symlink('keep.json', path.join(root, 'md', 'ln'));
	const before = await snapshot(root);
	const backupDir = path.join(await tmp(), 'bk');
	const f = (p: string) => ({path: p, mode: 0o644, mtimeMs: 1_000_000_000_000, data: Buffer.from('NEW')});
	let writes = 0;
	await assert.rejects(
		replaceModuleData(root, [{name: 'md', files: [f('n1'), f('d/n2'), f('d/e/n3'), f('n4')]}], {
			backupDir,
			rulesFor: () => RULES,
			beforeWrite: () => {
				if (++writes === 3) throw new Error('disk full');
			},
		}),
		/rolled back: disk full/,
	);
	assert.equal(writes, 3);
	assert.deepEqual(await snapshot(root), before);
	await assert.rejects(lstat(backupDir));
});

test('round trip: an unrelated module and a module without rules are never touched', async () => {
	const root = await tmp();
	await put(root, 'other/data', 'O');
	await put(root, 'norules/data', 'R');
	const before = await snapshot(root);
	const backupDir = path.join(await tmp(), 'bk');
	const f = {path: 'data', mode: 0o644, mtimeMs: 0, data: Buffer.from('EVIL')};
	const reg = registry([await mkModule('other', '1.0.0', {export: {deny: []}}), await mkModule('norules', '1.0.0')], root);
	const r = await reg.applyImport({targets: [{name: 'norules', version: '1.0.0'}], data: [{name: 'norules', files: [f]}], backupDir}, () => {});
	assert.equal(r.replaced[0]!.defaultDeny, true);
	assert.equal(r.replaced[0]!.written, 0);
	assert.deepEqual(await snapshot(root), before);
});

test('image wins: an older export of an image module is refused before anything runs; equal or newer is allowed', async () => {
	const root = await tmp();
	await put(root, 'md/old', 'OLD');
	const before = await snapshot(root);
	const aligned: AlignItem[][] = [];
	const reg = registry([await mkModule('md', '1.0.0', {export: {deny: []}})], root, {md: '2.0.0'}, items => aligned.push(items));
	const backupDir = path.join(await tmp(), 'bk');
	const file = {path: 'new', mode: 0o644, mtimeMs: 0, data: Buffer.from('N')};
	await assert.rejects(
		reg.applyImport({targets: [{name: 'md', version: '1.5.0', source: 'md', commit: 'b'.repeat(40)}], data: [{name: 'md', files: [file]}], backupDir}, () => {}),
		/cannot replace the image's 2\.0\.0: a newer image copy always wins/,
	);
	assert.equal(aligned.length, 0);
	assert.deepEqual(await snapshot(root), before);
	await assert.rejects(lstat(backupDir));

	const plan = await reg.planImport([{name: 'md', version: '2.0.0', source: 'md', commit: 'b'.repeat(40)}]);
	assert.deepEqual(plan.problems, []);
	assert.deepEqual((await reg.planImport([{name: 'md', version: '3.0.0', source: 'md', commit: 'b'.repeat(40)}])).problems, []);
});

test('carried code: secret-like files and dependency folders are never packed', async () => {
	const dir = path.join(await tmp(), 'clan');
	await put(dir, 'yena.json', JSON.stringify({name: 'clan', version: '1.0.0'}));
	await put(dir, 'src/main.ts', 'm');
	await put(dir, '.env.example', 'EXAMPLE=');
	for (const secret of ['.env', '.env.local', '.env.production', '.envrc', '.npmrc', '.netrc', '.pgpass', 'server.pem', 'tls.KEY', 'cert.p12', 'cert.pfx', 'id_rsa', 'id_ed25519.pub', 'sub/deep/.env', 'sub/deep/id_ecdsa']) {
		await put(dir, secret, 'LEAK');
	}
	await put(dir, 'node_modules/pkg/index.js', 'LEAK');
	await put(dir, 'sub/node_modules/pkg/index.js', 'LEAK');
	await put(dir, '.venv/lib/x.py', 'LEAK');
	await put(dir, '.yena/state', 'LEAK');
	await symlink('/etc/passwd', path.join(dir, 'passwd-link'));
	const read = await readModuleCode(dir, limits);
	assert.deepEqual(read.files.map(f => f.path), ['.env.example', 'src/main.ts', 'yena.json']);
	for (const f of read.files) assert.equal(Buffer.from(f.data).toString().includes('LEAK'), false);
});
