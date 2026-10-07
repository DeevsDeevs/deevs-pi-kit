import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { lookAtPath, lookAtUrl, RateLimit } from "../extensions/subagents/engine/watch.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "pi-kit-watch-")); dirs.push(dir); return dir; };

describe("Monitor looks", () => {
	it("reports a folder's added, changed and removed files against the last look", async () => {
		const dir = scratch();
		writeFileSync(join(dir, "a.txt"), "a");
		writeFileSync(join(dir, "b.txt"), "b");
		const first = await lookAtPath(dir, undefined);
		expect([first.baseline, first.event]).toEqual(["2 files", undefined]);
		writeFileSync(join(dir, "a.txt"), "aa");
		rmSync(join(dir, "b.txt"));
		writeFileSync(join(dir, "c.txt"), "c");
		const second = await lookAtPath(dir, first.seen);
		expect(second.event?.split("\n").sort()).toEqual(["added c.txt", "changed a.txt", "removed b.txt"]);
		expect((await lookAtPath(dir, second.seen)).event).toBeUndefined();
	});

	it("reports a folder created after the watch began, with its first files", async () => {
		const dir = join(scratch(), "later");
		const first = await lookAtPath(dir, undefined);
		mkdirSync(dir);
		writeFileSync(join(dir, "a.txt"), "a");
		expect((await lookAtPath(dir, first.seen)).event).toBe("added a.txt");
	});

	it("reports a file that became a folder, or a folder that became a file, as one event", async () => {
		const path = join(scratch(), "p");
		writeFileSync(path, "old\n");
		const file = await lookAtPath(path, undefined);
		rmSync(path);
		mkdirSync(path);
		writeFileSync(join(path, "a.txt"), "a");
		writeFileSync(join(path, "b.txt"), "b");
		const folder = await lookAtPath(path, file.seen);
		expect(folder.event).toBe("The file is now a folder.");
		rmSync(path, { recursive: true });
		writeFileSync(path, "new\n");
		expect((await lookAtPath(path, folder.seen)).event).toBe("The folder is now a file.");
	});

	it("skips node_modules and .git", async () => {
		const dir = scratch();
		for (const skipped of ["node_modules", ".git"]) {
			mkdirSync(join(dir, skipped));
			writeFileSync(join(dir, skipped, "x"), "x");
		}
		writeFileSync(join(dir, "a.txt"), "a");
		expect(Object.keys((await lookAtPath(dir, undefined)).seen)).toEqual(["files"]);
		expect((await lookAtPath(dir, undefined)).baseline).toBe("1 files");
	});

	it("reads at most 1 MB of a URL's body", async () => {
		const server = createServer((_request, response) => response.end("x".repeat(3_000_000)));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = server.address() as { port: number };
			expect((await lookAtUrl(`http://127.0.0.1:${port}/`, undefined, new AbortController().signal)).baseline).toBe("200, 976.6 KB");
		} finally {
			server.close();
		}
	});

	it("reports a file's new lines from its stored offset", async () => {
		const file = join(scratch(), "log");
		writeFileSync(file, "old\n");
		const first = await lookAtPath(file, undefined);
		appendFileSync(file, "new 1\nnew 2\n");
		const second = await lookAtPath(file, first.seen);
		expect(second.event).toBe("new 1\nnew 2");
		expect((await lookAtPath(file, second.seen)).event).toBeUndefined();
	});
});

describe("Monitor rate limit", () => {
	it("passes 10 events, drops the rest, counts the drops into the next pass, and stops after 30 s of overflow", () => {
		const limit = new RateLimit(0);
		expect(Array.from({ length: 12 }, () => limit.take(0))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, "drop", "drop"]);
		expect(limit.take(2_000)).toBe(2);
		expect(limit.take(2_000)).toBe("drop");
		expect(limit.take(31_000)).toBe(1);
		for (let now = 31_000; now <= 61_000; now += 100) limit.take(now);
		expect(limit.take(62_000)).toBe("stop");
	});
});
