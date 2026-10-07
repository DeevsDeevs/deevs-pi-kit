---
name: workflow-authoring
description: The Workflow script API, its pitfalls, resume, and quality patterns. Read it before writing a script for a workflow you may already run; it grants no permission to run one.
---

# Writing Workflow scripts

A workflow puts structure around many agents: coverage (split the work and do the parts side by side), confidence (independent views and adversarial checks before you commit to an answer), or scale no single context holds (migrations, audits, wide sweeps). Scout first: look around yourself (list the files, read the diff) until you know the work list, then hand that list to a workflow.

Keep each workflow one well-scoped fan-out: **understand** (readers per subsystem, merged into one map), **design** (independent proposals, scored by judges), **review** (a finder per dimension, then adversarial checks of each finding), **research** (searches from different angles, deep reads, a synthesis), **migrate** (find every site, change each in a worktree, verify each). For bigger jobs run several in turn and read each result before choosing the next.

**Autonomy.** While a system-reminder says autonomy is on, the user has opted in for the session: start agents and workflows without asking. Work directly on single-file or short fixes, and verify them yourself. Orchestrate when the work splits into independent parts taking minutes each, or when the user asks for, or a large multi-file change needs, an independent review. Never write a one-agent workflow: one part is an Agent call. Make any deliverable the task names (a file or binary at a path, a commit, a branch) work first, committed when it is a commit, before you orchestrate work on it: later phases improve it instead of creating it at the end. Multi-phase work (map, design, build, review) often takes one workflow per phase so you can steer between them. When a reminder says autonomy is off, the Workflow tool's own opt-in rule applies again.

## Calling the tool

Send the script inline as `script`. Each call saves the script and returns its path; to change a run, edit that file and call `Workflow({scriptPath})`. `name` runs `.pi/workflows/<name>.js` in a trusted project, or `~/.pi/agent/workflows/<name>.js`. `args` reaches the script as the global `args`; a string that starts with `{` or `[` is parsed as JSON.

The script opens with the meta block, a plain literal (no variables, calls, spreads or `${}`):

```js
export const meta = {
  name: 'dead-flags',
  description: 'Find feature flags nobody reads and draft their removal',   // one line, shown in the widget
  phases: [{ title: 'Scan', detail: 'one reader per package' }, { title: 'Draft' }],
}
phase('Scan')
const found = await agent('List the feature flags defined in packages/billing and where each is read.', { schema: FLAGS })
```

`name` and `description` are required; `whenToUse` and `phases` are optional. Phase titles must equal the strings passed to `phase()` or `opts.phase`.

## Script API

