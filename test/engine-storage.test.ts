import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessIdentity } from "../extensions/shared/process-group.ts";
import { cappedLog } from "../extensions/subagents/engine/background.ts";
import { lock, prune, unlock } from "../extensions/subagents/engine/storage.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "pi-kit-storage-")); dirs.push(dir); return dir; };
const DAY = 86_400_000;
const age = (path: string, days: number) => utimesSync(path, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY));

describe("engine storage", () => {
	it("prunes stores and workflow runs and scripts untouched for 14 days, unless a live Pi holds the store", async () => {
		const kit = scratch();
		const store = (name: string, days: number, held = false) => {
			const dir = join(kit, "agents", "p1", name);
			mkdirSync(join(dir, "out"), { recursive: true });
			if (held) writeFileSync(join(dir, "engine.lock"), JSON.stringify({ pid: process.pid, identity: identity! }));
			age(dir, days);
			return dir;
		};
		const identity = await readProcessIdentity(process.pid);
		const [old, fresh, held] = [store("old", 15), store("fresh", 1), store("held", 15, true)];
		const scripts = join(kit, "workflows", "p1", "scripts");
		mkdirSync(scripts, { recursive: true });
		writeFileSync(join(scripts, "old.js"), "");
		writeFileSync(join(scripts, "new.js"), "");
		age(join(scripts, "old.js"), 15);
		const run = join(kit, "workflows", "p1", "wf_old");
		mkdirSync(run);
		age(run, 15);
		await prune(kit);
		expect([old, fresh, held, join(scripts, "old.js"), join(scripts, "new.js"), run].map(existsSync)).toEqual([false, true, true, false, true, false]);
	});

	it("takes a lock whole, refuses one a live Pi holds, and replaces a stale one", async () => {
		const file = join(scratch(), "engine.lock");
		writeFileSync(file, JSON.stringify({ pid: 1, identity: "gone" }));
		await lock(file);
		expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
		await unlock(file);
		expect(existsSync(file)).toBe(false);
	});

	it("cuts a command's output file at 10 MB across runs", async () => {
		const file = join(scratch(), "out.log");
		const first = cappedLog(file);
		first.write(Buffer.alloc(6_000_000));
		await first.end();
		const second = cappedLog(file);
		second.write(Buffer.alloc(6_000_000));
		await second.end();
		expect([statSync(file).size, first.cut, second.cut]).toEqual([10_000_000, false, true]);
	});
});
