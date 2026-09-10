import { chmodSync, fsyncSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { managedAgentCredentialPath, persistManagedAgentCredentials, readManagedAgentCredentials, type ManagedAgentBinding } from "../extensions/runtime/managed-agent-credentials.ts";

vi.mock("node:fs", async importOriginal => {
	const original = await importOriginal<typeof import("node:fs")>();
	return { ...original, fsyncSync: vi.fn(original.fsyncSync) };
});
const roots: string[] = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const binding: ManagedAgentBinding = { owner: { sessionId: "controller", sessionFile: "/controller.jsonl", cwd: "/project" }, projectRoot: "/project", cwd: "/worktree", bridgeId: "bridge_one", targetKey: "target_one", driver: "codex", clientGeneration: "client_one", configurationHash: "a".repeat(64), holderGeneration: "holder_one", paneId: "w1:p9", terminalId: "terminal_one", agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "managed_one" }, messagingConfigured: true };
const credentials = { launchToken: "fixture_launch_secret", reconnectToken: "fixture_reconnect_secret" };
function setup() {
	const root = mkdtempSync(join(tmpdir(), "native-control-"));
	roots.push(root);
	return { root, path: managedAgentCredentialPath(root, binding) };
}

it("stores immutable owner-only credentials separately and permits exact active-state retries", () => {
	const { root, path } = setup();
	persistManagedAgentCredentials(root, binding, credentials);
	expect(lstatSync(path).mode & 0o777).toBe(0o600);
	const bytes = readFileSync(path);
	expect(readManagedAgentCredentials(root, binding)).toEqual(credentials);
	persistManagedAgentCredentials(root, binding, credentials);
	persistManagedAgentCredentials(root, binding, { reconnectToken: credentials.reconnectToken });
	expect(readFileSync(path)).toEqual(bytes);
	expect(() => persistManagedAgentCredentials(root, binding, { ...credentials, reconnectToken: "different" })).toThrow("exact binding");
	expect(readFileSync(path)).toEqual(bytes);
});

it.each([
	{ clientGeneration: "other" }, { targetKey: "other" }, { bridgeId: "other" }, { holderGeneration: "other" }, { configurationHash: "b".repeat(64) }, { terminalId: "other" }, { paneId: "w1:p8" }, { cwd: "/other" }, { projectRoot: "/other" }, { messagingConfigured: false }, { agentSession: { ...binding.agentSession, value: "other" } }, { owner: { ...binding.owner, sessionId: "other" } }, { owner: { ...binding.owner, sessionFile: "/other.jsonl" } }, { owner: { ...binding.owner, cwd: "/other" } },
])("rejects changed exact binding %j", changed => {
	const { root, path } = setup();
	persistManagedAgentCredentials(root, binding, credentials);
	const bytes = readFileSync(path);
	expect(() => readManagedAgentCredentials(root, { ...binding, ...changed })).toThrow("exact binding");
	expect(readFileSync(path)).toEqual(bytes);
});

it("rejects missing, public, symlinked and corrupt files without repairing them", () => {
	const { root, path } = setup();
	expect(() => persistManagedAgentCredentials(root, binding, { reconnectToken: credentials.reconnectToken })).toThrow();
	persistManagedAgentCredentials(root, binding, credentials);
	chmodSync(path, 0o644);
	expect(() => readManagedAgentCredentials(root, binding)).toThrow();
	chmodSync(path, 0o600);
	const original = readFileSync(path);
	const other = join(root, "original.json");
	writeFileSync(other, original, { mode: 0o600 });
	rmSync(path);
	symlinkSync(other, path);
	expect(() => readManagedAgentCredentials(root, binding)).toThrow();
	expect(() => persistManagedAgentCredentials(root, binding, credentials)).toThrow();
	expect(lstatSync(path).isSymbolicLink()).toBe(true);
	rmSync(path);
	writeFileSync(path, "{", { mode: 0o600 });
	expect(() => persistManagedAgentCredentials(root, binding, credentials)).toThrow();
	expect(readFileSync(path, "utf8")).toBe("{");
});

it("retains uncertain writes and syncs an identical retry before accepting it", () => {
	const { root, path } = setup();
	vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("injected sync failure"); });
	expect(() => persistManagedAgentCredentials(root, binding, credentials)).toThrow("injected sync failure");
	const bytes = readFileSync(path);
	vi.mocked(fsyncSync).mockClear();
	persistManagedAgentCredentials(root, binding, credentials);
	expect(fsyncSync).toHaveBeenCalledTimes(2);
	expect(readFileSync(path)).toEqual(bytes);
	vi.mocked(fsyncSync).mockClear();
	expect(readManagedAgentCredentials(root, binding)).toEqual(credentials);
	expect(fsyncSync).not.toHaveBeenCalled();
});

it("rejects unsupported and oversized artifacts and unsafe roots without changing bytes", () => {
	const { root, path } = setup();
	persistManagedAgentCredentials(root, binding, credentials);
	for (const bytes of [JSON.stringify({ version: 0, binding, ...credentials }), "x".repeat(4097)]) {
		writeFileSync(path, bytes);
		expect(() => readManagedAgentCredentials(root, binding)).toThrow();
		expect(() => persistManagedAgentCredentials(root, binding, credentials)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(bytes);
	}
	chmodSync(root, 0o755);
	expect(() => readManagedAgentCredentials(root, binding)).toThrow();
	expect(() => persistManagedAgentCredentials(root, binding, credentials)).toThrow();
});
