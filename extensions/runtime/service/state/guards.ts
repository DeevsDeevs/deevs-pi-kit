import { RuntimeError } from "../../errors.ts";
import { MAX_ID_BYTES, PARTICIPANT_NAME } from "../../schemas/common.ts";

export function assertParticipantName(value: string, name: string): void {
	if (!PARTICIPANT_NAME.test(value)) throw new RuntimeError("conflict", `${name} has invalid syntax.`);
}

export function assertStateId(value: string, name: string): void {
	if (!value.trim() || Buffer.byteLength(value) > MAX_ID_BYTES) throw new RuntimeError("conflict", `${name} is invalid.`);
}

export function assertStateTime(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new RuntimeError("conflict", `${name} is invalid.`);
}
