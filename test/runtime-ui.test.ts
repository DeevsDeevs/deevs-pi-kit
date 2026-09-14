import { describe, expect, it } from "vitest";
import { formatDuration, formatUsage, statusGlyph } from "../extensions/shared/runtime-ui.ts";

describe("runtime UI formatting", () => {
	it("formats bounded duration and usage", () => {
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(61_000)).toBe("1m 1s");
		expect(formatDuration(-1)).toBe("—");
		expect(formatUsage(12_345.4, 0.25)).toBe("12,345 tokens · $0.2500");
	});

	it("keeps status meaning outside color", () => {
		expect(statusGlyph("completed")).toBe("✓");
		expect(statusGlyph("failed")).toBe("✗");
		expect(statusGlyph("blocked")).toBe("!");
	});
});
