// Opaque on purpose: host types must not depend on react.
export type UiElement = object;

export type FocusDirection = 'left' | 'right';

// Present when the host shows a view next to other input areas. A view reads input only
// while `isFocused()` is true and lays itself out in `columns()` cells.
export type ViewHost = {
	isFocused(): boolean;
	columns(): number;
	// Called after focus or width changes; returns an unsubscribe function.
	subscribe(listener: () => void): () => void;
	// Asks the host to move input to the neighbouring area. False when there is none.
	move(direction: FocusDirection): boolean;
	// Input the host consumes itself (e.g. the console toggle); a view must ignore it.
	isHostKey(input: string): boolean;
};

export type MountControl = {
	// Idempotent.
	close(): void;
	// Prints into the area the view belongs to; falls back to `ctx.print` when absent.
	print?: (text: string) => void;
	host?: ViewHost;
};

// `main` is the primary area (e.g. a chat), `panel` the console side panel.
export type MountTarget = 'main' | 'panel';

export type MountOptions = {
	target?: MountTarget;
};

export type CommandContext = {
	print: (text: string) => void;
	clear: () => void;
	exit: () => void;
	// `build` runs once, synchronously, and its element is shown in `options.target`
	// (default `main`). Resolves when `control.close()` is called or the app unmounts;
	// rejects if that area already shows a view, `build` throws, or the element throws while rendering.
	mount?: (build: (control: MountControl) => UiElement, options?: MountOptions) => Promise<void>;
	suspend?: <T>(fn: () => T | Promise<T>) => Promise<T>;
};

export type SettingOption = {
	value: string;
	label: string;
	description?: string;
};

// A choice setting. `get` returns the stored value (undefined when unset).
export type Setting = {
	key: string;
	label: string;
	description?: string;
	options: SettingOption[];
	get: () => string | undefined | Promise<string | undefined>;
	set: (value: string) => void | Promise<void>;
};

// One tab of the settings screen, contributed by a command.
export type SettingsTab = {
	title: string;
	settings: Setting[];
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
	// Run once with no arguments when the UI starts (e.g. to open the chat).
	autostart?: boolean;
	settings?: SettingsTab;
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
