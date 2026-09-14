/** The JSON every Runtime boundary carries: an RPC result, a Herdr CLI response, a persisted session entry. */
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue | undefined;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	if (value === null || value === undefined || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

export function isJsonString(value: JsonValue | undefined): value is string {
	try { return String.prototype.valueOf.call(value) === value; } catch { return false; }
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
	try { return Number.prototype.valueOf.call(value) === value; } catch { return false; }
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
	try { return Boolean.prototype.valueOf.call(value) === value; } catch { return false; }
}
