import { describe, expect, it } from "vitest";
import { loadBuiltinAgents } from "../extensions/subagents/agents.ts";

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
    expect(agents.find((agent) => agent.name === "tester")?.body).not.toContain("run targeted validation commands through bash");
  });

  it("keeps personas read-only: every Pi tool but edit and write", () => {
    for (const agent of loadBuiltinAgents()) expect(agent.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
  });
});
