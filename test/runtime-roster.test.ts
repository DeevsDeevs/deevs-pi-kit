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
