import { describe, expect, it } from "vitest";
import { utf8Head } from "../extensions/shared/bytes.ts";

describe("UTF-8 byte truncation", () => {
	it("keeps a valid code-point boundary", () => {
		expect(utf8Head("a🙂b", 5)).toBe("a🙂");
		expect(utf8Head("🙂b", 3)).toBe("");
	});
});
