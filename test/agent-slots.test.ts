import { expect, it } from "vitest";
import { agentSlots } from "../extensions/subagents/engine/host.ts";

it("runs CPUs − 2 agents at once, at least 2 and at most 16, as Claude Code does", () => {
	expect([1, 2, 4, 5, 10, 18, 48].map((cpus) => agentSlots(cpus))).toEqual([2, 2, 2, 3, 8, 16, 16]);
});
