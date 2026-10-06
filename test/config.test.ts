import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentDir as kitAgentDir, kitValues, migrateLegacyConfig } from "../extensions/shared/config.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let root: string;
let project: string;
let agentDir: string;
const write = (name: string, value: unknown) => writeFileSync(join(project, ".pi", name), typeof value === "string" ? value : JSON.stringify(value));
const kit = () => JSON.parse(readFileSync(join(project, ".pi", "pi-kit.json"), "utf8")) as Record<string, unknown>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-kit-config-"));
	project = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(agentDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pi-kit.json", () => {
	it("keeps what is valid, drops what is not, and warns once per problem naming the file and pointer", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		write("pi-kit.json", { codexFast: true, notifier: { title: 5, body: "ok" }, guard: { rmRf: "no", block: ["npm publish"] }, models: { sol: "x", luna: 7 }, lead: 3 });
		const path = join(project, ".pi", "pi-kit.json");
		writeFileSync(join(agentDir, "pi-kit.json"), "{ nope");
		expect(kitValues("codexFast", project, agentDir)).toEqual([undefined, true]);
		expect(kitValues("notifier", project, agentDir)).toEqual([undefined, { body: "ok" }]);
		expect(kitValues("guard", project, agentDir)).toEqual([undefined, { block: ["npm publish"] }]);
		expect(kitValues("models", project, agentDir)).toEqual([undefined, { sol: "x" }]);
		expect(kitValues("lead", project, agentDir)).toEqual([undefined, undefined]);
		kitValues("notifier", project, agentDir);
		const warnings = warn.mock.calls.map(([message]) => String(message));
		expect(warnings.filter((message) => message.includes(join(agentDir, "pi-kit.json")))).toHaveLength(1);
		expect(warnings.filter((message) => message.includes(`${path}: /notifier/title`))).toHaveLength(1);
		expect(warnings.some((message) => message.includes(`${path}: /guard/rmRf`))).toBe(true);
		warn.mockRestore();
	});

	it("moves the legacy project files in once, keeping keys already set", async () => {
		write("pi-kit.json", { codexFast: false, models: { sol: "x" } });
		write("codex-fast.json", { enabled: true, showStatus: false });
		write("notifier.json", { title: "Done", command: ["notify-send", "{title}"] });
		write("subagents.json", { allowedModels: ["openai-codex/gpt-5.6-sol"], defaultModel: "luna", parallelMaxConcurrency: 1 });
		write("runtime.json", { auto: true });
		await migrateLegacyConfig(project);
		expect(kit()).toEqual({ codexFast: false, models: { default: "luna", sol: "x" }, notifier: { title: "Done", command: ["notify-send", "{title}"] }, autonomy: true });
		for (const name of ["codex-fast.json", "notifier.json", "subagents.json", "runtime.json"]) expect(existsSync(join(project, ".pi", name))).toBe(false);
	});

	it("leaves everything when pi-kit.json does not parse, and a notifier.json off the schema", async () => {
		write("notifier.json", { title: 5 });
		await migrateLegacyConfig(project);
		expect(existsSync(join(project, ".pi", "notifier.json"))).toBe(true);
		write("pi-kit.json", "{ nope");
		write("codex-fast.json", { enabled: true });
		await migrateLegacyConfig(project);
		expect(existsSync(join(project, ".pi", "codex-fast.json"))).toBe(true);
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
