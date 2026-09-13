import { defineConfig } from "vitest/config";

// ponytail: .claude/worktrees holds sibling git worktrees for other in-flight
// workflows; vitest's default glob has no repo boundary and picks up their
// test files too, so scope discovery to this repo's own test/ directory.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
