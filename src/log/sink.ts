import fs from 'node:fs';
import path from 'node:path';

export type SinkIo = Pick<
	typeof fs,
	| 'openSync'
	| 'closeSync'
	| 'writeSync'
	| 'fstatSync'
	| 'lstatSync'
	| 'mkdirSync'
	| 'renameSync'
	| 'unlinkSync'
	| 'ftruncateSync'
	| 'fchmodSync'
>;

export type Sink = {
	readonly file: string;
	write(line: string): void;
	close(): void;
};

export type SinkOptions = {
	dir: string;
	name?: string;
	maxBytes: number;
	generations: number;
	io?: Partial<SinkIo>;
	dropNotice: (dropped: number) => string;
};

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function refuse(code: string, message: string): Error {
	return Object.assign(new Error(message), {code});
}

export function openSink(opts: SinkOptions): Sink {
	const io: SinkIo = {...fs, ...opts.io};
	const {dir, maxBytes, generations} = opts;
	const file = path.join(dir, opts.name ?? 'yena.log');
	const {O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_WRONLY, O_CREAT, O_APPEND} = fs.constants;

	let fd = -1;
	let size = 0;
	let dropped = 0;
	let needNewline = false;
	let closed = false;

	const openFile = (): number => {
		let dirStat: fs.Stats | undefined;
		try {
			dirStat = io.lstatSync(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
		if (!dirStat) {
			io.mkdirSync(dir, {recursive: true, mode: DIR_MODE});
		} else if (dirStat.isSymbolicLink()) {
			throw refuse('ELOOP', 'log directory is a symlink');
		} else if (!dirStat.isDirectory()) {
			throw refuse('ENOTDIR', 'log directory is not a directory');
		}

		const dirFd = io.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
		try {
			try {
				io.fchmodSync(dirFd, DIR_MODE);
			} catch {
			}
		} finally {
			io.closeSync(dirFd);
		}

		const newFd = io.openSync(file, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, FILE_MODE);
		try {
			const stat = io.fstatSync(newFd);
			if (!stat.isFile()) throw refuse('EISDIR', 'log file is not a regular file');
			try {
				io.fchmodSync(newFd, FILE_MODE);
			} catch {
			}
			size = stat.size;
		} catch (err) {
			try {
				io.closeSync(newFd);
			} catch {
			}
			throw err;
		}
		return newFd;
	};

	const rotate = (): void => {
		const current = io.fstatSync(fd);
		size = current.size;
		if (size < maxBytes) return;

		let sameFile = true;
		try {
			sameFile = io.lstatSync(file).ino === current.ino;
		} catch {
			sameFile = false;
		}

		if (sameFile) {
			try {
				const gen = (n: number) => path.join(dir, `${path.parse(file).name}.${n}${path.parse(file).ext}`);
				try {
					io.unlinkSync(gen(generations));
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
				}
				for (let n = generations - 1; n >= 1; n--) {
					try {
						io.renameSync(gen(n), gen(n + 1));
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
					}
				}
				io.renameSync(file, gen(1));
			} catch {
				try {
					io.ftruncateSync(fd, 0);
					size = 0;
				} catch {
				}
				return;
			}
		}

		const oldFd = fd;
		fd = openFile();
		try {
			io.closeSync(oldFd);
		} catch {
		}
	};

	const writeAll = (text: string): boolean => {
		const buf = Buffer.from(needNewline ? `\n${text}\n` : `${text}\n`);
		const written = io.writeSync(fd, buf);
		if (written < buf.length) {
			needNewline = true;
			size += written;
			return false;
		}
		needNewline = false;
		size += written;
		return true;
	};

	fd = openFile();
	if (size >= maxBytes) {
		try {
			rotate();
		} catch {
		}
	}

	return {
		file,
		write(line) {
			if (closed) return;
			try {
				if (dropped > 0) {
					const n = dropped;
					if (!writeAll(opts.dropNotice(n))) {
						dropped++;
						return;
					}
					dropped = 0;
				}
				if (!writeAll(line)) {
					dropped++;
					return;
				}
				rotate();
			} catch {
				dropped++;
			}
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				io.closeSync(fd);
			} catch {
			}
		},
	};
}
