import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import autoModeExtension from "../extensions/auto-mode/index.ts";
import { AUTO_MODE_CUSTOM_TYPE, isAutoModeEnabled } from "../extensions/shared/auto-mode.ts";

function setup(hasUI = true) {
	let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const branch: Array<Record<string, unknown>> = [];
	const confirms: boolean[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		on(name: string, handler: unknown) { handlers.set(name, handler as (event: unknown, ctx: ExtensionContext) => void); },
		registerCommand(_name: string, value: unknown) { command = value as typeof command; },
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	autoModeExtension(pi);
	const ctx = {
		hasUI,
		mode: hasUI ? "tui" : "print",
		sessionManager: { getBranch: () => branch },
		ui: {
			confirm: async () => {
				const answer = confirms.shift();
				if (answer === undefined) throw new Error("unexpected confirm");
				return answer;
			},
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setStatus(_key: string, text: string | undefined) { statuses.push(text); },
		},
	} as unknown as ExtensionContext;
	return { command: command!, sessionStart: handlers.get("session_start")!, ctx, branch, confirms, notifications, statuses };
}

describe("auto mode", () => {
	it("enables after a single upfront confirmation and records the session entry", async () => {
		const { command, ctx, branch, confirms, statuses } = setup();
		confirms.push(true);
		await command.handler("on", ctx);
		expect(isAutoModeEnabled(ctx)).toBe(true);
		expect(branch).toEqual([{ type: "custom", customType: AUTO_MODE_CUSTOM_TYPE, data: { enabled: true } }]);
		expect(statuses.at(-1)).toBe("auto");
		await command.handler("on", ctx);
		expect(confirms).toEqual([]);
		expect(branch).toHaveLength(1);
	});

	it("stays off when the confirmation is declined", async () => {
		const { command, ctx, branch, confirms } = setup();
		confirms.push(false);
		await command.handler("on", ctx);
		expect(isAutoModeEnabled(ctx)).toBe(false);
		expect(branch).toEqual([]);
	});

	it("toggles on empty arguments and disables without confirmation", async () => {
		const { command, ctx, branch, confirms, statuses } = setup();
		confirms.push(true);
		await command.handler("", ctx);
		expect(isAutoModeEnabled(ctx)).toBe(true);
		await command.handler("", ctx);
		expect(isAutoModeEnabled(ctx)).toBe(false);
		expect(branch.at(-1)).toEqual({ type: "custom", customType: AUTO_MODE_CUSTOM_TYPE, data: { enabled: false } });
		expect(statuses.at(-1)).toBeUndefined();
	});

	it("refuses to enable without a UI", async () => {
		const { command, ctx, branch, notifications } = setup(false);
		await command.handler("on", ctx);
		expect(isAutoModeEnabled(ctx)).toBe(false);
		expect(branch).toEqual([]);
		expect(notifications.at(-1)?.level).toBe("warning");
		await command.handler("", ctx);
		expect(isAutoModeEnabled(ctx)).toBe(false);
		expect(notifications.at(-1)?.level).toBe("info");
	});

	it("restores the last recorded state on session start", async () => {
		const { sessionStart, ctx, branch, statuses } = setup();
		branch.push(
			{ type: "custom", customType: AUTO_MODE_CUSTOM_TYPE, data: { enabled: true } },
			{ type: "custom", customType: "other", data: { enabled: false } },
		);
		sessionStart({}, ctx);
		expect(isAutoModeEnabled(ctx)).toBe(true);
		expect(statuses.at(-1)).toBe("auto");
		branch.push({ type: "custom", customType: AUTO_MODE_CUSTOM_TYPE, data: { enabled: false } });
		sessionStart({}, ctx);
		expect(isAutoModeEnabled(ctx)).toBe(false);
	});
});
