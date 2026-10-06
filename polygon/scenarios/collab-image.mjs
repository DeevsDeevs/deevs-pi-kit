import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, fixtureModels, herdr, rpc } from "../drive.mjs";
import { notifications, requests } from "../look.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// A collaborator's SendMessage with an image puts that image into the Pi lead's next request.
export default {
	name: "collab-image",
	gate: "M6",
	live: true,
	timeoutMs: 180_000,
	async run(t) {
		await herdr(t);
		const models = join(t.agentDir, "models.json");
		const config = JSON.parse(readFileSync(models, "utf8"));
		config.providers.polygon.models[0].input = ["text", "image"];
		writeFileSync(models, JSON.stringify(config, null, 2));
		fixtureModels(t, "polygon", ["painter"]);
		const image = join(t.repo, "fixture.png");
		writeFileSync(image, Buffer.from(PNG, "base64"));
		t.scripts.painter = { agent: "painter", steps: [
			{ id: "p1", tool: "SendMessage", args: { to: "main", message: "a screenshot", images: [image] } },
			{ id: "p2", text: "sent" },
		] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_start", args: { participants: [{ name: "painter", model: "polygon/painter", profile: "read-only" }] } },
			{ id: "s2", tool: "SendMessage", args: { to: "painter", message: "send a screenshot" } },
			{ id: "s3", text: "waiting" },
		] });
		await eventually(() => notifications(lead.events).some((n) => n.customType === "collaborator-message"), 120_000, "the painter's message");
		await eventually(() => requests(t).some((r) => r.agent === "lead" && r.images >= 1), 30_000, "an image in the lead's request");
		assert.ok(requests(t).filter((r) => r.agent === "lead").every((r) => !r.tools.includes("collaborator_inbox")), "the lead was offered an inbox to poll");
	},
};
