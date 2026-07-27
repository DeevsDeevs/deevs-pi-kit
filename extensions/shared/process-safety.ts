import { basename } from "node:path";

const DETACH_EXECUTABLES = new Set(["disown", "nohup", "setsid"]);
const SHELL_EXECUTABLES = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const ENV_VALUE_OPTIONS = new Set(["-a", "--argv0", "-C", "--chdir", "-u", "--unset"]);
const SUDO_VALUE_OPTIONS = new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-u", "--chdir", "--close-from", "--group", "--host", "--prompt", "--role", "--type", "--user"]);
const COMMAND_PREFIXES = new Set(["!", "builtin", "do", "elif", "else", "if", "then", "until", "while"]);
const DETACH_ERROR = "Detached process launch detected. Use Herdr for persistent or independently owned processes.";

interface ShellToken {
	value: string;
	operator: boolean;
}

export function detectDetachedShell(command: string): string | undefined {
	return shellHasDetached(command) ? DETACH_ERROR : undefined;
}

export function detectDetachedArgv(argv: string[]): string | undefined {
	if (!argv.length) return undefined;
	const executable = executableName(argv[0]!);
	if (DETACH_EXECUTABLES.has(executable)) return DETACH_ERROR;
	if (SHELL_EXECUTABLES.has(executable)) {
		const command = shellCommand(argv.slice(1));
		return command ? detectDetachedShell(command) : undefined;
	}
	if (executable === "env") return detectEnvArgv(argv.slice(1));
	if (executable === "time") return detectTimeArgv(argv.slice(1));
	if (executable === "nice") return detectNiceArgv(argv.slice(1));
	if (executable === "timeout") return detectTimeoutArgv(argv.slice(1));
	if (executable === "stdbuf") return detectStdbufArgv(argv.slice(1));
	if (executable === "sudo") return detectSudoArgv(argv.slice(1));
	if (executable === "command") return detectCommandArgv(argv.slice(1));
	return undefined;
}

function shellHasDetached(source: string): boolean {
	if (substitutionHasDetached(source)) return true;
	let segment: string[] = [];
	for (const token of shellTokens(source)) {
		if (!token.operator) {
			segment.push(token.value);
			continue;
		}
		if (segmentDetached(segment)) return true;
		segment = [];
		if (token.value === "&") return true;
	}
	return segmentDetached(segment);
}

function segmentDetached(words: string[]): boolean {
	let index = 0;
	while (isAssignment(words[index])) index++;
	if (index >= words.length) return false;
	const executable = executableName(words[index]!);
	const argv = words.slice(index + 1);
	if (DETACH_EXECUTABLES.has(executable)) return true;
	if (COMMAND_PREFIXES.has(executable)) return segmentDetached(argv);
	if (executable === "exec") return segmentDetached(execCommand(argv));
	if (executable === "eval") return shellHasDetached(argv.join(" "));
	if (executable === "time") return detectTimeArgv(argv) !== undefined;
	if (executable === "nice") return detectNiceArgv(argv) !== undefined;
	if (executable === "timeout") return detectTimeoutArgv(argv) !== undefined;
	if (executable === "stdbuf") return detectStdbufArgv(argv) !== undefined;
	if (SHELL_EXECUTABLES.has(executable)) {
		const command = shellCommand(argv);
		return command ? shellHasDetached(command) : false;
	}
	if (executable === "env") return detectEnvArgv(argv) !== undefined;
	if (executable === "sudo") return detectSudoArgv(argv) !== undefined;
	if (executable === "command") return detectCommandArgv(argv) !== undefined;
	return false;
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

function detectEnvArgv(argv: string[], splitDepth = 0): string | undefined {
	if (splitDepth > 8) return DETACH_ERROR;
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-S" || value === "--split-string") return detectEnvSplit(argv[index + 1] ?? "", argv.slice(index + 2), splitDepth);
		if (value.startsWith("-S") && value.length > 2) return detectEnvSplit(value.slice(2), argv.slice(index + 1), splitDepth);
		if (value.startsWith("--split-string=")) return detectEnvSplit(value.slice("--split-string=".length), argv.slice(index + 1), splitDepth);
		if (ENV_VALUE_OPTIONS.has(value)) { index += 2; continue; }
		if (value.startsWith("-") || isAssignment(value)) { index++; continue; }
		break;
	}
	return detectDetachedArgv(argv.slice(index));
}

function detectEnvSplit(source: string, trailing: string[], splitDepth: number): string | undefined {
	const words = splitEnvString(source);
	return words ? detectEnvArgv([...words, ...trailing], splitDepth + 1) : DETACH_ERROR;
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
		if (char === "$" && quote !== "'" && source[index + 1] === "{") return undefined;
		if ((char === "'" || char === "\"") && (!quote || quote === char)) { quote = quote ? undefined : char; continue; }
		if (!quote && /\s/.test(char)) { flush(); continue; }
		word += char;
	}
	if (quote) return undefined;
	flush();
	return result;
}

