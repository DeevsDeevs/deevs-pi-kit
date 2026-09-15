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
function session(): { pi: ExtensionAPI; ctx: ExtensionContext; branch: Entry[] } {
	const branch: Entry[] = [];
	const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/tmp/project",
		ui: { notify() {} },
		sessionManager: { getBranch: () => branch, getSessionId: () => "session", getSessionFile: () => "/tmp/session.jsonl" },
	} as unknown as ExtensionContext;
	return { pi, ctx, branch };
}

describe("runtime auto mode", () => {
	it("is off until /runtime auto on persists it, and survives a restore of the same session", () => {
		const test = session();
		const store = new HostedSessionStore(test.pi);
		store.restore(test.ctx);
		expect(store.auto).toBe(false);
		store.persistAuto(true);
		expect(test.branch.at(-1)).toEqual({ type: "custom", customType: HOSTED_SESSION_ENTRY, data: { version: 3, auto: true } });
		const restored = new HostedSessionStore(test.pi);
		restored.restore(test.ctx);
		expect(restored.auto).toBe(true);
		restored.persistAuto(false);
		expect(test.branch.at(-1)).toEqual({ type: "custom", customType: HOSTED_SESSION_ENTRY, data: { version: 3 } });
	});

	it("ignores an auto flag that is anything but the literal true", () => {
		const test = session();
		test.branch.push({ type: "custom", customType: HOSTED_SESSION_ENTRY, data: { version: 3, auto: "yes" } });
		const store = new HostedSessionStore(test.pi);
		store.restore(test.ctx);
		expect(store.auto).toBe(false);
	});
});
