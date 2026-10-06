import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentDir, kitValues, type KitValue } from "./config.ts";

const DETACH_EXECUTABLES = new Set(["disown", "nohup", "setsid", "coproc"]);
const SHELL_EXECUTABLES = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh", "csh", "tcsh", "ash", "mksh", "rbash"]);
const TEST_COMMANDS = new Set(["[", "[[", "]", "]]"]);
const POSITIONAL_PARAMETER = /^\$(?:[@*1-9]|\{(?:[@*]|[1-9]\d*)\})$/;
const ENV_VALUE_OPTIONS = new Set(["-a", "--argv0", "-C", "--chdir", "-u", "--unset"]);
const SUDO_VALUE_OPTIONS = new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-u", "--chdir", "--close-from", "--group", "--host", "--prompt", "--role", "--type", "--user"]);
const COMMAND_PREFIXES = new Set(["!", "builtin", "do", "elif", "else", "if", "then", "until", "while"]);
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const DETACH_ERROR = "Detached process launch or dynamically-computed command detected (backgrounding, nohup/setsid/disown, or a command name that cannot be statically verified). Use a literal command, or Herdr for persistent or independently owned processes.";
const FORCE_PUSH_ERROR = "Force push to a protected branch (main, master, release/*) or to an unnamed branch, or deleting a protected branch, is blocked. Name a non-protected target branch explicitly, e.g. `git push --force-with-lease origin feature/x`.";
const RM_ERROR = "Recursive rm outside the project and the temp directories ($TMPDIR, /tmp) is blocked. Use literal paths inside the project or a temp directory.";

const HookPayload = Type.Object({
	cwd: Type.Optional(Type.String()),
	tool_input: Type.Optional(Type.Object({ command: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])) })),
});

export type GuardConfig = KitValue<"guard">;

export interface GuardOptions {
	cwd: string;
	/** The project rm may clean inside: the lead's cwd, never a cwd the model chose. Defaults to `cwd`. */
	root?: string;
	config?: GuardConfig;
	home?: string;
	tmpDir?: string;
}

interface Guard {
	detached: boolean;
	forcePush: boolean;
	rmRf: boolean;
	block: string[][];
	/** The project rm may clean inside; `cwd` follows literal `cd`s and is undefined after a dynamic one. */
	root: string;
	cwd: string | undefined;
	home: string;
	tmpDirs: string[];
	functions: Set<string>;
	/** The segment being checked is inside a local function's body, where `"$@"` and `$1` are its call sites' arguments. */
	inFunction: boolean;
}

interface ShellToken {
	value: string;
	operator: boolean;
}

interface Heredoc {
	body: string;
	quoted: boolean;
	/** The body is a script: a shell executable appears on the line that opens it (`bash <<EOF`, `cat <<EOF | sh`). */
	script: boolean;
}

interface ShellScan {
	tokens: ShellToken[];
	substitutions: ShellScan[];
	heredocs: Heredoc[];
	unbalanced: boolean;
	end: number;
}

type ScanMode = "line" | "substitution" | "heredoc";

export function guardShell(command: string, options: GuardOptions = { cwd: process.cwd() }): string | undefined {
	return checkShell(command, guard(options));
}

export function guardArgv(argv: string[], options: GuardOptions = { cwd: process.cwd() }): string | undefined {
	return checkArgv(argv, guard(options), false);
}

/** A Pi `tool_call` result for a bash command run in `cwd`, under the rules configured for the project at `root`. */
export function guardBashCall(command: string, cwd: string, root = cwd): { block: true; reason: string } | undefined {
	const reason = guardShell(command, { cwd, root, config: loadGuardConfig(root) });
	return reason ? { block: true, reason } : undefined;
}

/** The shell command of a Claude Code or Codex PreToolUse payload, under the rules configured for its cwd. */
export function guardHookPayload(payload: string): string | undefined {
	const input: unknown = JSON.parse(payload);
	if (!Value.Check(HookPayload, input) || input.tool_input?.command === undefined) return undefined;
	const command = input.tool_input.command;
	const cwd = input.cwd || process.cwd();
	const options = { cwd, config: loadGuardConfig(cwd) };
	return Array.isArray(command) ? guardArgv(command, options) : guardShell(command, options);
}

