export type UiElement = object;

export type FocusDirection = 'left' | 'right';

export type ViewHost = {
	isFocused(): boolean;
	columns(): number;
	rows?(): number;
	subscribe(listener: () => void): () => void;
	move(direction: FocusDirection): boolean;
	togglePanel?(): boolean;
	quit?(): void;
	setTitle?(title: string | undefined, detail?: string): void;
	isHostKey(input: string, key?: {escape?: boolean; ctrl?: boolean}): boolean;
};

export type PrintAction = {line: number; copy: string};

export type RenderedPrint = {text: string; actions?: PrintAction[]};

export type PrintOptions = {actions?: PrintAction[]; render?: (width: number) => string | RenderedPrint};

export type SpanTone = 'accent' | 'muted' | 'ok' | 'warn' | 'error';

export type StyledSpan = {text: string; tone?: SpanTone; bold?: boolean; decor?: boolean};

export type StyledCell = string | StyledSpan | readonly (string | StyledSpan)[];

export type StyledBlock =
	| {kind: 'line'; spans: readonly (string | StyledSpan)[]; decor?: boolean}
	| {kind: 'rule'}
	| {kind: 'table'; head?: readonly string[]; rows: readonly (readonly StyledCell[])[]; flex?: number}
	| {kind: 'text'; text: string; tone?: SpanTone};

export type MountControl = {
	close(): void;
	print?: (text: string, options?: PrintOptions) => void;
	host?: ViewHost;
	copyToClipboard?: (text: string) => boolean;
};

export type MountTarget = 'main' | 'panel';

export type MountOptions = {
	target?: MountTarget;
	activity?: boolean;
};

export type AgentPolicy = 'safe' | 'confirm' | 'deny';

export type CommandInfoSub = {
	name: string;
	aliases: string[];
	usage: string;
	description: string;
	policy: AgentPolicy;
	subcommands?: CommandInfoSub[];
};

export type CommandInfo = {
	name: string;
	description: string;
	usage?: string;
	policy: AgentPolicy;
	subcommands: CommandInfoSub[];
};

export type CommandConfirmRequest = {line: string; command: string; subcommand?: string; caller: string};

export type CommandRunRequest = {
	line: string;
	caller: string;
	confirm?: (req: CommandConfirmRequest) => Promise<boolean>;
	signal?: AbortSignal;
	timeoutMs?: number;
};

export type CommandRunStatus = 'ok' | 'error' | 'invalid' | 'unknown' | 'denied' | 'declined' | 'off' | 'busy' | 'timeout' | 'aborted';

export type CommandRunResult = {status: CommandRunStatus; output: string; truncated: boolean; ms: number; reason?: string};

export type CommandErrorKind = 'usage' | 'not-found' | 'not-isolated' | 'invalid' | 'failed';

export type CommandError = Error & {kind: CommandErrorKind};

export type CommandBridge = {
	list(): CommandInfo[];
	run(req: CommandRunRequest): Promise<CommandRunResult>;
};

export type CommandContext = {
	print: (text: string, options?: PrintOptions) => void;
	printStyled?: (blocks: readonly StyledBlock[]) => void;
	clear: () => void;
	exit: () => void;
	mount?: (build: (control: MountControl) => UiElement, options?: MountOptions) => Promise<void>;
	suspend?: <T>(fn: () => T | Promise<T>) => Promise<T>;
	copyToClipboard?: (text: string) => boolean;
	commandBridge?: CommandBridge;
	signal?: AbortSignal;
	headless?: boolean;
	showHelp?: (path?: string[]) => void;
	caller?: string;
};

export type SettingOption = {
	value: string;
	label: string;
	description?: string;
};

export type SettingInline = {row: string; label?: string; section?: string};

export type Setting = {
	key: string;
	label: string;
	description?: string;
	options: SettingOption[];
	inline?: SettingInline;
	get: () => string | undefined | Promise<string | undefined>;
	set: (value: string) => void | Promise<void>;
};

export type SettingAction = {
	key: string;
	label: string;
	description?: string;
	open: (control: MountControl) => UiElement;
};

export type SettingsTab = {
	title: string;
	settings: Setting[];
	actions?: SettingAction[];
};

export type ArgumentDoc = {
	name: string;
	description: string;
	optional?: boolean;
	repeatable?: boolean;
};

export type OptionDoc = {
	name: string;
	aliases?: string[];
	value?: string;
	description: string;
	repeatable?: boolean;
};

export type Subcommand = {
	name: string;
	aliases?: string[];
	usage: string;
	description: string;
	agent?: AgentPolicy;
	args?: ArgumentDoc[];
	options?: OptionDoc[];
	notes?: string[];
	subcommands?: Subcommand[];
};

export type Command = {
	name: string;
	description: string;
	usage?: string;
	args?: ArgumentDoc[];
	options?: OptionDoc[];
	notes?: string[];
	subcommands?: Subcommand[];
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
	redact?(text: string): string;
};

export type StartupAlert = {text: string; detail?: string};

