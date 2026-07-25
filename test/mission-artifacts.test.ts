import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeMissionArtifacts, writeCompletionAudit, writeMissionProgressArtifacts } from "../extensions/mission/artifacts.ts";
import { MissionState } from "../extensions/mission/state.ts";

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("Mission artifacts", () => {
	it("keeps one canonical summary plus the searchable progress log", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "mission-artifacts-"));
		cleanup.push(cwd);
		const branch: Array<Record<string, unknown>> = [];
		const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
		const ctx = { cwd, sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
		const state = new MissionState();
		state.append(pi, await state.create({ objective: "Prove artifacts", requirements: ["Artifacts are minimal"], chain: "kit" }, ctx));
		let mission = state.read()!;
		await initializeMissionArtifacts(mission, state.readUsage());
		expect(readdirSync(mission.artifactDir).sort()).toEqual(["log.md", "mission.md"]);

		state.append(pi, state.progressEvent({ summary: "Checked files", evidence: ["directory listing"], validation: ["artifact test"] }));
		await writeMissionProgressArtifacts(state.read()!, state.readProgress(), state.readUsage());
		state.append(pi, state.statusEvent("complete", "validated", "Artifacts complete"));
		mission = state.readAny()!;
		await writeCompletionAudit(mission, "Artifacts complete", [{ requirement: "Artifacts are minimal", evidence: "Only mission.md and log.md exist" }], state.readUsage(), state.readProgress());
		const summary = readFileSync(path.join(mission.artifactDir, "mission.md"), "utf8");
		expect(summary).toContain("## Completion Audit");
		expect(summary).toContain("Artifacts are minimal: Only mission.md and log.md exist");
		expect(summary).toContain("Checked files");
	});
});
