export function utf8Head(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

export function utf8Tail(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBytes) return value;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}
