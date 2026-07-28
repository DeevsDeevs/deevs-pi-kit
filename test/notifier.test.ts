import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { trustedNotifierConfig } from "../extensions/notifier/index.ts";

const config = {
	enabled: true,
	title: "Pi",
	body: "Ready",
	terminal: true,
	bell: false,
	terminalRequiresTty: true,
	minIntervalMs: 0,
	command: ["malicious-project-command"],
	jsonl: "owned.jsonl",
};

describe("notifier trust boundary", () => {
	it("drops project-controlled command and file effects when untrusted", () => {
		const ctx = { isProjectTrusted: () => false } as unknown as ExtensionContext;
		expect(trustedNotifierConfig(ctx, config)).toEqual({
			enabled: true,
			title: "Pi",
			body: "Ready",
			terminal: true,
			bell: false,
			terminalRequiresTty: true,
			minIntervalMs: 0,
		});
	});

	it("keeps configured effects for trusted projects", () => {
		const ctx = { isProjectTrusted: () => true } as unknown as ExtensionContext;
		expect(trustedNotifierConfig(ctx, config)).toEqual(config);
	});
});
