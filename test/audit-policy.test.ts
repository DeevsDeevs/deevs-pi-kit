import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const policy = await import(pathToFileURL(resolve("scripts/audit-policy.mjs")).href) as {
	acceptsKnownPiBraceAdvisory: (items: unknown[], version: string, now?: number) => boolean;
	EXCEPTION_EXPIRES: number;
};

const known = {
	name: "brace-expansion",
	severity: "high",
	isDirect: false,
	nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"],
	via: [{ url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg" }],
};

describe("supply-chain audit exception", () => {
	it("accepts only the exact unexpired upstream shrinkwrap advisory", () => {
		expect(policy.acceptsKnownPiBraceAdvisory([known], "5.0.7", policy.EXCEPTION_EXPIRES - 1)).toBe(true);
		expect(policy.acceptsKnownPiBraceAdvisory([{ ...known, via: [...known.via, { url: "other" }] }], "5.0.7", policy.EXCEPTION_EXPIRES - 1)).toBe(false);
		expect(policy.acceptsKnownPiBraceAdvisory([known], "5.0.8", policy.EXCEPTION_EXPIRES - 1)).toBe(false);
		expect(policy.acceptsKnownPiBraceAdvisory([known], "5.0.7", policy.EXCEPTION_EXPIRES)).toBe(false);
		expect(policy.acceptsKnownPiBraceAdvisory([known, { name: "other" }], "5.0.7", policy.EXCEPTION_EXPIRES - 1)).toBe(false);
	});
});
