import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentDir as kitAgentDir, kitValues } from "../extensions/shared/config.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let root: string;
let project: string;
let agentDir: string;
const write = (name: string, value: unknown) => writeFileSync(join(project, ".pi", name), typeof value === "string" ? value : JSON.stringify(value));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-kit-config-"));
	project = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(agentDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pi-kit.json", () => {
	it("reads valid keys, treats a bad file or value as absent, and warns once per problem naming the file and key", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		write("pi-kit.json", { codexFast: "yes" });
		writeFileSync(join(agentDir, "pi-kit.json"), "{ nope");
		expect(kitValues("codexFast", project, agentDir)).toEqual([undefined, undefined]);
		kitValues("codexFast", project, agentDir);
		const warnings = warn.mock.calls.map(([message]) => String(message));
		expect(warnings.filter((message) => message.includes(join(agentDir, "pi-kit.json")))).toHaveLength(1);
		expect(warnings.filter((message) => message.includes(`${join(project, ".pi", "pi-kit.json")}: /codexFast`))).toHaveLength(1);
		write("pi-kit.json", { codexFast: true, models: { old: "ignored" } });
		expect(kitValues("codexFast", project, agentDir)).toEqual([undefined, true]);
		warn.mockRestore();
	});
});

describe("agentDir", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("matches Pi's getAgentDir, including a ~ in PI_CODING_AGENT_DIR", () => {
		for (const value of ["~/pi-agent", "/abs/agent", "~", ""]) {
			vi.stubEnv("PI_CODING_AGENT_DIR", value);
			expect([value, kitAgentDir()]).toEqual([value, getAgentDir()]);
		}
		expect(kitAgentDir()).toBe(join(homedir(), ".pi", "agent"));
	});
});
