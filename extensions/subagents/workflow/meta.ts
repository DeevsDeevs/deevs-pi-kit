export const MAX_SCRIPT_CHARS = 524_288;

const FIRST_STATEMENT = "`export const meta = { name, description, phases }` must be the FIRST statement in the script";
const PLAIN_JAVASCRIPT =
	"Workflow scripts must be plain JavaScript: drop TypeScript-only syntax such as type annotations, interfaces and generics, and check that every string is quoted and escaped correctly.";
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "", " ": "", " ": "" };

export interface WorkflowPhase {
	title: string;
	detail?: string;
	model?: string;
}

export interface WorkflowMeta {
	name: string;
	description: string;
	title?: string;
	whenToUse?: string;
	phases?: WorkflowPhase[];
}

export interface ParsedWorkflow {
	meta: WorkflowMeta;
	body: string;
	bodyLine: number;
}

type MetaValue = string | number | boolean | null | MetaValue[] | { [key: string]: MetaValue };

export function parseWorkflow(source: string): ParsedWorkflow {
	if (source.length > MAX_SCRIPT_CHARS) throw new Error(`Script exceeds ${MAX_SCRIPT_CHARS} bytes`);
	const reader = new MetaReader(source);
	reader.skip();
	const header = /export\s+const\s+meta\s*=\s*(?=\{)/y;
	header.lastIndex = reader.at;
	if (!header.test(source)) throw new Error(FIRST_STATEMENT);
	reader.at = header.lastIndex;
	const meta = validateMeta(reader.value());
	const body = source.slice(reader.at).replace(/^[;\s]*\n/, "").trimStart();
	try {
		new Function(`return ${wrapBody(body)};`);
	} catch (error) {
		throw parseError(error instanceof Error ? error.message : String(error));
	}
	return { meta, body, bodyLine: source.slice(0, source.length - body.length).split("\n").length };
}

export function wrapBody(body: string): string {
	return `(async () => {"use strict";\n${body}\n})`;
}

function parseError(detail: string): Error {
	return new Error(`Script parse error: ${detail}. ${PLAIN_JAVASCRIPT}`);
}

function notLiteral(detail: string): Error {
	return new Error(`meta must be a pure literal: ${detail}`);
}

function validateMeta(value: MetaValue): WorkflowMeta {
	const record = isRecord(value) ? value : {};
	const { name, description, title, whenToUse, phases } = record;
	if (typeof name !== "string" || name.length === 0) throw new Error("meta.name must be a non-empty string");
	if (typeof description !== "string" || description.length === 0) throw new Error("meta.description must be a non-empty string");
	const validPhases = Array.isArray(phases)
		? phases.filter(isRecord).flatMap((phase) => typeof phase.title === "string"
			? [{ title: phase.title, detail: optionalString(phase.detail), model: optionalString(phase.model) }]
			: [])
		: [];
	return {
		name,
		description,
		title: typeof title === "string" && title.length > 0 ? title : undefined,
		whenToUse: optionalString(whenToUse),
		phases: validPhases.length > 0 ? validPhases : undefined,
	};
}

function isRecord(value: MetaValue | undefined): value is { [key: string]: MetaValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: MetaValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

class MetaReader {
	at = 0;

	constructor(private readonly source: string) {}

	skip(): void {
		const blank = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
		blank.lastIndex = this.at;
		blank.test(this.source);
		this.at = blank.lastIndex;
		if (this.source.startsWith("/*", this.at)) throw parseError("unterminated comment");
	}

	value(): MetaValue {
		this.skip();
		const char = this.source[this.at];
		if (char === "{") return this.object();
		if (char === "[") return this.array();
		if (char === '"' || char === "'" || char === "`") return this.string(char);
		if (char === "-") {
			this.at++;
			this.skip();
			const number = this.number();
			if (number === undefined) throw notLiteral("only negative-number unary allowed in meta");
			return -number;
		}
		if (char === "+" || char === "!" || char === "~") throw notLiteral("only negative-number unary allowed in meta");
		const number = this.number();
		if (number !== undefined) return number;
		const word = this.word();
		if (word === undefined) throw parseError(char === undefined ? "unexpected end of meta" : `unexpected token '${char}' in meta`);
		if (word === "true") return true;
		if (word === "false") return false;
		if (word === "null") return null;
		this.skip();
		const next = this.source[this.at];
		const node = word === "function" ? "FunctionExpression" : word === "new" ? "NewExpression" : next === "(" ? "CallExpression" : next === "." || next === "[" ? "MemberExpression" : "Identifier";
		throw notLiteral(`non-literal node type in meta: ${node}`);
	}

	private object(): { [key: string]: MetaValue } {
		const result: { [key: string]: MetaValue } = {};
		this.at++;
		for (;;) {
			this.skip();
			const char = this.source[this.at];
			if (char === "}") {
				this.at++;
				return result;
			}
			if (char === "[") throw notLiteral("computed keys not allowed in meta");
			if (this.source.startsWith("...", this.at)) throw notLiteral("only plain properties allowed in meta");
			if (char === "*") throw notLiteral("methods/accessors not allowed in meta");
			const key = char === '"' || char === "'" ? this.string(char) : this.word() ?? this.number()?.toString();
			if (key === undefined) throw parseError(char === undefined ? "unexpected end of meta" : `unexpected token '${char}' in meta`);
			this.skip();
			const next = this.source[this.at];
			if (next === "(" || ((key === "get" || key === "set" || key === "async") && next !== ":" && next !== "," && next !== "}")) {
				throw notLiteral("methods/accessors not allowed in meta");
			}
			if (next !== ":") throw notLiteral("non-literal node type in meta: Identifier");
			if (RESERVED_KEYS.has(key)) throw notLiteral(`reserved key name not allowed in meta: ${key}`);
			this.at++;
			result[key] = this.value();
			if (!this.separator("}")) return result;
		}
	}

	private array(): MetaValue[] {
		const result: MetaValue[] = [];
		this.at++;
		for (;;) {
			this.skip();
			const char = this.source[this.at];
			if (char === "]") {
				this.at++;
				return result;
			}
			if (char === ",") throw notLiteral("sparse arrays not allowed");
			if (this.source.startsWith("...", this.at)) throw notLiteral("spread not allowed in meta");
			result.push(this.value());
			if (!this.separator("]")) return result;
		}
	}

	private separator(close: string): boolean {
		this.skip();
		const char = this.source[this.at];
		if (char === ",") {
			this.at++;
			return true;
		}
		if (char === close) {
			this.at++;
			return false;
		}
		if (char === undefined) throw parseError("unexpected end of meta");
		throw notLiteral("non-literal expression in meta");
	}

	private string(quote: string): string {
		let result = "";
		this.at++;
		for (;;) {
			const char = this.source[this.at];
			if (char === undefined || (char === "\n" && quote !== "`")) throw parseError("unterminated string in meta");
			if (char === quote) {
				this.at++;
				return result;
			}
			if (quote === "`" && char === "$" && this.source[this.at + 1] === "{") throw notLiteral("template interpolation not allowed in meta");
			if (char !== "\\") {
				result += char;
				this.at++;
				continue;
			}
			const code = /x([\da-fA-F]{2})|u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|\r\n?/y;
			code.lastIndex = this.at + 1;
			const match = code.exec(this.source);
			if (match) {
				const hex = match[1] ?? match[2] ?? match[3];
				result += hex === undefined ? "" : String.fromCodePoint(Number.parseInt(hex, 16));
				this.at = code.lastIndex;
				continue;
			}
			const escaped = this.source[this.at + 1] ?? "";
			result += ESCAPES[escaped] ?? escaped;
			this.at += 2;
		}
	}

	private number(): number | undefined {
		const pattern = /0[xX][\da-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
		pattern.lastIndex = this.at;
		const match = pattern.exec(this.source);
		if (!match) return undefined;
		this.at = pattern.lastIndex;
		return Number(match[0]);
	}

	private word(): string | undefined {
		const pattern = /[A-Za-z_$][\w$]*/y;
		pattern.lastIndex = this.at;
		const match = pattern.exec(this.source);
		if (!match) return undefined;
		this.at = pattern.lastIndex;
		return match[0];
	}
}
