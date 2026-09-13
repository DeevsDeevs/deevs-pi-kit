export const MAX_ID_BYTES = 200;
export const MAX_PATH_BYTES = 8 * 1024;
export const MAX_SUMMARY_BYTES = 2 * 1024;
export const MAX_STATE_RECORDS = 10_000;

const HASH = /^[0-9a-f]{64}$/;

export type PersistedStateValue = null | boolean | number | string | PersistedStateValue[] | PersistedStateFields;

export interface PersistedStateFields {
	[field: string]: PersistedStateValue | undefined;
}

export function mapValues<T>(
	value: PersistedStateValue | undefined,
	name: string,
	validate: (item: PersistedStateValue | undefined, key: string) => T,
	max = MAX_STATE_RECORDS,
): Record<string, T> {
	const record = strictObject(value, name);
	const entries = Object.entries(record);
	if (entries.length > max) throw new Error(`${name} exceeds ${max} entries`);
	return Object.fromEntries(entries.map(([key, item]) => [key, validate(item, key)]));
}

export function mapStrings(value: PersistedStateValue | undefined, name: string): Record<string, string> {
	const record = strictObject(value, name);
	if (Object.keys(record).length > MAX_STATE_RECORDS) throw new Error(`${name} exceeds ${MAX_STATE_RECORDS} entries`);
	const entries = Object.entries(record)
		.map(([key, item]) => [text(key, `${name} key`, MAX_PATH_BYTES), text(item, `${name} value`, MAX_ID_BYTES)]);
	return Object.fromEntries(entries);
}

export function strictObject<Source>(value: Source, name: string, allowed?: readonly string[]): PersistedStateFields {
	if (value === null || value === undefined || Array.isArray(value) || Object(value) !== value) throw new Error(`${name} must be an object`);
	const record: PersistedStateFields = Object.fromEntries(Object.entries(Object(value)));
	if (allowed) for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}`);
	return record;
}

export function enumValue<const Value extends string>(
	value: PersistedStateValue | undefined,
	allowed: readonly Value[],
	message: string,
): Value {
	const parsed = allowed.find((candidate) => candidate === value);
	if (parsed === undefined) throw new Error(message);
	return parsed;
}

export function stringArray(value: PersistedStateValue | undefined, name: string, max: number): string[] {
	if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must contain at most ${max} values`);
	return value.map((item) => text(item, name, MAX_ID_BYTES));
}

export function text(value: PersistedStateValue | undefined, name: string, maxBytes: number): string {
	const result = stringValue(value, name, maxBytes);
	if (!result.trim()) throw new Error(`${name} must not be empty`);
	return result;
}

export function stringValue(value: PersistedStateValue | undefined, name: string, maxBytes: number): string {
	if (!isPersistedString(value) || Buffer.byteLength(value) > maxBytes) {
		throw new Error(`${name} must be a string of at most ${maxBytes} bytes`);
	}
	return value;
}

export function hash(value: PersistedStateValue | undefined, name: string): string {
	const result = text(value, name, 64);
	if (!HASH.test(result)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
	return result;
}

export function integer(value: PersistedStateValue | undefined, name: string): number {
	if (!isPersistedNumber(value) || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

export function nonNegativeNumber(value: PersistedStateValue | undefined, name: string): number {
	if (!isPersistedNumber(value) || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
	return value;
}

export function boolean(value: PersistedStateValue | undefined, name: string): boolean {
	if (value !== true && value !== false) throw new Error(`${name} must be a boolean`);
	return value;
}

function isPersistedString(value: PersistedStateValue | undefined): value is string {
	return value === String(value);
}

function isPersistedNumber(value: PersistedStateValue | undefined): value is number {
	return value === Number(value);
}
