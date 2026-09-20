import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { HostedSessionStore } from "../extensions/runtime/session-record.ts";
import { HOSTED_SESSION_ENTRY } from "../extensions/runtime/session-restore.ts";

interface Entry {
	type: "custom";
	customType: string;
	data: unknown;
}

/** A session whose branch is exactly what the store appended, so restore reads back its own writes. */
function session(trusted = true): { pi: ExtensionAPI; ctx: ExtensionContext; branch: Entry[]; cwd: string } {
	const branch: Entry[] = [];
	const cwd = mkdtempSync(join(tmpdir(), "runtime-auto-"));
	const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		isProjectTrusted: () => trusted,
		ui: { notify() {} },
		sessionManager: { getBranch: () => branch, getSessionId: () => "session", getSessionFile: () => "/tmp/session.jsonl" },
	} as unknown as ExtensionContext;
	return { pi, ctx, branch, cwd };
}

describe("runtime auto mode", () => {
	it("is off until /runtime auto on persists it, and survives a restore of the same session", () => {
		const test = session();
		const store = new HostedSessionStore(test.pi);
		store.restore(test.ctx);
		expect(store.auto).toBe(false);
		store.persistAuto(true, test.ctx);
		expect(JSON.parse(readFileSync(join(test.cwd, ".pi", "runtime.json"), "utf8"))).toEqual({ auto: true });
		expect(test.branch.at(-1)).toEqual({ type: "custom", customType: HOSTED_SESSION_ENTRY, data: { version: 3, auto: true } });
		const restored = new HostedSessionStore(test.pi);
		restored.restore(test.ctx);
		expect(restored.auto).toBe(true);
		restored.persistAuto(false, test.ctx);
		expect(test.branch.at(-1)).toEqual({ type: "custom", customType: HOSTED_SESSION_ENTRY, data: { version: 3 } });
		expect(existsSync(join(test.cwd, ".pi", "runtime.json"))).toBe(false);
	});

	it("a later session in the same trusted project starts in auto mode from .pi/runtime.json", () => {
		const first = session();
		new HostedSessionStore(first.pi).persistAuto(true, first.ctx);
		const later = session();
		later.ctx.cwd = first.cwd;
		const store = new HostedSessionStore(later.pi);
		store.restore(later.ctx);
		expect(store.auto).toBe(true);
		const untrusted = session(false);
		untrusted.ctx.cwd = first.cwd;
		const guarded = new HostedSessionStore(untrusted.pi);
		guarded.restore(untrusted.ctx);
		expect(guarded.auto).toBe(false);
	});

	it("a project file that is not exactly {auto: true} turns auto off even if the session record said on", () => {
		const test = session();
		test.branch.push({ type: "custom", customType: HOSTED_SESSION_ENTRY, data: { version: 3, auto: true } });
		mkdirSync(join(test.cwd, ".pi"));
		writeFileSync(join(test.cwd, ".pi", "runtime.json"), "{\"auto\": \"yes\"}");
		const store = new HostedSessionStore(test.pi);
		store.restore(test.ctx);
		expect(store.auto).toBe(false);
	});

	it("ignores an auto flag that is anything but the literal true", () => {
		const test = session();
		test.branch.push({ type: "custom", customType: HOSTED_SESSION_ENTRY, data: { version: 3, auto: "yes" } });
		const store = new HostedSessionStore(test.pi);
		store.restore(test.ctx);
		expect(store.auto).toBe(false);
	});
});