export type BuildInfo = {
	version: string;
	modules: {name: string; version: string; credentials?: Record<string, CredentialAccess>}[];
	root?: {mode: 'image' | 'dev'; path: string; workCopy?: string};
};

export type ModuleExportRules = {deny: string[]};

export type ModuleLockInfo = {source: string; version: string; commit?: string; account?: string};

export type ModuleInfo = {
	name: string;
	version: string;
	origin: 'image' | 'overlay';
	export?: ModuleExportRules;
	lock?: ModuleLockInfo;
	host?: string;
	code: {carry: false} | {carry: true; reason: string};
};

export type ModuleDataFile = {path: string; mode: number; mtimeMs: number; data: Uint8Array};

export type ModuleDataLimits = {maxFiles: number; maxFileBytes: number; maxTotalBytes: number};

export type ModuleDataRead = {files: ModuleDataFile[]; skipped: number; notes: string[]; defaultDeny: boolean};

export type ModuleDataReplace = {name: string; files: readonly ModuleDataFile[]};

export type ModuleDataReplaced = {name: string; written: number; removed: number; kept: number; skipped: number; defaultDeny: boolean};

export type ModuleTarget = {
	name: string;
	version: string;
	source?: string;
	commit?: string;
	account?: string;
	host?: string;
	code?: readonly ModuleDataFile[];
};

export type ImportAction = 'install' | 'update' | 'downgrade' | 'unchanged';

export type ImportStep = {
	name: string;
	action: ImportAction;
	from?: string;
	to: string;
	fromCommit?: string;
	toCommit?: string;
	source?: string;
	fromFile?: boolean;
};

export type ImportPlan = {hostVersion: string; steps: ImportStep[]; untouched: string[]; problems: string[]};

export type ImportRequest = {targets: readonly ModuleTarget[]; data: readonly ModuleDataReplace[]; backupDir: string};

export type ImportResult = {plan: ImportPlan; replaced: ModuleDataReplaced[]};

export type ModuleRegistry = {
	list(): Promise<ModuleInfo[]>;
	readData(name: string, limits: ModuleDataLimits): Promise<ModuleDataRead>;
	readCode(name: string, limits: ModuleDataLimits): Promise<ModuleDataRead>;
	planImport(targets: readonly ModuleTarget[]): Promise<ImportPlan>;
	applyImport(request: ImportRequest, log: (line: string) => void): Promise<ImportResult>;
};

export type Yena = {
	commands: Command[];
	dataDir: string;
	events: EventBus;
	log: Logger;
	alerts?: StartupAlert[];
	modules?: ModuleRegistry;
	build?: BuildInfo;
};

export type GitSshResolver = (account: string) => Promise<string>;

export type DevFailure = {
	at: string;
	devRoot: string;
	name: string;
	message: string;
	stack?: string;
};

export type CredentialAccess = 'read' | 'write';

export type CredentialAccount = {
	name: string;
	kind: string;
	fields: Record<string, string>;
	secrets: string[];
	disabled: boolean;
	missing: string[];
};

export type CredentialGrant = {kind: string; declared: CredentialAccess; granted?: CredentialAccess};

export type CredentialCaller = {module: string; declared: Readonly<Record<string, CredentialAccess>>};

export type CredentialCreateInput = {name: string; kind: string; fields?: Record<string, string>};

export type Credentials = {
	available(): boolean;
	grants(): Promise<CredentialGrant[]>;
	list(kind?: string): Promise<CredentialAccount[]>;
	read(account: string, field: string): Promise<string | undefined>;
	write(account: string, field: string, value: string | undefined): Promise<void>;
	create(input: CredentialCreateInput): Promise<CredentialAccount>;
	remove(account: string): Promise<void>;
};

export type CredentialProvider = {
	grants(caller: CredentialCaller): Promise<CredentialGrant[]>;
	list(kind: string | undefined, caller: CredentialCaller): Promise<CredentialAccount[]>;
	read(account: string, field: string, caller: CredentialCaller): Promise<string | undefined>;
	write(account: string, field: string, value: string | undefined, caller: CredentialCaller): Promise<void>;
	create(input: CredentialCreateInput, caller: CredentialCaller): Promise<CredentialAccount>;
	remove(account: string, caller: CredentialCaller): Promise<void>;
};

export type PluginHost = {
	dataDir: string;
	events: EventBus;
	log: Logger;
	build?: BuildInfo;
	devFailure?: () => Promise<DevFailure | undefined>;
	registerGitSsh?: (resolve: GitSshResolver) => void;
	credentials?: Credentials;
	registerCredentialProvider?: (provider: CredentialProvider) => void;
};

export type ModulePlugin = (host: PluginHost) => Command[] | Promise<Command[]>;

export type ModuleMain = (yena: Yena) => void | Promise<void>;

export type HeadlessRequest = {args: string[]; catalog?: boolean};

export type HeadlessMain = (yena: Yena, request: HeadlessRequest) => Promise<void>;
