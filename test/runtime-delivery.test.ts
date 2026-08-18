import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RuntimeDeliveryCoordinator } from "../extensions/shared/runtime-delivery.ts";
import { consumeRuntimeEvent, pendingRuntimeEvents, runtimeEvents, type RuntimeEvent } from "../extensions/shared/runtime-events.ts";

function setup(pending = false, failSend = false, dropSend = false) {
	const branch: Array<Record<string, unknown>> = [];
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		sendMessage(message: unknown, options: unknown) {
			if (failSend) throw new Error("send failed");
			messages.push({ message, options });
			if (dropSend) return;
			const value = message as { customType: string; details: unknown };
			branch.push({ type: "custom_message", customType: value.customType, details: value.details });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		isIdle: () => true,
		hasPendingMessages: () => pending,
		sessionManager: {
			getBranch: () => branch,
			getSessionFile: () => "/tmp/session.jsonl",
		},
	} as unknown as ExtensionContext;
	const coordinator = new RuntimeDeliveryCoordinator(20);
	coordinator.initialize(pi);
	coordinator.restore(ctx);
	return { branch, messages, pi, ctx, coordinator };
}

function terminalEvent(id = "terminal-1"): RuntimeEvent {
	return {
		version: 1,
		id,
		dedupeKey: `subagent:${id}:g1:terminal`,
		source: { kind: "subagent", id, generation: "g1" },
		type: "terminal",
		status: "completed",
		createdAt: 1,
		summary: "review complete",
	};
}

describe("runtime terminal delivery", () => {
	it("claims, wakes with a hidden follow-up, and acknowledges from context", async () => {
		const test = setup();
		runtimeEvents.record(test.pi, { type: "emit", event: terminalEvent() });
		await test.coordinator.maybeDeliver();

		expect(test.messages).toHaveLength(1);
		expect(test.messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect((test.messages[0]?.message as { content?: string }).content).toContain("Continue runnable independent work first");
		expect((test.messages[0]?.message as { content?: string }).content).not.toContain("Use subagent_wait");
		expect(runtimeEvents.read().deliveries["terminal-1"]?.status).toBe("claimed");

		test.coordinator.acknowledgeDelivered(test.ctx);
		expect(runtimeEvents.read().deliveries["terminal-1"]?.status).toBe("acked");
		expect(pendingRuntimeEvents(runtimeEvents.read())).toEqual([]);
		test.coordinator.clearContext();
	});

	it("does not wake after a structured tool already consumed the terminal result", async () => {
		const test = setup();
		runtimeEvents.record(test.pi, { type: "emit", event: terminalEvent() });
		expect(consumeRuntimeEvent(test.pi, "terminal-1", "/tmp/session.jsonl")).toBe(true);
		await test.coordinator.maybeDeliver();
		expect(test.messages).toEqual([]);
		expect(pendingRuntimeEvents(runtimeEvents.read())).toEqual([]);
		test.coordinator.clearContext();
	});

	it("releases claims immediately when delivery scheduling fails", async () => {
		const test = setup(false, true);
		runtimeEvents.record(test.pi, { type: "emit", event: terminalEvent() });
		await test.coordinator.maybeDeliver();
		expect(runtimeEvents.read().deliveries["terminal-1"]).toEqual({ status: "pending" });
		test.coordinator.clearContext();
	});

	it("releases and retries when the real void API swallows an asynchronous scheduling failure", async () => {
		const test = setup(false, false, true);
		runtimeEvents.record(test.pi, { type: "emit", event: terminalEvent() });
		await test.coordinator.maybeDeliver();
		expect(runtimeEvents.read().deliveries["terminal-1"]?.status).toBe("claimed");
		await new Promise((resolve) => setTimeout(resolve, 35));
		expect(test.messages.length).toBeGreaterThanOrEqual(2);
		expect(runtimeEvents.read().deliveries["terminal-1"]?.status).toBe("claimed");
		test.coordinator.clearContext();
	});

	it("keeps independent watchdogs for overlapping unconfirmed batches", async () => {
		const test = setup(false, false, true);
		runtimeEvents.record(test.pi, { type: "emit", event: terminalEvent("terminal-a") });
		await test.coordinator.maybeDeliver();
		runtimeEvents.record(test.pi, { type: "emit", event: terminalEvent("terminal-b") });
		await test.coordinator.maybeDeliver();
		await new Promise((resolve) => setTimeout(resolve, 35));
		expect(test.messages.length).toBeGreaterThanOrEqual(4);
		expect(runtimeEvents.read().deliveries["terminal-a"]?.status).toBe("claimed");
		expect(runtimeEvents.read().deliveries["terminal-b"]?.status).toBe("claimed");
		test.coordinator.clearContext();
	});

	it("batches terminal events without acknowledging undisclosed overflow", async () => {
		const test = setup();
		for (let index = 1; index <= 13; index++) {
			const event = terminalEvent(`terminal-${String(index).padStart(2, "0")}`);
			event.summary = `result ${index}`;
			runtimeEvents.record(test.pi, { type: "emit", event });
		}

		await test.coordinator.maybeDeliver();
		const first = test.messages[0]?.message as { content: string; details: { eventIds: string[] } };
		expect(first.details.eventIds).toHaveLength(12);
		expect(first.content).toContain("result 12");
		expect(first.content).not.toContain("result 13");
		expect(pendingRuntimeEvents(runtimeEvents.read()).map((event) => event.id)).toEqual(["terminal-13"]);

		test.coordinator.acknowledgeDelivered(test.ctx);
		await test.coordinator.maybeDeliver();
		const second = test.messages[1]?.message as { content: string; details: { eventIds: string[] } };
		expect(second.details.eventIds).toEqual(["terminal-13"]);
		expect(second.content).toContain("result 13");
		test.coordinator.clearContext();
	});

	it("does not wake ahead of queued user work", async () => {
		const test = setup(true);
		runtimeEvents.record(test.pi, { type: "emit", event: terminalEvent() });
		await test.coordinator.maybeDeliver();
		expect(test.messages).toEqual([]);
		expect(pendingRuntimeEvents(runtimeEvents.read())).toHaveLength(1);
	});
});
