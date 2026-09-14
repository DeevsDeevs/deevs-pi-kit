import { HostedStateConflictError } from "./errors.ts";
import { MAX_ID_BYTES } from "../../schemas/common.ts";

export const PARTICIPANT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export function assertParticipantName(value: string, name: string): void {
	if (!PARTICIPANT_NAME.test(value)) throw new HostedStateConflictError("conflict", `${name} has invalid syntax.`);
}

export function assertStateId(value: string, name: string): void {
	if (!value.trim() || Buffer.byteLength(value) > MAX_ID_BYTES) throw new HostedStateConflictError("conflict", `${name} is invalid.`);
}

export function assertStateTime(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new HostedStateConflictError("conflict", `${name} is invalid.`);
}
