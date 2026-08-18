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
	pi.on("session_start", async (_event, ctx) => {
		runtimeDelivery.restore(ctx);
		void runtimeDelivery.maybeDeliver();
		void hosted.sessionStart(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		runtimeDelivery.restore(ctx);
		void runtimeDelivery.maybeDeliver();
	});
	pi.on("message_start", (event) => runtimeDelivery.acknowledgeMessage(event.message));
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
