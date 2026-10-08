import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessIdentity } from "../extensions/shared/process-group.ts";
import { cappedLog, exited } from "../extensions/subagents/engine/background.ts";
import { bunSqlite, lock, prune, SETTLED, unlock } from "../extensions/subagents/engine/storage.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "pi-kit-storage-")); dirs.push(dir); return dir; };
const DAY = 86_400_000;
const age = (path: string, days: number) => utimesSync(path, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY));

describe("engine storage", () => {
	it("prunes settled stores, ended workflow runs and scripts untouched for 14 days; never a store held, running or paused, nor a run not ended", async () => {
		const kit = scratch();
		const store = (name: string, days: number, held = false, settled = true) => {
			const dir = join(kit, "agents", "p1", name);
			mkdirSync(join(dir, "out"), { recursive: true });
			if (held) writeFileSync(join(dir, "engine.lock"), JSON.stringify({ pid: process.pid, identity: identity! }));
			if (settled) writeFileSync(join(dir, SETTLED), "");
			age(dir, days);
			return dir;
		};
		const identity = await readProcessIdentity(process.pid);
		const [old, fresh, held, paused] = [store("old", 15), store("fresh", 1), store("held", 15, true), store("paused", 15, false, false)];
		const scripts = join(kit, "workflows", "p1", "scripts");
		mkdirSync(scripts, { recursive: true });
		writeFileSync(join(scripts, "old.js"), "");
		writeFileSync(join(scripts, "new.js"), "");
		age(join(scripts, "old.js"), 15);
		const run = (id: string, ended: boolean) => {
			const dir = join(kit, "workflows", "p1", id);
			mkdirSync(dir);
			if (ended) writeFileSync(join(dir, `${id}.json`), "{}");
			age(dir, 15);
			return dir;
		};
		const [ended, running] = [run("wf_ended", true), run("wf_running", false)];
		await prune(kit);
		expect([old, fresh, held, paused, join(scripts, "old.js"), join(scripts, "new.js"), ended, running].map(existsSync)).toEqual([false, true, true, true, false, true, false, true]);
	});

	it("takes a lock whole, refuses one a live Pi holds, and replaces a stale one", async () => {
		const file = join(scratch(), "engine.lock");
		const live = JSON.stringify({ pid: process.ppid, identity: await readProcessIdentity(process.ppid) });
		writeFileSync(file, live);
		await expect(lock(file)).rejects.toThrow(`held by Pi process ${process.ppid}`);
		expect(readFileSync(file, "utf8")).toBe(live);
		writeFileSync(file, JSON.stringify({ pid: 1, identity: "gone" }));
		await lock(file);
		expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
		await unlock(file);
		expect(existsSync(file)).toBe(false);
	});

	it("runs bunSqlite's queued operations in order, one per macrotask so a timer fires between them, and rejects only the one that fails", async () => {
		const log: string[] = [];
		const step = (sql: string) => {
			if (sql === "bad") throw new Error("bad sql");
			const until = performance.now() + 2;
			while (performance.now() < until);
			log.push(sql);
		};
		// SAFETY: bunSqlite calls only exec, query().run/get/all and close.
		const db = bunSqlite(class {
			exec = step;
			query = (sql: string) => ({ run: () => step(sql), get: () => (step(sql), null), all: () => (step(sql), []) });
			close = () => step("close");
		} as never, ":memory:");
		log.length = 0;
		setTimeout(() => log.push("timer"), 0);
		const ops = [db.run("a"), db.exec("bad"), db.get("b"), db.transaction(async (tx) => tx.run("c")), db.all("d"), db.close()];
		await expect(ops[1]).rejects.toThrow("bad sql");
		await Promise.allSettled(ops);
		expect(log.filter((entry) => entry !== "timer")).toEqual(["a", "b", "BEGIN IMMEDIATE", "c", "COMMIT", "d", "close"]);
		expect(log.slice(0, log.indexOf("d"))).toContain("timer");
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

	it("kills a command spawned after its invocation was aborted, so a quit racing a job's start does not wait for it to exit", async () => {
		const child = spawn("bash", ["-c", "sleep 30"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		expect(await exited(child, AbortSignal.abort())).toBe(137);
	});
});