/** `guard` from pi-kit.json, read on every call. Only the global file switches rules off; a project, trusted or not, can only add `block` patterns. */
export function loadGuardConfig(cwd: string, dir = agentDir()): GuardConfig {
	const [global = {}, project = {}] = kitValues("guard", cwd, dir);
	return { ...global, block: [...global.block ?? [], ...project.block ?? []] };
}

function guard({ cwd, root = cwd, config = {}, home = homedir(), tmpDir = tmpdir() }: GuardOptions): Guard {
	return {
		detached: config.detached !== false,
		forcePush: config.forcePush !== false,
		rmRf: config.rmRf !== false,
		block: (config.block ?? []).map((pattern) => pattern.trim().split(/\s+/)).filter((words) => words[0]),
		root: resolve(root),
		cwd: resolve(cwd),
		home,
		tmpDirs: [tmpDir, "/tmp"],
		functions: new Set(),
		inFunction: false,
	};
}

function detach(ctx: Guard): string | undefined {
	return ctx.detached ? DETACH_ERROR : undefined;
}

function checkShell(source: string, ctx: Guard): string | undefined {
	const scan = shellTokens(source);
	return checkNested(scan, ctx) ?? checkSegments(scan.tokens, ctx);
}

function checkNested(scan: ShellScan, ctx: Guard): string | undefined {
	// Fail closed on an unterminated quote or substitution: a real shell reads the rest as one string, which hides any trailing `&`/nohup from static analysis.
	if (scan.unbalanced) return detach(ctx);
	for (const inner of scan.substitutions) {
		const cwd = ctx.cwd;
		const reason = checkNested(inner, ctx) ?? checkSegments(inner.tokens, ctx);
		ctx.cwd = cwd;
		if (reason) return reason;
	}
	for (const heredoc of scan.heredocs) {
		const reason = heredoc.script ? checkShell(heredoc.body, ctx) : heredoc.quoted ? undefined : checkNested(shellTokens(heredoc.body, 0, "heredoc"), ctx);
		if (reason) return reason;
	}
	return undefined;
}

function checkSegments(tokens: ShellToken[], ctx: Guard): string | undefined {
	collectFunctions(tokens, ctx.functions);
	let segment: string[] = [];
	let depth = 0;
	let header = false;
	const bodies: number[] = [];
	const check = () => {
		ctx.inFunction = bodies.length > 0;
		return checkSegment(segment, ctx);
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (!token.operator) {
			segment.push(token.value);
			continue;
		}
		// `name ()` and `function name` open a header; the `{` or `(` after it opens the function's body.
		if (token.value === "(" && tokens[index + 1]?.operator && tokens[index + 1]?.value === ")") {
			header = true;
			segment = [];
			index++;
			continue;
		}
		if ((token.value === "{" || token.value === "(") && segment[0] === "function") header = true;
		const reason = check();
		if (reason) return reason;
		segment = [];
		if (token.value === "&") return detach(ctx);
		if (token.value === "{" || token.value === "(") {
			if (header) bodies.push(depth);
			header = false;
			depth++;
		} else if (token.value === "}" || token.value === ")") {
			depth--;
			if (bodies.at(-1) === depth) bodies.pop();
		}
	}
	return check();
}

function collectFunctions(tokens: ShellToken[], functions: Set<string>): void {
	tokens.forEach((token, index) => {
		const next = tokens[index + 1];
		if (token.operator || !next) return;
		if (token.value === "function" && !next.operator) functions.add(next.value);
		if (next.operator && next.value === "(" && tokens[index + 2]?.operator && tokens[index + 2]?.value === ")") functions.add(token.value);
	});
}