- `agent(prompt, opts?)` resolves to the agent's final text. With `opts.schema` (a JSON Schema whose root is `{type: 'object', properties}`, `required` naming only listed properties) the agent answers through a StructuredOutput tool and `agent()` resolves to the validated object. It resolves to `null` when the agent fails, so filter with `.filter(Boolean)`. It throws on an invalid schema, when the agent never produces valid structured output, and on an unknown `agentType`. Options:
  - `label`: the name shown in progress.
  - `phase`: the progress group. Inside `parallel()` and `pipeline()` set it here; `phase()` is shared state and races.
  - `model`: leave it out to run the lead's model and level, which is almost always right. Otherwise a configured name (`astra`, `luna`, `opus`, `haiku`) or `provider/id`. A `claude:` or `codex:` name runs Claude Code or Codex.
  - `effort`: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`; `low` for mechanical stages, the top levels only for the hardest judging.
  - `isolation: 'worktree'`: its own git worktree on branch `agent/<id>`, for agents that edit in parallel. An unchanged one is removed; a changed one is kept and logged.
  - `agentType`: an Agent tool type (`general-purpose`, `Explore`, `Plan`, `reviewer`, ...) instead of the default workflow agent.
  - `cwd`: the agent's directory, for one repository inside a multi-repo folder.
  - Any other key is ignored and logged.
- `pipeline(items, ...stages)` moves each item through every stage on its own; each stage gets `(previous, item, index)`. A stage that throws or returns `null` ends that item as `null`. It never rejects.
- `parallel(thunks)` takes functions (`() => agent(...)`), not promises, and waits for all. A thunk that throws becomes `null`; it never rejects.
- `phase(title)` starts a progress group; `log(message)` and `console.log` print a narrator line.
- `args` is a copy of the tool's `args`. `budget.remaining()` is `Infinity`: there is no token target.
- `workflow()` is not available: inline the other script. `setTimeout` and `clearTimeout` work.

## What agents get

- The final text is `agent()`'s return value, data for the script, so agents answer with raw data. Use `schema` when you need fields.
- Agents load the project's AGENTS.md and CLAUDE.md and the skills; do not copy their rules into prompts.
- Agents have `read`, `grep`, `find`, `ls`, `bash`, `edit` and `write`, no MCP tools, and cannot start agents or ask the user. Write READ-ONLY into a stage that must only look.

## Determinism

Scripts are plain JavaScript; type annotations do not parse. The body is an async function: `await` and `return` work at the top level. `Date.now()`, `Math.random()` and argless `new Date()` throw, because a resumed run must replay the same calls: pass times in through `args` and vary prompts by index. Scripts have no filesystem or Node access.

## Pipeline first

Use `pipeline()` unless a later stage needs the whole earlier result set; a barrier makes every fast item wait for the slowest. A barrier is right only to dedupe or merge across all findings before costly follow-up, to skip the rest when the total is zero, or when a prompt compares one item with all others. A flatten, map or filter is not a reason: do it inside a stage (`pipeline(items, find, r => r.issues, verifyAll)`).

```js
// Wrong: the middle step needs no barrier.
const a = await parallel(items.map(i => () => agent(...)))
const c = await parallel(a.filter(Boolean).flatMap(r => r.issues).map(x => () => agent(...)))
// Right: dedupe needs every result before an expensive check.
const rounds = await parallel(LENSES.map(l => () => agent(l.prompt, { schema: ISSUES })))
const unique = uniqueByLocation(rounds.filter(Boolean).flatMap(r => r.issues))
const checked = await parallel(unique.map(i => () => agent(checkPrompt(i), { schema: VERDICT })))
```

## Scale

At most 16 agents run at once across this Pi; the rest queue. Nothing limits how many a run starts, so give every loop an exit. Exhaustive review, until two rounds find nothing new:

```js
const seen = new Set(), kept = []
let quiet = 0
while (quiet < 2) {
  const found = (await parallel(FINDERS.map(f => () => agent(f.prompt, { phase: 'Find', schema: ISSUES })))).filter(Boolean).flatMap(b => b.issues)
  const fresh = found.filter(i => !seen.has(keyOf(i)))
  if (fresh.length === 0) { quiet++; continue }
  quiet = 0
  fresh.forEach(i => seen.add(keyOf(i)))
  const judged = await parallel(fresh.map(i => () =>
    parallel(['correctness', 'security', 'reproduction'].map(lens => () =>
      agent(`Is "${i.summary}" a real problem? Judge it only through ${lens}.`, { phase: 'Judge', schema: VERDICT })))
      .then(verdicts => ({ i, votes: verdicts.filter(v => v?.real).length }))))
  kept.push(...judged.filter(j => j.votes >= 2).map(j => j.i))
}
return kept
```

Dedupe against `seen`, not `kept`, or rejected findings return every round and the loop never ends.

## Quality patterns

- **Adversarial check**: several skeptics per claim, told to refute it and to say refuted when unsure; keep it only if most fail.
- **Lens panel**: give each checker a different lens (correctness, security, performance, reproduction) instead of repeating one check.
- **Judge panel**: attempts from different starting points scored by independent judges; build on the winner.
- **Loop until quiet**: for discovery of unknown size, run finders until K rounds add nothing.
- **Search angles**: agents that search by location, content, owner or time each find what the others miss.
- **Gap critic**: a last agent asks what is missing; its answer is the next round.
- **Say what you dropped**: when the script samples or keeps a top N, `log()` what it left out.

Size the run to the request: "any bugs?" wants a few finders and one check each; "audit this thoroughly" wants a wide finder pool, three to five skeptics per finding and a synthesis.

## Resume and recovery

A run survives `/reload`, pauses when Pi exits, and continues when its session reopens; it notifies once. To rerun after an edit, a stop or a failure, call `Workflow({scriptPath, resumeFromRunId})` in the same session, after stopping the old run with `TaskStop` if it still runs. The longest unchanged prefix of `agent()` calls replays from the journal; the first changed, new or failed call and everything after it run live.

Before you explain an empty or odd result, read `journal.jsonl` in the run's directory: it records what each agent returned.
