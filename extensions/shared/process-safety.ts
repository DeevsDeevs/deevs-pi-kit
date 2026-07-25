const DETACH_PATTERNS = [
	/\bnohup\b/i,
	/\bdisown\b/i,
	/\bsetsid\b/i,
	/(^|[^&])&(?![&>\d])\s*(?:$|[;#\n]|\S)/m,
];

export function detectDetachedShell(command: string): string | undefined {
	if (!DETACH_PATTERNS.some((pattern) => pattern.test(command))) return undefined;
	return "Detached shell command detected. Use a bounded Job, or Herdr for persistent/interactive process ownership.";
}
