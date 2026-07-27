import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChainService } from "../extensions/chains/service.ts";
import { WikiService } from "../extensions/wiki/service.ts";
import { unicodeTerms } from "../extensions/shared/terms.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-kit-language-"));
	roots.push(value);
	return value;
}

describe("language-neutral text surfaces", () => {
	it("segments multilingual terms without English stemming", () => {
		expect(unicodeTerms("検証 система résumé")).toEqual(expect.arrayContaining(["検証", "система", "résumé"]));
	});

	it("stores Chain next-step control as metadata and finds Unicode content", async () => {
		const cwd = root();
		const service = new ChainService(cwd);
		const saved = await service.save({ chain: "検証", title: "多言語の記録", nextStep: "次の確認を実行", content: "# 多言語の記録\n\n任意の見出し\n\nсистема готова" });
		expect(saved.link.nextStep).toBe("次の確認を実行");
		const result = await service.search({ query: "система", mode: "lookup" });
		expect(result.matches[0]?.link.chain).toBe("検証");
	});

	it("keeps Unicode Chain filenames within filesystem byte limits", async () => {
		const service = new ChainService(root());
		const saved = await service.save({ chain: "kit", title: "𐐀".repeat(100), content: "# Long Unicode title" });
		expect(Buffer.byteLength(saved.link.filename, "utf8")).toBeLessThanOrEqual(255);
		expect(saved.link.filename).not.toContain("�");
	});

	it("finds Unicode Wiki terms", async () => {
		const cwd = root();
		const wiki = new WikiService(cwd);
		const path = join(cwd, "wiki");
		await wiki.init({ path, domain: "多言語", dryRun: false });
		writeFileSync(join(path, "concepts", "検索.md"), "---\ntitle: 検索\ncreated: 2026-01-01\nupdated: 2026-01-01\ntype: concept\ntags: [example]\nsources: []\n---\n# 検索\n\nсистема поиска работает\n");
		const result = await wiki.search({ path, query: "поиска", mode: "lookup" });
		expect(result.matches[0]?.page.id).toBe("concepts/検索");
	});
});
