import { Type, type TRecordAction, type TRefineAdd, type TSchema, type TString } from "typebox";
import { Value } from "typebox/value";

export const HOSTED_PROTOCOL_VERSION = 1 as const;
export const HOSTED_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const HOSTED_ACK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** Delivered mail has no reader after a day; its ids stay in the sender's operation map for retries. */
export const HOSTED_READ_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** When a write would cross the state cap, read mail older than this is evicted before the write is refused. */
export const HOSTED_PRESSURE_READ_GRACE_MS = 60 * 60 * 1_000;
export const HOSTED_MAILBOX_MAX_BODY_BYTES = 16 * 1024;
export const HOSTED_MAX_STATE_RECORDS = 10_000;

export const MAX_ID_BYTES = 200;
const MAX_PATH_BYTES = 8 * 1024;
const MAX_SUMMARY_BYTES = 2 * 1024;

export const STRICT_OBJECT = { additionalProperties: false } as const;

/** JSON Schema `maxLength` counts UTF-16 units, so every byte budget needs its own refinement. */
export function boundedText(maxBytes: number): TRefineAdd<TString> {
	return Type.Refine(
		Type.String({ minLength: 1, maxLength: maxBytes }),
		(value: string) => Buffer.byteLength(value) <= maxBytes,
		() => `must be at most ${maxBytes} UTF-8 bytes`,
	);
}

/** The one syntax for every collaborator name, Herdr agent name and driver-owned model in the package. */
export const PARTICIPANT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
export const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const COLLABORATOR_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/*:[\]-]{0,199}$/;

export const IdText = boundedText(MAX_ID_BYTES);
export const PathText = boundedText(MAX_PATH_BYTES);
export const HashText = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const ParticipantNameText = Type.String({ pattern: PARTICIPANT_NAME.source });
export const AgentNameText = Type.String({ pattern: AGENT_NAME.source });
export const ModelText = Type.String({ pattern: COLLABORATOR_MODEL.source });
export const SummaryText = Type.Refine(
	Type.String({ maxLength: MAX_SUMMARY_BYTES }),
	(value: string) => Buffer.byteLength(value) <= MAX_SUMMARY_BYTES,
	() => `must be at most ${MAX_SUMMARY_BYTES} UTF-8 bytes`,
);

export const Timestamp = Type.Number({ minimum: 0, maximum: Number.MAX_VALUE });
export const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const Sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export function keyedRecord<Value extends TSchema>(
	value: Value,
	maxProperties = HOSTED_MAX_STATE_RECORDS,
): TRecordAction<TString, Value> {
	return Type.Record(Type.String(), value, { maxProperties });
}

export function schemaError<Source>(schema: TSchema, value: Source, subject: string): Error {
	const [first] = Value.Errors(schema, value);
	if (!first) return new Error(`${subject} is invalid.`);
	return new Error(`${subject} is invalid at ${first.instancePath || "/"}: ${first.message} ${JSON.stringify(first.params)}`);
}
