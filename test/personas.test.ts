import { describe, expect, it } from "vitest";
import { findAgent, loadBuiltinAgents } from "../extensions/subagents/agents.ts";

const expectedAgents = [
  "anti-slop",
  "architect",
  "cpp-dev",
  "devops",
  "explorer",
  "logic-hunter",
  "python-dev",
  "reviewer",
  "rust-dev",
  "tester",
];

describe("built-in personas", () => {
  it("loads the curated catalog deterministically", () => {
    const agents = loadBuiltinAgents();

    expect(agents.map((agent) => agent.name)).toEqual(expectedAgents);
    expect(agents.every((agent) => agent.body.length > 0)).toBe(true);
    expect(agents.every((agent) => agent.tags.length > 0)).toBe(true);
  });

  it("keeps advisory personas read-only by default", () => {
    for (const agent of loadBuiltinAgents()) {
      expect(agent.mode).toBe("advisory");
      expect(agent.write).toBe(false);
      expect(agent.tools).not.toContain("edit");
      expect(agent.tools).not.toContain("write");
      expect(agent.tools).not.toContain("bash");
      expect(agent.tools).toEqual(expect.arrayContaining(["safe_read", "safe_list", "safe_search"]));
    }
  });

  it("finds names case-insensitively", () => {
    expect(findAgent(loadBuiltinAgents(), " Reviewer ")?.name).toBe("reviewer");
  });
});
