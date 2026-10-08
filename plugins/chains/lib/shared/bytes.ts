/** `value` cut to `maxBytes` with a note saying so; the note alone, cut, when it does not fit. */
export function truncateText(value: string, maxBytes: number, label: string) {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
	const suffix = `\n\n[${label} truncated to ${maxBytes} bytes]`;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	return { text: suffixBytes >= maxBytes ? utf8Head(suffix, maxBytes) : `${utf8Head(value, maxBytes - suffixBytes)}${suffix}`, truncated: true };
}

export function utf8Head(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}