function detectTimeArgv(argv: string[]): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-f" || value === "--format" || value === "-o" || value === "--output") { index += 2; continue; }
		if (value.startsWith("--format=") || value.startsWith("--output=") || /^-[fo].+/.test(value)) { index++; continue; }
		if (value.startsWith("-")) { index++; continue; }
		break;
	}
	return detectDetachedArgv(argv.slice(index));
}

function detectNiceArgv(argv: string[]): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-n" || value === "--adjustment") { index += 2; continue; }
		if (value.startsWith("--adjustment=") || /^-\d+$/.test(value)) { index++; continue; }
		if (value.startsWith("-")) { index++; continue; }
		break;
	}
	return detectDetachedArgv(argv.slice(index));
}

function detectTimeoutArgv(argv: string[]): string | undefined {
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
	return detectDetachedArgv(argv.slice(index));
}

function detectStdbufArgv(argv: string[]): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-i" || value === "--input" || value === "-o" || value === "--output" || value === "-e" || value === "--error") { index += 2; continue; }
		if (/^-[ioe].+/.test(value) || value.startsWith("--input=") || value.startsWith("--output=") || value.startsWith("--error=")) { index++; continue; }
		if (value.startsWith("-")) { index++; continue; }
		break;
	}
	return detectDetachedArgv(argv.slice(index));
}

function detectSudoArgv(argv: string[]): string | undefined {
	let index = 0;
	while (index < argv.length) {
		const value = argv[index]!;
		if (value === "--") { index++; break; }
		if (value === "-b" || value === "--background") return DETACH_ERROR;
		if (SUDO_VALUE_OPTIONS.has(value)) { index += 2; continue; }
		if (value.startsWith("-")) { index++; continue; }
		break;
	}
	return detectDetachedArgv(argv.slice(index));
}

function detectCommandArgv(argv: string[]): string | undefined {
	if (argv.some((value) => value === "-v" || value === "-V")) return undefined;
	return detectDetachedArgv(argv.filter((value) => value !== "--" && value !== "-p"));
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

function substitutionHasDetached(source: string): boolean {
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	for (let index = 0; index < source.length; index++) {
		const char = source[index]!;
		if (escaped) { escaped = false; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if (char === "'" && quote !== "\"") { quote = quote === "'" ? undefined : "'"; continue; }
		if (char === "\"" && quote !== "'") { quote = quote === "\"" ? undefined : "\""; continue; }
		if (quote === "'") continue;
		if (char === "`") {
			let end = index + 1;
			for (; end < source.length; end++) {
				if (source[end] === "\\") { end++; continue; }
				if (source[end] === "`") break;
			}
			if (end < source.length && shellHasDetached(source.slice(index + 1, end))) return true;
			index = end;
			continue;
		}
		if (char === "$" && source[index + 1] === "(") {
			const end = closingParen(source, index + 1);
			if (end !== undefined && shellHasDetached(source.slice(index + 2, end))) return true;
			if (end !== undefined) index = end;
		}
	}
	return false;
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

function shellTokens(source: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let word = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	const flush = () => {
		if (!word) return;
		tokens.push({ value: word, operator: false });
		word = "";
	};
	for (let index = 0; index < source.length; index++) {
		const char = source[index]!;
		if (escaped) { word += char; escaped = false; continue; }
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === "\"") escaped = true;
			else word += char;
			continue;
		}
		if (char === "'" || char === "\"") { quote = char; continue; }
		if (char === "\\") { escaped = true; continue; }
		if (char === "\n") { flush(); tokens.push({ value: "\n", operator: true }); continue; }
		if (/\s/.test(char)) { flush(); continue; }
		if (char === "&" && (source[index + 1] === ">" || (word.endsWith(">") && /\d/.test(source[index + 1] ?? "")))) { word += char; continue; }
		if (";&|(){}".includes(char)) {
			flush();
			const pair = char + (source[index + 1] ?? "");
			if (pair === "&&" || pair === "||" || pair === "|&") index++;
			tokens.push({ value: pair === "&&" || pair === "||" || pair === "|&" ? pair : char, operator: true });
			continue;
		}
		word += char;
	}
	if (escaped) word += "\\";
	flush();
	return tokens;
}

function isAssignment(value: string | undefined): boolean {
	return value !== undefined && /^[A-Za-z_]\w*=/.test(value);
}

function executableName(value: string): string {
	return basename(value).toLocaleLowerCase().replace(/\.exe$/, "");
}
