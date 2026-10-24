// Opaque on purpose: host types must not depend on react.
export type UiElement = object;

export type FocusDirection = 'left' | 'right';

// Present when the host shows a view next to other input areas. A view reads input only
// while `isFocused()` is true and lays itself out in `columns()` cells.
export type ViewHost = {
	isFocused(): boolean;
	columns(): number;
	// Rows the view may use; absent on older hosts.
	rows?(): number;
	// Called after focus or width changes; returns an unsubscribe function.
	subscribe(listener: () => void): () => void;
	// Asks the host to move input to the neighbouring area. False when there is none.
	move(direction: FocusDirection): boolean;
	// Opens or closes the host's side panel (the console). False when there is none.
	togglePanel?(): boolean;
	// Exits the whole application (e.g. on the vim-style ":q").
	quit?(): void;
	// Shows a bar above the view: the title (e.g. the chat's name) on the left and an optional
	// detail (e.g. model and mode) on the right. An undefined title removes the bar.
	setTitle?(title: string | undefined, detail?: string): void;
	// Input the host consumes itself (e.g. the console toggle, Ctrl+T); a view must ignore it.
	// Pass the key flags: host keys are usually modified keys rather than characters.
	isHostKey(input: string, key?: {escape?: boolean; ctrl?: boolean}): boolean;
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
	// Panel only; no focus change; opens the console; closed by its owner; agent runs always use it.
	activity?: boolean;
};

// How an AI assistant may run a command: freely, after the user confirms, or never. Undeclared = 'confirm'.
export type AgentPolicy = 'safe' | 'confirm' | 'deny';

export type CommandInfo = {
	name: string;
	description: string;
	usage?: string;
	policy: AgentPolicy;
	subcommands: {name: string; aliases: string[]; usage: string; description: string; policy: AgentPolicy}[];
};

export type CommandConfirmRequest = {line: string; command: string; subcommand?: string; caller: string};

export type CommandRunRequest = {
	line: string;
	// Short module id, e.g. 'claude'.
	caller: string;
	confirm?: (req: CommandConfirmRequest) => Promise<boolean>;
	signal?: AbortSignal;
	timeoutMs?: number;
};

export type CommandRunStatus = 'ok' | 'error' | 'invalid' | 'unknown' | 'denied' | 'declined' | 'off' | 'busy' | 'timeout' | 'aborted';

export type CommandRunResult = {status: CommandRunStatus; output: string; truncated: boolean; ms: number; reason?: string};

export type CommandBridge = {
	list(): CommandInfo[];
	run(req: CommandRunRequest): Promise<CommandRunResult>;
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
	// Puts text on the terminal's clipboard (OSC 52). False when it is too long or not possible.
	copyToClipboard?: (text: string) => boolean;
	commandBridge?: CommandBridge;
	// Aborted on agent-run timeout or abort; commands may honour it.
	signal?: AbortSignal;
	// True in a one-shot terminal run (`--run`): commands must not start background work.
	headless?: boolean;
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
	agent?: AgentPolicy;
};

export type Command = {
	name: string;
	description: string;
	usage?: string;
	subcommands?: Subcommand[];
	// Run once with no arguments when the UI starts (e.g. to open the chat).
	autostart?: boolean;
	agent?: AgentPolicy;
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

// `catalog` prints the command list for shell completion instead of running `args`.
export type HeadlessRequest = {args: string[]; catalog?: boolean};

// Runs one console line without the UI. Throws `Error` on failure; `exitCode === 2` means an unknown command or invalid line.
export type HeadlessMain = (yena: Yena, request: HeadlessRequest) => Promise<void>;
