import { basename } from "node:path";

const DETACH_PATTERNS = [
	/\bnohup\b/i,
	/\bdisown\b/i,
	/\bsetsid\b/i,
	/(^|[^&])&(?![&>\d])\s*(?:$|[;#\n]|\S)/m,
];
const DETACH_EXECUTABLES = new Set(["nohup", "setsid"]);
const SHELL_EXECUTABLES = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);

const DETACH_ERROR = "Detached process launch detected. Use Herdr for persistent or independently owned processes.";

export function detectDetachedShell(command: string): string | undefined {
	return DETACH_PATTERNS.some((pattern) => pattern.test(command)) ? DETACH_ERROR : undefined;
}

export function detectDetachedArgv(argv: string[]): string | undefined {
	if (!argv.length) return undefined;
	if (argv.some((value) => DETACH_EXECUTABLES.has(executableName(value)))) return DETACH_ERROR;
	const executable = executableName(argv[0]!);
	if (SHELL_EXECUTABLES.has(executable) || executable === "env" || executable === "command") return detectDetachedShell(argv.slice(1).join(" "));
	return undefined;
}

function executableName(value: string): string {
	return basename(value).toLocaleLowerCase().replace(/\.exe$/, "");
}
