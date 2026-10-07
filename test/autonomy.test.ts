import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAutonomous, migrateLegacyConfig } from "../extensions/shared/config.ts";

let agentDir: string;
let project: string;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "autonomy-agent-"));
	project = mkdtempSync(join(tmpdir(), "autonomy-project-"));
	mkdirSync(join(project, ".pi"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

const ctx = (trusted = true) => ({ cwd: project, isProjectTrusted: () => trusted });
const writeGlobal = (text: string) => writeFileSync(join(agentDir, "pi-kit.json"), text);
const writeProject = (name: string, text: string) => writeFileSync(join(project, ".pi", name), text);
const projectKit = () => JSON.parse(readFileSync(join(project, ".pi", "pi-kit.json"), "utf8")) as Record<string, unknown>;
const globalKit = () => JSON.parse(readFileSync(join(agentDir, "pi-kit.json"), "utf8")) as Record<string, unknown>;

describe("autonomy", () => {
	it("is on with no pi-kit.json anywhere", () => {
		expect(isAutonomous(ctx())).toBe(true);
	});

	it("lets a trusted project override the global file, re-reading both on every use", () => {
		writeGlobal(JSON.stringify({ autonomy: false }));
		expect(isAutonomous(ctx())).toBe(false);
		writeProject("pi-kit.json", JSON.stringify({ autonomy: true }));
		expect(isAutonomous(ctx())).toBe(true);
		expect(isAutonomous(ctx(false))).toBe(false);
		writeProject("pi-kit.json", JSON.stringify({ models: {} }));
		expect(isAutonomous(ctx())).toBe(false);
	});

	it("reads an invalid value, or a file that does not parse, as absent", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeGlobal(JSON.stringify({ autonomy: false }));
		for (const text of [JSON.stringify({ autonomy: "on" }), "{\"autonomy\": true,}"]) {
			writeProject("pi-kit.json", text);
			expect(isAutonomous(ctx())).toBe(false);
		}
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("moves /runtime auto on from .pi/runtime.json into .pi/pi-kit.json once, keeping other keys", async () => {
		writeGlobal(JSON.stringify({ autonomy: false }));
		writeProject("runtime.json", JSON.stringify({ auto: true }));
		writeProject("pi-kit.json", JSON.stringify({ models: { lead: "sol" } }));
		await migrateLegacyConfig(project);
		expect(isAutonomous(ctx())).toBe(true);
		expect(projectKit()).toEqual({ models: { lead: "sol" }, autonomy: true });
		expect(existsSync(join(project, ".pi", "runtime.json"))).toBe(false);
	});

	it("never overrides an explicit project setting and reads a non-true legacy flag as ask", async () => {
		writeProject("runtime.json", JSON.stringify({ auto: true }));
		writeProject("pi-kit.json", JSON.stringify({ autonomy: false }));
		await migrateLegacyConfig(project);
		expect(isAutonomous(ctx())).toBe(false);
		expect(existsSync(join(project, ".pi", "runtime.json"))).toBe(false);
		rmSync(join(project, ".pi", "pi-kit.json"));
		writeProject("runtime.json", "{\"auto\": \"yes\"}");
		await migrateLegacyConfig(project);
		expect(isAutonomous(ctx())).toBe(false);
		expect(projectKit()).toEqual({ autonomy: false });
	});

	it("reads the legacy auto and ask strings as booleans, then rewrites them once", async () => {
		writeGlobal(JSON.stringify({ autonomy: "ask", lead: "sol" }));
		writeProject("pi-kit.json", JSON.stringify({ autonomy: "auto" }));
		expect([isAutonomous(ctx(false)), isAutonomous(ctx())]).toEqual([false, true]);
		await migrateLegacyConfig(project);
		expect(globalKit()).toEqual({ autonomy: false, lead: "sol" });
		expect(projectKit()).toEqual({ autonomy: true });
	});
});
