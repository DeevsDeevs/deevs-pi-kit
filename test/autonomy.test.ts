import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAutonomous } from "../extensions/shared/autonomy.ts";

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

describe("autonomy", () => {
	it("is auto with no pi-kit.json anywhere", async () => {
		expect(await isAutonomous(ctx())).toBe(true);
	});

	it("lets a trusted project override the global file, re-reading both on every use", async () => {
		writeGlobal(JSON.stringify({ autonomy: "ask" }));
		expect(await isAutonomous(ctx())).toBe(false);
		writeProject("pi-kit.json", JSON.stringify({ autonomy: "auto" }));
		expect(await isAutonomous(ctx())).toBe(true);
		expect(await isAutonomous(ctx(false))).toBe(false);
		writeProject("pi-kit.json", JSON.stringify({ models: {} }));
		expect(await isAutonomous(ctx())).toBe(false);
	});

	it("reads an invalid value, or a file that does not parse, as absent", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeGlobal(JSON.stringify({ autonomy: "ask" }));
		for (const text of [JSON.stringify({ autonomy: false }), JSON.stringify({ autonomy: "on" }), "{\"autonomy\": \"auto\",}"]) {
			writeProject("pi-kit.json", text);
			expect(await isAutonomous(ctx())).toBe(false);
		}
		expect(warn).toHaveBeenCalledTimes(3);
		warn.mockRestore();
	});

	it("moves /runtime auto on from .pi/runtime.json into .pi/pi-kit.json once, keeping other keys", async () => {
		writeGlobal(JSON.stringify({ autonomy: "ask" }));
		writeProject("runtime.json", JSON.stringify({ auto: true }));
		writeProject("pi-kit.json", JSON.stringify({ models: { lead: "sol" } }));
		expect(await isAutonomous(ctx())).toBe(true);
		expect(projectKit()).toEqual({ models: { lead: "sol" }, autonomy: "auto" });
		expect(existsSync(join(project, ".pi", "runtime.json"))).toBe(false);
	});

	it("never overrides an explicit project setting and reads a non-true legacy flag as ask", async () => {
		writeProject("runtime.json", JSON.stringify({ auto: true }));
		writeProject("pi-kit.json", JSON.stringify({ autonomy: "ask" }));
		expect(await isAutonomous(ctx())).toBe(false);
		expect(existsSync(join(project, ".pi", "runtime.json"))).toBe(false);
		rmSync(join(project, ".pi", "pi-kit.json"));
		writeProject("runtime.json", "{\"auto\": \"yes\"}");
		expect(await isAutonomous(ctx())).toBe(false);
		expect(projectKit()).toEqual({ autonomy: "ask" });
	});

	it("leaves an untrusted project's files alone", async () => {
		writeProject("runtime.json", JSON.stringify({ auto: true }));
		expect(await isAutonomous(ctx(false))).toBe(true);
		expect(existsSync(join(project, ".pi", "runtime.json"))).toBe(true);
		expect(existsSync(join(project, ".pi", "pi-kit.json"))).toBe(false);
	});
});
