import { expect, it, vi } from "vitest";
import { HostedRuntimeIntegration } from "../extensions/runtime/hosted-integration.ts";
import { tasks } from "../extensions/shared/tasks.ts";

// Follow-up 19: the lead's SendMessage right after a start must find the row even when the roster sync never answers.
it("puts every started collaborator on the roster before the start returns", async () => {
	const integration = new HostedRuntimeIntegration({} as never, "/nonexistent-runtime");
	vi.spyOn(integration.collaborators, "start").mockResolvedValue([
		{ participant: "writer", status: "started", paneId: "w1:p2", driver: "claude-code", profile: "workspace-write" },
		{ participant: "broken", status: "failed", error: "no tab" },
	]);
	const ctx = { sessionManager: { getSessionId: () => "lead-session" } };
	await integration.start([{ participantId: "writer" }, { participantId: "broken" }], ctx as never);
	expect(tasks.find("writer", "lead-session", "collaborator")).toMatchObject({ status: "running", description: "claude-code workspace-write" });
	expect(tasks.find("broken", "lead-session", "collaborator")).toBeUndefined();
});

// F1: a Pi collaborator's SendMessage found only main, so pi-ask could not reach pi-cli while Claude and Codex peers could.
it("gives a collaborator, before each mail delivery, a send-only row for every peer started since", async () => {
	const integration = new HostedRuntimeIntegration({} as never, "/nonexistent-runtime");
	// SAFETY: the test stands in for a restored collaborator session record and a live Runtime session.
	const internals = integration as unknown as { store: { launch: object; identity: object }; messaging: { deliverMail(): Promise<void> } };
	vi.spyOn(internals.messaging, "deliverMail").mockResolvedValue();
	internals.store.launch = { driver: "pi", profile: "read-only" };
	internals.store.identity = { protocol: "collab", participantId: "pi-ask", disposition: "held" };
	const participant = (participantId: string) => ({ protocol: "collab", participantId, state: "held", driver: "pi" });
	vi.spyOn(integration.collaborators, "list").mockResolvedValue([participant("main"), participant("pi-ask"), participant("pi-cli")] as never);
	const ctx = { sessionManager: { getSessionId: () => "pi-ask-session" }, isIdle: () => true, hasUI: false };
	await integration.afterHeartbeat({} as never, ctx as never, { mail: { namespaceId: "msg_1", eventId: "evt_1" } } as never);
	expect(tasks.find("main", "pi-ask-session", "collaborator")).toMatchObject({ description: "the lead", status: "running" });
	const peer = tasks.find("pi-cli", "pi-ask-session", "collaborator");
	expect(peer).toMatchObject({ status: "running" });
	expect(peer?.send).toBeTypeOf("function");
	expect(peer?.stop).toBeUndefined();
	expect(tasks.find("pi-ask", "pi-ask-session", "collaborator")).toBeUndefined();
});
