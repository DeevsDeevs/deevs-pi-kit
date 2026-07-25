import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runtimeDelivery } from "../shared/runtime-delivery.ts";
import { registerRuntimeEventRenderer } from "../shared/runtime-ui.ts";

export default function runtimeExtension(pi: ExtensionAPI): void {
	registerRuntimeEventRenderer(pi);
	runtimeDelivery.initialize(pi);
	pi.on("session_start", (_event, ctx) => {
		runtimeDelivery.restore(ctx);
		void runtimeDelivery.maybeDeliver();
	});
	pi.on("session_tree", (_event, ctx) => {
		runtimeDelivery.restore(ctx);
		void runtimeDelivery.maybeDeliver();
	});
	pi.on("message_start", (event) => runtimeDelivery.acknowledgeMessage(event.message));
	pi.on("before_agent_start", (_event, ctx) => {
		runtimeDelivery.setContext(ctx);
		runtimeDelivery.acknowledgeDelivered(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		runtimeDelivery.setContext(ctx);
		runtimeDelivery.acknowledgeDelivered(ctx);
		void runtimeDelivery.maybeDeliver();
	});
	pi.on("session_shutdown", () => runtimeDelivery.clearContext());
}
