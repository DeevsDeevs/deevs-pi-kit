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

const MAX_QUERY_CHARS = 1000;

export function validateQuery(query: string): string {
	const value = query.trim();
	if (!value) throw new Error("Search query is required.");
	if (value.length > MAX_QUERY_CHARS) throw new Error(`Search query is too long; max ${MAX_QUERY_CHARS} characters.`);
	return value;
}

/** A line test for text (substring) or regex search. */
export function lineMatcher(query: string, regex: boolean, caseSensitive: boolean): (line: string) => boolean {
	if (regex) {
		let pattern: RegExp;
		try {
			pattern = new RegExp(query, caseSensitive ? "" : "i");
		} catch (error) {
			throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
		}
		return (line) => pattern.test(line);
	}
	const needle = caseSensitive ? query : query.toLowerCase();
	return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
}

/** A whole number within [min, max]; anything not finite becomes min. */
export function clampInt(value: number, min: number, max: number): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : min;
}
