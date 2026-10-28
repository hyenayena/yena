import {realpathSync} from 'node:fs';
import {registerHooks, type ResolveHookContext, type ResolveFnOutput} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export type ModuleMap = {
	/** Folders holding module folders (`<root>/modules`, the overlay). */
	roots: string[];
	/** Module name -> folder of the copy in use. */
	winners: ReadonlyMap<string, string>;
	/** Bare imports an overlay module cannot resolve are retried from here (the host's `node_modules`). */
	hostRoot: string;
	overlay?: string;
};

const real = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return path.resolve(p);
	}
};

/** Node reports module URLs by real path, so the map is compared in real paths too. */
export function realModuleMap(map: ModuleMap): ModuleMap {
	return {
		roots: map.roots.map(real),
		winners: new Map([...map.winners].map(([name, dir]) => [name, real(dir)])),
		hostRoot: real(map.hostRoot),
		...(map.overlay !== undefined && {overlay: real(map.overlay)}),
	};
}

const under = (file: string, dir: string) => file.startsWith(dir + path.sep);

/**
 * `<root>/<name>/<rest>` under any module root -> `<winner of name>/<rest>`, or undefined when the
 * path is outside the roots, names an unknown module or already points at the winner.
 */
export function mapModulePath(file: string, map: ModuleMap): string | undefined {
	for (const root of map.roots) {
		if (!under(file, root)) continue;
		const rest = file.slice(root.length + 1);
		const cut = rest.indexOf(path.sep);
		const name = cut === -1 ? rest : rest.slice(0, cut);
		const winner = map.winners.get(name);
		if (winner === undefined) return undefined;
		const mapped = cut === -1 ? winner : path.join(winner, rest.slice(cut + 1));
		return mapped === file ? undefined : mapped;
	}
	return undefined;
}

const isRelative = (s: string) => s.startsWith('./') || s.startsWith('../');
const isBare = (s: string) => !isRelative(s) && !s.startsWith('/') && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(s) && !s.startsWith('#');

type Next = (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput;

export function resolveAcrossRoots(specifier: string, context: ResolveHookContext, next: Next, map: ModuleMap): ResolveFnOutput {
	const parent = context.parentURL;
	let target: URL | undefined;
	if (specifier.startsWith('file:')) target = new URL(specifier);
	else if (isRelative(specifier) && parent?.startsWith('file:')) target = new URL(specifier, parent);

	if (target) {
		const mapped = mapModulePath(fileURLToPath(target), map);
		if (mapped === undefined) return next(specifier, context);
		const url = pathToFileURL(mapped);
		url.search = target.search;
		url.hash = target.hash;
		return next(url.href, context);
	}

	if (map.overlay !== undefined && isBare(specifier) && parent?.startsWith('file:') && under(fileURLToPath(parent), map.overlay)) {
		try {
			return next(specifier, context);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// The hook also sees require() calls, which fail with the CommonJS code.
			if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw error;
			return next(specifier, {...context, parentURL: pathToFileURL(map.hostRoot + path.sep).href});
		}
	}
	return next(specifier, context);
}

/**
 * Modules import each other by relative paths into one shared `modules/` folder and find react/ink
 * by walking up to the host's `node_modules`. With modules split between the image and the overlay,
 * this hook keeps both working and makes every module load from exactly one copy (singletons such as
 * core's kit and React context depend on that). Registered after tsx, so it runs first and tsx still
 * maps `.js` to `.ts` on the rewritten URL.
 */
export function registerModuleHooks(map: ModuleMap): void {
	const resolved = realModuleMap(map);
	registerHooks({resolve: (specifier, context, next) => resolveAcrossRoots(specifier, context, next, resolved)});
}
