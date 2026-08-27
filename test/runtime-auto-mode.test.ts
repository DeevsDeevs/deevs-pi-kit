import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaboratorAutoStore } from "../extensions/runtime/auto-mode.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("collaborator Auto mode", () => {
	it("defaults and fails closed to Manual, then persists typed Auto state", () => {
		const { store } = setup();
		expect(store.read()).toMatchObject({ valid: true, state: { enabled: false, maxConcurrentStarts: 4, maxLiveCollaborators: 12, profileCeiling: "workspace-write" } });
		const enabled = store.set(true);
		expect(enabled.enabled).toBe(true);
		expect(store.read()).toMatchObject({ valid: true, state: { enabled: true, generation: enabled.generation } });
		writeFileSync(store.statePath, "{broken");
		expect(store.read()).toMatchObject({ valid: false, state: { enabled: false } });
		expect(() => store.toggle()).toThrow("recover explicitly");
		expect(store.set(false).enabled).toBe(false);
		expect(store.read()).toMatchObject({ valid: true, state: { enabled: false } });
	});

	it("moves thinking to Ctrl+Shift+T and leaves unrelated keybindings intact", () => {
		const { store } = setup();
		writeFileSync(store.keybindingsPath, `${JSON.stringify({ "app.model.select": "ctrl+l", "app.thinking.cycle": ["shift+tab", "f8"] })}\n`);
		expect(store.shortcutConfigured()).toBe(false);
		expect(store.configureShortcut().changed).toBe(true);
		expect(JSON.parse(readFileSync(store.keybindingsPath, "utf8"))).toEqual({ "app.model.select": "ctrl+l", "app.thinking.cycle": ["f8", "ctrl+shift+t"] });
		expect(store.shortcutConfigured()).toBe(true);
		expect(store.configureShortcut().changed).toBe(false);
	});

	it("rejects conflicting or symlinked keybinding state", () => {
		const first = setup();
		writeFileSync(first.store.keybindingsPath, `${JSON.stringify({ "app.model.select": "ctrl+shift+t" })}\n`);
		expect(() => first.store.configureShortcut()).toThrow("already assigned");
		const second = setup();
		writeFileSync(join(second.root, "target.json"), "{}\n");
		symlinkSync(join(second.root, "target.json"), second.store.keybindingsPath);
		expect(() => second.store.configureShortcut()).toThrow("symbolic link");
	});

	it("serializes Auto starts and fails closed on a stale lock", async () => {
		const { root, store } = setup();
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const first = store.withStartLock(async () => { entered(); await held; return "first"; });
		await started;
		await expect(store.withStartLock(async () => "second")).rejects.toThrow("already in progress");
		release();
		expect(await first).toBe("first");
		const lockPath = join(root, "runtime", "auto-start.lock");
		writeFileSync(lockPath, `${JSON.stringify({ token: "stale", pid: 999999 })}\n`);
		await expect(store.withStartLock(async () => "unsafe")).rejects.toThrow("stale locks fail closed");
		unlinkSync(lockPath);
		expect(await store.withStartLock(async () => "operator-recovered")).toBe("operator-recovered");
	});
});

function setup(): { root: string; store: CollaboratorAutoStore } {
	const root = mkdtempSync(join(tmpdir(), "runtime-auto-"));
	roots.push(root);
	return { root, store: new CollaboratorAutoStore(join(root, "runtime")) };
}
