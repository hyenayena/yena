import type {Manifest} from './manifest.js';

export type ModuleOrigin = 'image' | 'overlay';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function compareVersions(a: string, b: string): number {
	const ma = SEMVER.exec(a.trim());
	const mb = SEMVER.exec(b.trim());
	if (!ma || !mb) return 0;
	for (let i = 1; i <= 3; i++) {
		const d = Number(ma[i]) - Number(mb[i]);
		if (d !== 0) return Math.sign(d);
	}
	return comparePre(ma[4], mb[4]);
}

function comparePre(a: string | undefined, b: string | undefined): number {
	if (a === b) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;
	const pa = a.split('.');
	const pb = b.split('.');
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i];
		const y = pb[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			const d = Number(x) - Number(y);
			if (d !== 0) return Math.sign(d);
		} else if (nx !== ny) {
			return nx ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

export type Copy = {dir: string; manifest: Manifest};

export function pickCopy(image: Copy | undefined, overlay: Copy | undefined): {winner: Copy; origin: ModuleOrigin} | undefined {
	if (!overlay) return image && {winner: image, origin: 'image'};
	if (!image) return {winner: overlay, origin: 'overlay'};
	return compareVersions(overlay.manifest.version, image.manifest.version) >= 0
		? {winner: overlay, origin: 'overlay'}
		: {winner: image, origin: 'image'};
}
