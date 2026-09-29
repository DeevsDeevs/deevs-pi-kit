const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function unicodeTerms(value: string): string[] {
	return [...segmenter.segment(value.normalize("NFKC").toLocaleLowerCase())]
		.filter((part) => part.isWordLike)
		.map((part) => part.segment)
		.filter(Boolean);
}

export function truncateGraphemes(value: string, maximum: number, maximumUtf8Bytes = Number.POSITIVE_INFINITY): string {
	let result = "";
	for (const part of [...graphemeSegmenter.segment(value)].slice(0, Math.max(0, maximum))) {
		if (Buffer.byteLength(result, "utf8") + Buffer.byteLength(part.segment, "utf8") > maximumUtf8Bytes) break;
		result += part.segment;
	}
	return result;
}
