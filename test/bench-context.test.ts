import { expect, it } from "vitest";
import { budgetViolations, measure, readBudget } from "../bench/context.mjs";

it("keeps every static context surface inside its byte ceiling", async () => {
	expect(budgetViolations(await measure(), readBudget())).toEqual([]);
});
