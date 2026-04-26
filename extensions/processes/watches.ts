import type { ProcessesConfig } from "./config.ts";
import type { OutputStream, WatchSpec } from "./types.ts";

export interface RuntimeWatch extends WatchSpec {
	regex?: RegExp;
	fired: boolean;
	lastTriggeredAt: number;
}

export interface WatchMatch {
	watch: RuntimeWatch;
	text: string;
}

export function compileWatches(watches: WatchSpec[] | undefined, config: ProcessesConfig): RuntimeWatch[] {
	const specs = watches ?? [];
	if (specs.length > config.limits.maxWatchesPerProcess) {
		throw new Error(`Too many watches; max is ${config.limits.maxWatchesPerProcess}`);
	}

	return specs.map((watch) => {
		if (!watch.pattern) throw new Error("Watch pattern cannot be empty");
		if (watch.pattern.length > 1000) throw new Error("Watch pattern is too long");
		return {
			...watch,
			mode: watch.mode ?? "substring",
			stream: watch.stream ?? "both",
			regex: watch.mode === "regex" ? new RegExp(watch.pattern) : undefined,
			fired: false,
			lastTriggeredAt: 0,
		};
	});
}

export function findWatchMatches(watches: RuntimeWatch[], stream: OutputStream, text: string, cooldownMs: number): WatchMatch[] {
	const now = Date.now();
	const matches: WatchMatch[] = [];

	for (const watch of watches) {
		if (watch.stream !== "both" && watch.stream !== stream) continue;
		if (!watch.repeat && watch.fired) continue;
		if (watch.repeat && now - watch.lastTriggeredAt < cooldownMs) continue;
		if (!matchesWatch(watch, text)) continue;

		watch.fired = true;
		watch.lastTriggeredAt = now;
		matches.push({ watch, text });
	}

	return matches;
}

function matchesWatch(watch: RuntimeWatch, text: string): boolean {
	if (watch.regex) return watch.regex.test(text.slice(0, 64_000));
	return text.includes(watch.pattern);
}
