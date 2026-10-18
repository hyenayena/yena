// Opaque on purpose: host types must not depend on react.
export type UiElement = object;

export type MountControl = {
	// Idempotent.
	close(): void;
};

export type CommandContext = {
	print: (text: string) => void;
	clear: () => void;
	exit: () => void;
	// `build` runs once, synchronously, and its element replaces the prompt. Resolves when
	// `control.close()` is called or the app unmounts; rejects if another view is mounted,
	// `build` throws, or the element throws while rendering.
	mount?: (build: (control: MountControl) => UiElement) => Promise<void>;
	suspend?: <T>(fn: () => T | Promise<T>) => Promise<T>;
};

export type Subcommand = {
	name: string;
	aliases?: string[];
	usage: string;
	description: string;
};

export type Command = {
	name: string;
	description: string;
	usage?: string;
	subcommands?: Subcommand[];
	run: (args: string[], ctx: CommandContext) => void | Promise<void>;
};

export type EventBus = {
	emit(topic: string, payload: unknown): void;
	on(topic: string, handler: (payload: unknown) => void): () => void;
};

export type LogFields = Record<string, unknown>;

export type Logger = {
	error(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	debug(message: string, fields?: LogFields): void;
	child(scope: string): Logger;
	addRedactor(redact: (text: string) => string): void;
};

export type Yena = {
	commands: Command[];
	dataDir: string;
	events: EventBus;
	log: Logger;
};

export type PluginHost = {
	dataDir: string;
	events: EventBus;
	log: Logger;
};

export type ModulePlugin = (host: PluginHost) => Command[] | Promise<Command[]>;

export type ModuleMain = (yena: Yena) => void | Promise<void>;
