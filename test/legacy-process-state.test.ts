import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyProcessStateFiles } from "../extensions/jobs/legacy.ts";

describe("legacy Process cutover warning", () => {
	it("warns only for live or malformed old state records", () => {
		const home = mkdtempSync(path.join(tmpdir(), "legacy-process-"));
		try {
			const directory = path.join(home, ".pi/agent/process-state");
			mkdirSync(directory, { recursive: true });
			writeFileSync(path.join(directory, "active.json"), JSON.stringify({ version: 1, processes: [{ id: "legacy" }] }));
			writeFileSync(path.join(directory, "malformed.json"), "{}\n");
			writeFileSync(path.join(directory, "empty.json"), JSON.stringify({ version: 1, processes: [] }));
			writeFileSync(path.join(directory, "zero.json"), "");
			writeFileSync(path.join(directory, "ignore.txt"), "x");
			expect(legacyProcessStateFiles(home)).toEqual([path.join(directory, "active.json"), path.join(directory, "malformed.json")]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
