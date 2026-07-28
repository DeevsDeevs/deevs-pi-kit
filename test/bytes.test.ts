import { describe, expect, it } from "vitest";
import { utf8Head, utf8Tail } from "../extensions/shared/bytes.ts";

describe("UTF-8 byte truncation", () => {
	it("keeps valid code-point boundaries from either side", () => {
		expect(utf8Head("a🙂b", 5)).toBe("a🙂");
		expect(utf8Head("🙂b", 3)).toBe("");
		expect(utf8Tail("a🙂b", 5)).toBe("🙂b");
		expect(utf8Tail("a🙂", 3)).toBe("");
	});
});
