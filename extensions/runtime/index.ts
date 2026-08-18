import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runtimeDelivery } from "../shared/runtime-delivery.ts";
import { registerRuntimeEventRenderer } from "../shared/runtime-ui.ts";
import { HostedRuntimeIntegration } from "./hosted-integration.ts";

export default function runtimeExtension(pi: ExtensionAPI): void {
	registerRuntimeEventRenderer(pi);
	runtimeDelivery.initialize(pi);
	const hosted = new HostedRuntimeIntegration(pi);
	pi.registerCommand("runtime", {
		description: "Start, inspect, register, or configure the durable Runtime service",
		handler: (args, ctx) => hosted.command(args, ctx),
	});
	pi.registerTool({
		name: "mail_send",
		label: "Send Collaborator Mail",
		description: "Send one durable message from this Pi session's held collaborator identity to another participant in the same project protocol.",
		promptSnippet: "Send durable mail to a persistent Runtime collaborator.",
		promptGuidelines: ["Use only when this Pi session has explicitly acquired a collaborator identity.", "Participant ownership changes are user-only commands and never model tools."],
		parameters: Type.Object({
			participantId: Type.String({ description: "Recipient participant id in the sender's current protocol" }),
			body: Type.String({ description: "Model-visible message body, capped at 16 KiB by Runtime" }),
		}),
		async execute(toolCallId, params: { participantId: string; body: string }, _signal, _onUpdate, ctx) {
			const result = await hosted.sendMail(params.participantId, params.body, toolCallId, ctx);
			return { content: [{ type: "text" as const, text: `Sent ${result.eventId} to ${result.recipient} (sequence ${result.sequence}).` }], details: result };
		},
	});
	pi.registerCommand("pi-kit-runtime-wake", {
		description: "Internal durable Runtime wake protocol",
		handler: (args, ctx) => hosted.acceptWake(args, ctx),
	});
	pi.on("session_start", async (_event, ctx) => {
		runtimeDelivery.restore(ctx);
		void runtimeDelivery.maybeDeliver();
		void hosted.sessionStart(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		runtimeDelivery.restore(ctx);
		hosted.sessionTree(ctx);
		void runtimeDelivery.maybeDeliver();
	});
	pi.on("message_start", (event) => {
		runtimeDelivery.acknowledgeMessage(event.message);
		hosted.acknowledgeMessage(event.message);
	});
	pi.on("before_agent_start", (_event, ctx) => runtimeDelivery.setContext(ctx));
	pi.on("agent_settled", (_event, ctx) => {
		runtimeDelivery.setContext(ctx);
		void runtimeDelivery.maybeDeliver();
	});
	pi.on("session_shutdown", async () => {
		runtimeDelivery.clearContext();
		await hosted.sessionShutdown();
	});
}
