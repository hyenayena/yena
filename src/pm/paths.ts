import {realpath} from 'node:fs/promises';
import path from 'node:path';

export const escapes = (from: string, to: string) => {
	const rel = path.relative(from, to);
	return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
};

export async function resolveInside(dir: string, rel: string, label = 'path'): Promise<string> {
	const outside = () => new Error(`"${label}" points outside the module`);
	if (path.isAbsolute(rel)) throw outside();
	const target = path.resolve(dir, rel);
	if (escapes(dir, target)) throw outside();

	let realTarget: string;
	let realDir: string;
	try {
		[realDir, realTarget] = await Promise.all([realpath(dir), realpath(target)]);
	} catch {
		throw new Error(`"${label}" file not found`);
	}
	if (escapes(realDir, realTarget)) throw outside();
	return realTarget;
}
