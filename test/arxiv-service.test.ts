import { afterEach, describe, expect, it, vi } from "vitest";
import { ArxivService } from "../extensions/arxiv/service.ts";

afterEach(() => vi.unstubAllGlobals());

describe("ArxivService", () => {
	it("does not report truncation when an exactly full page exhausts the result set", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(`
			<feed>
				<opensearch:totalResults>1</opensearch:totalResults>
				<entry>
					<id>https://arxiv.org/abs/1234.5678v1</id>
					<title>Paper</title><summary>Summary</summary>
					<published>2026-01-01T00:00:00Z</published><updated>2026-01-01T00:00:00Z</updated>
					<author><name>Ada Lovelace</name></author>
				</entry>
			</feed>
		`, { status: 200 })));

		const result = await new ArxivService().search({ query: "logic", maxResults: 1 });
		expect(result.papers).toHaveLength(1);
		expect(result.truncated).toBe(false);
	});
});
