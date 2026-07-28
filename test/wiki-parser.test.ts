import { describe, expect, it } from "vitest";
import { parseTaxonomyTags } from "../extensions/wiki/parser.ts";

describe("wiki parser", () => {
	it("reads every tag in the taxonomy section without stopping at the first line", () => {
		const schema = `# Schema

## Tag Taxonomy
- e2e: live evidence
- runtime: runtime lifecycle
- \`ownership\` — exact ownership
- validation

## Page Thresholds
- unrelated
`;
		expect([...parseTaxonomyTags(schema)!]).toEqual(["e2e", "runtime", "ownership", "validation"]);
	});
});
