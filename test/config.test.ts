import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kitValues, migrateLegacyConfig, readKitKey } from "../extensions/shared/config.ts";

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
	it("reads one key per file and names the file and pointer of a bad value", () => {
		write("pi-kit.json", { codexFast: true, notifier: { title: 5 } });
		const path = join(project, ".pi", "pi-kit.json");
		expect(readKitKey(path, "codexFast")).toBe(true);
		expect(readKitKey(path, "models")).toBeUndefined();
		expect(() => readKitKey(path, "notifier")).toThrow(`${path}: /notifier/title`);
		writeFileSync(join(agentDir, "pi-kit.json"), "{ nope");
		expect(kitValues("codexFast", project, agentDir)).toEqual([undefined, true]);
	});

	it("moves the legacy project files in once, keeping keys already set", async () => {
		write("pi-kit.json", { codexFast: false, models: { sol: "x" } });
		write("codex-fast.json", { enabled: true, showStatus: false });
		write("notifier.json", { title: "Done", command: ["notify-send", "{title}"] });
		write("subagents.json", { allowedModels: ["openai-codex/gpt-5.6-sol"], defaultModel: "luna", parallelMaxConcurrency: 1 });
		write("runtime.json", { auto: true });
		await migrateLegacyConfig(project);
		expect(kit()).toEqual({ codexFast: false, models: { default: "luna", sol: "x" }, notifier: { title: "Done", command: ["notify-send", "{title}"] }, autonomy: "auto" });
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
