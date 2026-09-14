import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { Count, IdText, PathText, boundedText, schemaError } from "./common.ts";
import { isJsonObject, type JsonObject } from "./json.ts";
import { ManagedAgentSessionSchema } from "./session.ts";

const OptionalId = Type.Optional(IdText);

/** Herdr may add fields at any time, so every shape below names only what Runtime reads. */
export const HerdrPaneSchema = Type.Object({ pane_id: IdText, terminal_id: OptionalId, cwd: Type.Optional(PathText) });
export const HerdrTabSchema = Type.Object({ tab_id: IdText, workspace_id: OptionalId, pane_count: Type.Optional(Count) });

export const HerdrTabCreatedSchema = Type.Object({ tab: HerdrTabSchema, root_pane: HerdrPaneSchema });
export const HerdrPaneResultSchema = Type.Object({ pane: HerdrPaneSchema });
export const HerdrTabResultSchema = Type.Object({ tab: HerdrTabSchema });
export const HerdrWorkspaceCreatedSchema = Type.Object({
	workspace: Type.Object({ workspace_id: IdText }),
	tab: HerdrTabSchema,
	root_pane: HerdrPaneSchema,
});

/** What `herdr agent get|list` reports: only the cwd is guaranteed, the rest identifies the owning tab. */
export const HerdrLiveAgentSchema = Type.Object({
	name: OptionalId,
	cwd: PathText,
	tab_id: OptionalId,
	workspace_id: OptionalId,
	agent_session: Type.Optional(ManagedAgentSessionSchema),
});
export const HerdrLiveAgentResultSchema = Type.Object({ agent: HerdrLiveAgentSchema });
export const HerdrLiveAgentListSchema = Type.Object({ agents: Type.Array(HerdrLiveAgentSchema) });

/** What `herdr agent start` reports: a complete identity, because the launch is only accepted if it matches. */
export const HerdrStartedAgentSchema = Type.Object({
	agent: Type.Object({
		name: IdText,
		agent: boundedText(64),
		pane_id: IdText,
		terminal_id: IdText,
		agent_status: Type.Union([
			Type.Literal("idle"),
			Type.Literal("working"),
			Type.Literal("blocked"),
			Type.Literal("done"),
			Type.Literal("unknown"),
		]),
		focused: Type.Boolean(),
		agent_session: Type.Optional(ManagedAgentSessionSchema),
	}),
});

export type HerdrLiveAgent = Static<typeof HerdrLiveAgentSchema>;
export type HerdrStartedAgent = Static<typeof HerdrStartedAgentSchema>["agent"];

/** Every Herdr CLI command answers `{result: …}`; the envelope itself carries nothing else Runtime reads. */
export function herdrResult(stdout: string): JsonObject {
	const response: unknown = JSON.parse(stdout);
	// SAFETY: Herdr CLI output is untrusted JSON, proven to be a result envelope before any field is read.
	const envelope = response as JsonObject | undefined;
	if (!isJsonObject(envelope) || !isJsonObject(envelope.result)) throw new Error("Herdr response is not a result envelope.");
	return envelope.result;
}

export function decodeHerdr<Schema extends TSchema>(schema: Schema, value: JsonObject, subject: string): Static<Schema> {
	if (!Value.Check(schema, value)) throw schemaError(schema, value, subject);
	return value;
}
