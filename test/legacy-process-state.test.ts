import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyProcessStateFiles } from "../extensions/jobs/legacy.ts";

describe("legacy Process cutover warning", () => {
	it("detects old state records without adopting or deleting them", () => {
		const home = mkdtempSync(path.join(tmpdir(), "legacy-process-"));
		try {
			const directory = path.join(home, ".pi/agent/process-state");
			mkdirSync(directory, { recursive: true });
			writeFileSync(path.join(directory, "owned.json"), "{}\n");
			writeFileSync(path.join(directory, "ignore.txt"), "x");
			expect(legacyProcessStateFiles(home)).toEqual([path.join(directory, "owned.json")]);
			expect(legacyProcessStateFiles(home)).toHaveLength(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