function checkSegment(words: string[], ctx: Guard): string | undefined {
	let index = 0;
	while (isAssignment(words[index])) index++;
	const argv = words.slice(index);
	if (!argv.length) return undefined;
	const executable = executableName(argv[0]!);
	if (COMMAND_PREFIXES.has(executable)) return checkSegment(argv.slice(1), ctx);
	if (executable === "exec") return checkSegment(execCommand(argv.slice(1)), ctx);
	if (executable === "eval") return checkShell(argv.slice(1).join(" "), ctx);
	if (executable === "cd" || executable === "pushd") {
		ctx.cwd = cdTarget(argv.slice(1), ctx);
		return undefined;
	}
	// A local function may run its arguments as a command (`run() { "$@"; }; run nohup x`).
	if (ctx.functions.has(argv[0]!) && argv.some((word) => DETACH_EXECUTABLES.has(executableName(word)))) return detach(ctx);
	return checkArgv(argv, ctx, true);
}

function checkArgv(argv: string[], ctx: Guard, rejectDynamicExecutable: boolean): string | undefined {
	if (!argv.length) return undefined;
	if (rejectDynamicExecutable && isDynamicExecutable(argv[0]!, ctx.inFunction)) return detach(ctx);
	const executable = executableName(argv[0]!);
	const pattern = ctx.block.find((words) => matchesPattern(executable, argv, words));
	if (pattern) return `Blocked by the guard.block pattern "${pattern.join(" ")}".`;
	if (DETACH_EXECUTABLES.has(executable)) return detach(ctx) ?? checkArgv(argv.slice(1), ctx, rejectDynamicExecutable);
	if (executable === "git" && ctx.forcePush && forcePushesProtected(argv.slice(1))) return FORCE_PUSH_ERROR;
	if (executable === "rm" && ctx.rmRf && removesOutside(argv.slice(1), ctx)) return RM_ERROR;
	if (SHELL_EXECUTABLES.has(executable)) {
		const command = shellCommand(argv.slice(1));
		return command ? checkShell(command, ctx) : undefined;
	}
	if (executable === "env") return checkEnvArgv(argv.slice(1), ctx, 0, rejectDynamicExecutable);
	if (executable === "time") return checkTimeArgv(argv.slice(1), ctx, rejectDynamicExecutable);
	if (executable === "nice") return checkNiceArgv(argv.slice(1), ctx, rejectDynamicExecutable);
	if (executable === "timeout") return checkTimeoutArgv(argv.slice(1), ctx, rejectDynamicExecutable);
	if (executable === "stdbuf") return checkStdbufArgv(argv.slice(1), ctx, rejectDynamicExecutable);
	if (executable === "sudo") return checkSudoArgv(argv.slice(1), ctx, rejectDynamicExecutable);
	if (executable === "command") return checkCommandArgv(argv.slice(1), ctx, rejectDynamicExecutable);
	return undefined;
}

/** A pattern's first word names the executable; the rest must appear in order among its arguments. */
function matchesPattern(executable: string, argv: string[], pattern: string[]): boolean {
	if (executable !== executableName(pattern[0]!)) return false;
	let matched = 1;
	for (const word of argv.slice(1)) if (word === pattern[matched]) matched++;
	return matched >= pattern.length;
}

function forcePushesProtected(args: string[]): boolean {
	let index = 0;
	while (args[index]?.startsWith("-")) index += GIT_VALUE_OPTIONS.has(args[index]!) ? 2 : 1;
	if (args[index] !== "push") return false;
	let force = false;
	const operands: string[] = [];
	for (let next = index + 1; next < args.length; next++) {
		const word = args[next]!;
		if (word === "--") { operands.push(...args.slice(next + 1)); break; }
		if (PUSH_VALUE_OPTIONS.has(word)) next++;
		else if (word === "--force" || word === "--mirror" || word === "--delete" || word.startsWith("--force-with-lease") || /^-[^-]*[fd]/.test(word)) force = true;
		else if (!word.startsWith("-")) operands.push(word);
	}
	const refspecs = operands.slice(1);
	// `+src:dst` forces one ref and `:dst` deletes it.
	if (refspecs.some((refspec) => /^\+|^:./.test(refspec) && protectedTarget(refspec))) return true;
	return force && (refspecs.length === 0 || refspecs.some(protectedTarget));
}

