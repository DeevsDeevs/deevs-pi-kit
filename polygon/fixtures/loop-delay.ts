// Sandbox-only: logs each event-loop delay over 20 ms inside this Pi to ~/loop-delay.log as `<epoch ms> <delay ms>`, the stall its user feels.
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default function loopDelay(): void {
	const log = join(homedir(), "loop-delay.log");
	appendFileSync(log, "");
	let last = performance.now();
	setInterval(() => {
		const now = performance.now();
		const delay = now - last - 10;
		last = now;
		if (delay > 20) appendFileSync(log, `${Date.now()} ${Math.round(delay)}\n`);
	}, 10).unref();
}
