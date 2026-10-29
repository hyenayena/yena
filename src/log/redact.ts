const REDACTED = '[redacted]';
const MAX_REDACTORS = 64;

const BUILTINS: ReadonlyArray<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
	[/-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g, REDACTED],
	[/sk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
	[/sk-[A-Za-z0-9]{20,}/g, REDACTED],
	[/gh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
	[/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
	[/AKIA[0-9A-Z]{16}/g, REDACTED],
	[/eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{1,512}/gi, `$1 ${REDACTED}`],
	[
		/((?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[A-Za-z0-9_-]{0,20})(["']?\s*[=:]\s*["']?)([^\r\n]{1,1024})/gi,
		(match, key, sep, value) => (/tokens$/i.test(key) && /^\d/.test(value) ? match : `${key}${sep}${REDACTED}`),
	],
	[
		/\b([a-z][a-z0-9+.-]{0,20}:\/\/)([^\s/@?#]{1,256})@/gi,
		(match, scheme, userinfo) => (userinfo === 'git' ? match : `${scheme}${REDACTED}@`),
	],
];

export type Redactor = {
	add(redact: (text: string) => string): void;
	apply(text: string): string;
};

export function createRedactor(): Redactor {
	const registered: Array<(text: string) => string> = [];
	return {
		add(redact) {
			if (typeof redact !== 'function' || registered.includes(redact)) return;
			registered.push(redact);
			if (registered.length > MAX_REDACTORS) registered.shift();
		},
		apply(text) {
			let out = text;
			for (const redact of registered) {
				try {
					const next = redact(out);
					if (typeof next !== 'string') return '[unredactable]';
					out = next;
				} catch {
					return '[unredactable]';
				}
			}
			for (const [pattern, replacement] of BUILTINS) {
				out = out.replace(pattern, replacement as string);
			}
			return out;
		},
	};
}