/** The destination of a refspec is protected, or cannot be named statically (HEAD, a glob, the current branch). */
function protectedTarget(refspec: string): boolean {
	const target = refspec.replace(/^\+/, "").split(":").at(-1)!.replace(/^refs\/heads\//, "");
	return ["main", "master", "HEAD", "@", ""].includes(target) || target.startsWith("release/") || target.includes("*");
}

function removesOutside(args: string[], ctx: Guard): boolean {
	let recursive = false;
	let options = true;
	const targets: string[] = [];
	for (const word of args) {
		if (options && word === "--") options = false;
		else if (options && /^-[^-]/.test(word)) recursive ||= /[rR]/.test(word);
		else if (options && word.startsWith("--")) recursive ||= word === "--recursive";
		else targets.push(word);
	}
	return recursive && targets.some((target) => !insideAllowedRoot(literalPath(target, ctx), ctx));
}

function insideAllowedRoot(path: string | undefined, ctx: Guard): boolean {
	return path !== undefined && [ctx.root, ...ctx.tmpDirs].some((root) => {
		const rel = relative(root, path);
		return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
	});
}

/** The path a word names, expanding only `~`, $HOME, $TMPDIR and $PWD; undefined when it depends on anything else. */
function literalPath(word: string, ctx: Guard): string | undefined {
	const expanded = word
		.replace(/^~(?=\/|$)/, ctx.home)
		.replace(/\$(?:\{(HOME|TMPDIR|PWD)\}|(HOME|TMPDIR|PWD)(?!\w))/g, (_match, braced: string | undefined, bare: string | undefined) => {
			const name = braced ?? bare;
			return name === "HOME" ? ctx.home : name === "TMPDIR" ? ctx.tmpDirs[0]! : ctx.cwd ?? "$";
		});
	if (expanded.startsWith("~") || /[$`]/.test(expanded)) return undefined;
	if (isAbsolute(expanded)) return resolve(expanded);
	return ctx.cwd === undefined ? undefined : resolve(ctx.cwd, expanded);
}

function cdTarget(args: string[], ctx: Guard): string | undefined {
	const target = args.find((arg) => arg === "-" || !arg.startsWith("-"));
	if (target === undefined) return ctx.home;
	return target === "-" ? undefined : literalPath(target, ctx);
}

function execCommand(argv: string[]): string[] {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") return argv.slice(index + 1);
		if (value === "-a") { index += 2; continue; }
		if (value.startsWith("-")) { index++; continue; }
		break;
	}
	return argv.slice(index);
}

function checkEnvArgv(argv: string[], ctx: Guard, splitDepth = 0, rejectDynamicExecutable = false): string | undefined {
	if (splitDepth > 8) return detach(ctx);
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-S" || value === "--split-string") return checkEnvSplit(argv[index + 1] ?? "", argv.slice(index + 2), ctx, splitDepth, rejectDynamicExecutable);
		if (value.startsWith("-S") && value.length > 2) return checkEnvSplit(value.slice(2), argv.slice(index + 1), ctx, splitDepth, rejectDynamicExecutable);
		if (value.startsWith("--split-string=")) return checkEnvSplit(value.slice("--split-string=".length), argv.slice(index + 1), ctx, splitDepth, rejectDynamicExecutable);
		if (ENV_VALUE_OPTIONS.has(value)) { index += 2; continue; }
		if (value.startsWith("-") || isAssignment(value)) { index++; continue; }
		break;
	}
	return checkArgv(argv.slice(index), ctx, rejectDynamicExecutable);
}

function checkEnvSplit(source: string, trailing: string[], ctx: Guard, splitDepth: number, rejectDynamicExecutable: boolean): string | undefined {
	const words = splitEnvString(source);
	return words ? checkEnvArgv([...words, ...trailing], ctx, splitDepth + 1, rejectDynamicExecutable) : detach(ctx);
}

function splitEnvString(source: string): string[] | undefined {
	const result: string[] = [];
	let word = "";
	let quote: "'" | "\"" | undefined;
	const flush = () => { if (word) { result.push(word); word = ""; } };
	for (let index = 0; index < source.length; index++) {
		const char = source[index]!;
		if (char === "\\" && quote !== "'") {
			const escaped = source[++index];
			if (escaped === undefined) return undefined;
			if (escaped === "c") break;
			if (escaped === "_") { if (quote) word += " "; else flush(); continue; }
			if ("fnrtv".includes(escaped)) { if (quote) word += " "; else flush(); continue; }
			word += escaped;
			continue;
		}
		if (char === "$" && quote !== "'") return undefined;
		if ((char === "'" || char === "\"") && (!quote || quote === char)) { quote = quote ? undefined : char; continue; }
		if (!quote && /\s/.test(char)) { flush(); continue; }
		word += char;
	}
	if (quote) return undefined;
	flush();
	return result;
}

function checkTimeArgv(argv: string[], ctx: Guard, rejectDynamicExecutable = false): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-f" || value === "--format" || value === "-o" || value === "--output") { index += 2; continue; }
		if (value.startsWith("--format=") || value.startsWith("--output=") || /^-[fo].+/.test(value)) { index++; continue; }
		if (value.startsWith("-")) { index++; continue; }
		break;
	}
	return checkArgv(argv.slice(index), ctx, rejectDynamicExecutable);
}

function checkNiceArgv(argv: string[], ctx: Guard, rejectDynamicExecutable = false): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-n" || value === "--adjustment") { index += 2; continue; }
		if (value.startsWith("--adjustment=") || /^-\d+$/.test(value)) { index++; continue; }
		if (value.startsWith("-")) { index++; continue; }
		break;
	}
	return checkArgv(argv.slice(index), ctx, rejectDynamicExecutable);
}

function checkTimeoutArgv(argv: string[], ctx: Guard, rejectDynamicExecutable = false): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-k" || value === "--kill-after" || value === "-s" || value === "--signal") { index += 2; continue; }
		if (value.startsWith("--kill-after=") || value.startsWith("--signal=") || value.startsWith("-k") || value.startsWith("-s")) { index++; continue; }
		if (value.startsWith("-")) { index++; continue; }
		break;
	}
	if (index < argv.length) index++; // duration follows options, including after --
	return checkArgv(argv.slice(index), ctx, rejectDynamicExecutable);
}

function checkStdbufArgv(argv: string[], ctx: Guard, rejectDynamicExecutable = false): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-i" || value === "--input" || value === "-o" || value === "--output" || value === "-e" || value === "--error") { index += 2; continue; }
		if (/^-[ioe].+/.test(value) || value.startsWith("--input=") || value.startsWith("--output=") || value.startsWith("--error=")) { index++; continue; }
		if (value.startsWith("-")) { index++; continue; }
		break;
	}
	return checkArgv(argv.slice(index), ctx, rejectDynamicExecutable);
}

function checkSudoArgv(argv: string[], ctx: Guard, rejectDynamicExecutable = false): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if ((value === "-b" || value === "--background") && ctx.detached) return DETACH_ERROR;
		// `sudo -s`/`-i` run the remainder as a shell command line, not an argv.
		if (value === "-s" || value === "-i") return checkShell(argv.slice(index + 1).join(" "), ctx);
		if (SUDO_VALUE_OPTIONS.has(value)) { index += 2; continue; }
		if (value.startsWith("-") || isAssignment(value)) { index++; continue; }
		break;
	}
	while (isAssignment(argv[index])) index++;
	return checkArgv(argv.slice(index), ctx, rejectDynamicExecutable);
}

function checkCommandArgv(argv: string[], ctx: Guard, rejectDynamicExecutable = false): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-v" || value === "-V" || (/^-[pVv]+$/.test(value) && /[Vv]/.test(value))) return undefined;
		if (value === "-p") { index++; continue; }
		break;
	}
	return checkArgv(argv.slice(index), ctx, rejectDynamicExecutable);
}

function isDynamicExecutable(value: string, inFunction: boolean): boolean {
	// `[` / `[[` are the test builtins, not glob/dynamic executables; exempt them so ordinary guard clauses like `[ -f x ] && ...` are not blocked.
	// Inside a function body its own arguments (`"$@"`, `$1`) are checked at its call sites instead; anywhere else they could be anything.
	if (TEST_COMMANDS.has(value) || (inFunction && POSITIONAL_PARAMETER.test(value))) return false;
	return /[$`*?[\]{}]/.test(value);
}

function shellCommand(argv: string[]): string | undefined {
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index]!;
		if (value === "-c" || value === "--command") return argv[index + 1];
		if (value.startsWith("--command=")) return value.slice("--command=".length);
		if (/^-[^-]*c/.test(value)) return argv[index + 1];
	}
	return undefined;
}

function closingParen(source: string, open: number): number | undefined {
	let depth = 1;
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	for (let index = open + 1; index < source.length; index++) {
		const char = source[index]!;
		if (escaped) { escaped = false; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if (char === "'" && quote !== "\"") { quote = quote === "'" ? undefined : "'"; continue; }
		if (char === "\"" && quote !== "'") { quote = quote === "\"" ? undefined : "\""; continue; }
		if (quote) continue;
		if (char === "(") depth++;
		if (char === ")" && --depth === 0) return index;
	}
	return undefined;
}

function backtickEnd(source: string, open: number): number | undefined {
	for (let index = open + 1; index < source.length; index++) {
		if (source[index] === "\\") index++;
		else if (source[index] === "`") return index;
	}
	return undefined;
}

/**
 * Splits a command line into words and operators. Command substitutions stay inside their word and are scanned recursively,
 * heredoc bodies are cut out at the end of their line, and a `substitution` scan stops at its closing paren.
 * A `heredoc` scan reads an unquoted heredoc body: everything is literal except escapes and substitutions.
 */
function shellTokens(source: string, start = 0, mode: ScanMode = "line"): ShellScan {
	const scan: ShellScan = { tokens: [], substitutions: [], heredocs: [], unbalanced: false, end: source.length };
	const pending: { delimiter: string; quoted: boolean; strip: boolean }[] = [];
	let lineStart = 0;
	let word = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	let depth = 0;
	const flush = () => {
		if (!word) return;
		scan.tokens.push({ value: word, operator: false });
		word = "";
	};
	for (let index = start; index < source.length; index++) {
		const char = source[index]!;
		if (escaped) { if (char !== "\n") word += char; escaped = false; continue; }
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
			continue;
		}
		if (char === "\\") { escaped = true; continue; }
		if (char === "`") {
			const end = backtickEnd(source, index);
			if (end === undefined) return { ...scan, unbalanced: true };
			scan.substitutions.push(shellTokens(source.slice(index + 1, end)));
			word += source.slice(index, end + 1);
			index = end;
			continue;
		}
		if (char === "$" && source[index + 1] === "(") {
			// Arithmetic $((...)) is one opaque word: its `&` is bitwise-AND, not backgrounding.
			const arithmetic = source[index + 2] === "(" && closingParen(source, index + 2) !== undefined ? closingParen(source, index + 1) : undefined;
			const inner = arithmetic === undefined ? shellTokens(source, index + 2, "substitution") : undefined;
			if (inner?.unbalanced) return { ...scan, unbalanced: true };
			if (inner) scan.substitutions.push(inner);
			const end = arithmetic ?? inner!.end;
			word += source.slice(index, end + 1);
			index = end;
			continue;
		}
		if (mode === "heredoc") { word += char; continue; }
		if (quote) {
			if (char === quote) quote = undefined;
			else word += char;
			continue;
		}
		// A `#` at a word boundary starts a comment to end of line (bash rule); mid-word `#` is literal.
		if (char === "#" && word.length === 0) { while (index + 1 < source.length && source[index + 1] !== "\n") index++; continue; }
		if (source.startsWith("<<<", index)) { word += "<<<"; index += 2; continue; }
		if (source.startsWith("<<", index)) {
			const heredoc = heredocOperator(source, index + 2);
			if (heredoc) { flush(); pending.push(heredoc); index = heredoc.end - 1; continue; }
		}
		if (char === "'" || char === "\"") { quote = char; continue; }
		if (char === "\n") {
			flush();
			const script = scan.tokens.slice(lineStart).some((token) => !token.operator && SHELL_EXECUTABLES.has(executableName(token.value)));
			let next = index + 1;
			for (const heredoc of pending.splice(0)) {
				const body = heredocBody(source, next, heredoc.delimiter, heredoc.strip);
				scan.heredocs.push({ body: body.text, quoted: heredoc.quoted, script });
				next = body.end;
			}
			index = next - 1;
			scan.tokens.push({ value: "\n", operator: true });
			lineStart = scan.tokens.length;
			continue;
		}
		if (/\s/.test(char)) { flush(); continue; }
		// `&` continues the current word when it forms a redirection: `&>`, `>&`, `>&2`, `>&-` are not backgrounding.
		if (char === "&" && (source[index + 1] === ">" || word.endsWith(">"))) { word += char; continue; }
		// Contiguous `((...))` is an arithmetic command (or C-style for header), not a subshell; nothing inside can background a real process, so consume it opaquely and keep its `&`/`;` out of the operator stream.
		if (char === "(" && source[index + 1] === "(") {
			const end = closingParen(source, index);
			if (end !== undefined) { flush(); index = end; continue; }
		}
		if (char === ")" && mode === "substitution" && depth === 0) {
			flush();
			return { ...scan, end: index };
		}
		const structuralBrace = "{}".includes(char) && word.length === 0 && /(?:\s|;|$)/.test(source[index + 1] ?? "");
		if (";&|()".includes(char) || structuralBrace) {
			if (char === "(") depth++;
			if (char === ")") depth--;
			flush();
			const pair = char + (source[index + 1] ?? "");
			if (pair === "&&" || pair === "||" || pair === "|&") index++;
			scan.tokens.push({ value: pair === "&&" || pair === "||" || pair === "|&" ? pair : char, operator: true });
			continue;
		}
		word += char;
	}
	if (escaped) word += "\\";
	flush();
	return { ...scan, unbalanced: quote !== undefined || mode === "substitution" };
}

function heredocOperator(source: string, from: number): { delimiter: string; quoted: boolean; strip: boolean; end: number } | undefined {
	let index = from;
	const strip = source[index] === "-";
	if (strip) index++;
	while (source[index] === " " || source[index] === "\t") index++;
	let delimiter = "";
	let quoted = false;
	while (index < source.length && !/[\s;&|()<>]/.test(source[index]!)) {
		const char = source[index]!;
		if (char === "'" || char === "\"") {
			const close = source.indexOf(char, index + 1);
			if (close < 0) return undefined;
			delimiter += source.slice(index + 1, close);
			quoted = true;
			index = close + 1;
		} else if (char === "\\") {
			delimiter += source[index + 1] ?? "";
			quoted = true;
			index += 2;
		} else {
			delimiter += char;
			index++;
		}
	}
	return delimiter ? { delimiter, quoted, strip, end: index } : undefined;
}

/** The body runs to the delimiter line, or to the end of the source as bash reads an unterminated heredoc. */
function heredocBody(source: string, start: number, delimiter: string, strip: boolean) {
	let text = "";
	let index = start;
	while (index < source.length) {
		const lineEnd = source.indexOf("\n", index);
		const end = lineEnd < 0 ? source.length : lineEnd;
		const line = source.slice(index, end);
		index = end + 1;
		if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
		text += `${line}\n`;
	}
	return { text, end: Math.min(index, source.length) };
}

function isAssignment(value: string | undefined): boolean {
	return value !== undefined && /^[A-Za-z_]\w*\+?=/.test(value);
}

function executableName(value: string): string {
	return basename(value).toLocaleLowerCase().replace(/\.exe$/, "");
}
