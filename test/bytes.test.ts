import { describe, expect, it } from "vitest";
import { truncateText, utf8Head } from "../extensions/shared/bytes.ts";
import { snippet } from "../extensions/shared/terms.ts";

describe("UTF-8 byte truncation", () => {
	it("keeps a valid code-point boundary", () => {
		expect(utf8Head("a🙂b", 5)).toBe("a🙂");
		expect(utf8Head("🙂b", 3)).toBe("");
	});

	it("labels a cut text and never exceeds the budget", () => {
		expect(truncateText("short", 10, "page")).toEqual({ text: "short", truncated: false });
		expect(truncateText("x".repeat(100), 40, "page")).toEqual({ text: `${"x".repeat(10)}\n\n[page truncated to 40 bytes]`, truncated: true });
		expect(truncateText("x".repeat(100), 10, "page")).toEqual({ text: "\n\n[page tr", truncated: true });
	});
});

describe("snippet", () => {
	it("numbers the lines around a match from 1, clipped to the text", () => {
		expect(snippet(["a", "b", "c", "d"], 0, 1)).toBe("1: a\n2: b");
		expect(snippet(["a", "b", "c", "d"], 3, 2)).toBe("2: b\n3: c\n4: d");
	});
});
