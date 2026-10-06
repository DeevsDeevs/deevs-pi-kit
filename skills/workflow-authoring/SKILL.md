---
name: workflow-authoring
description: How to write a Workflow script - the script API and its pitfalls, resuming a run, and quality patterns with examples. Read it before you write a script for a workflow you are already allowed to run; reading it grants no permission to run one.
---

# Writing Workflow scripts

A workflow puts structure around many agents. Use it for coverage (split the work and do the parts side by side), for confidence (independent views and adversarial checks before you commit to an answer), or for scale that no single context holds (migrations, audits, wide sweeps). The script says what fans out, what gets checked, and what gets merged.

The shape you want is usually **scout, then fan out**: look around yourself first (list the files, read the diff, find the modules) until you know the work list, then hand that list to a workflow. You need the shape only for the orchestration step, not before you start the task.

Single-phase workflows you can chain over several turns:
- **Understand**: readers over each subsystem, merged into one structured map.
- **Design**: several independent proposals, scored by judges, merged around the winner.
- **Review**: one finder per dimension, then adversarial checks of each finding.
- **Research**: searches from different angles, deep reads of what they surface, a synthesis.
- **Migrate**: find every site, change each one (in a worktree), verify each change.

For bigger jobs run them one after another and read each result before choosing the next. Every workflow stays one well-scoped fan-out, and you decide between them.

**Autonomy.** When a system-reminder says autonomy is on, the user has opted in for the whole session: give each substantive task a workflow until a reminder says otherwise. Aim for the most complete and best-verified answer; token cost is not the constraint. Work with several phases, such as mapping the code, choosing a design, building it and reviewing it, often takes one workflow per phase so you can steer between them. Prefer orchestrating and adversarially checking your conclusions over working alone, except for trivial work or results someone already checked. Answer directly only for conversation and small mechanical edits. When a reminder says autonomy is off, the Workflow tool's own opt-in rule applies again.

## Calling the tool

Send the script inline as `script`; there is no need to save it to a file beforehand. Each call saves the script and returns its path. To change a run, edit that file with `edit` or `write` and call `Workflow({scriptPath})` instead of sending the script again. `name` runs a saved script from `.pi/workflows/<name>.js` or `~/.pi/agent/workflows/<name>.js`. `args` reaches the script as the global `args`: pass real JSON values; a string that starts with `{` or `[` is parsed as JSON, any other string arrives as is.

The script must open with the meta block:

```js
export const meta = {
  name: 'dead-flags',
  description: 'Find feature flags nobody reads and draft their removal',   // one line, shown in the workflow widget
  phases: [
    { title: 'Scan', detail: 'one reader per package' },
    { title: 'Draft', detail: 'one agent per dead flag' },
  ],
}
phase('Scan')
const found = await agent('List the feature flags defined in packages/billing and where each is read.', { schema: FLAGS })
```

`meta` is a plain literal: no variables, calls, spreads or `${}` inside it. `name` and `description` are required; `whenToUse` and `phases` are optional. Phase titles must equal the strings you pass to `phase()` or to `opts.phase`; a title missing from `meta.phases` still gets its own group. A phase entry may carry `model` when that phase runs on another model.

## Script API

- `agent(prompt, opts?)` starts an agent and resolves to its final text. With `opts.schema` (a JSON Schema whose root is `{type: 'object', properties}`, with `required` naming only listed properties) the agent must answer through a StructuredOutput tool, and `agent()` resolves to the validated object; you never parse text. It resolves to `null` when the agent is skipped or fails for good after retries, so filter results with `.filter(Boolean)`. It throws on an invalid schema, when the agent never produces valid structured output, and on an unknown `agentType`. Options:
  - `label`: the name shown in progress.
  - `phase`: the progress group for this call. Inside `parallel()` and `pipeline()` set it here rather than calling `phase()`, which is shared state and races.
  - `model`: leave it out, and the agent runs the lead's model and thinking level, which is almost always right. Set it only when you are sure another tier fits: a configured name such as `astra`, `luna`, `opus` or `haiku`, or `provider/id`.
  - `effort`: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Leave it out to inherit; `low` for cheap mechanical stages, the top levels only for the hardest judging.
  - `isolation: 'worktree'`: the agent works in its own git worktree on branch `agent/<id>`. It costs setup time and disk per agent, so use it only when agents edit files in parallel and would collide. An unchanged worktree is removed; a changed one is kept and logged with its path and branch.
  - `agentType`: one of the Agent tool's types (`general-purpose`, `Explore`, `Plan`, `reviewer`, ...) instead of the default workflow agent. It works with `schema`.
  - `cwd`: the directory the agent works in, for one repository inside a multi-repo folder.
  - Any other key is ignored and logged as `[label] ignored option '<key>'`.
- `pipeline(items, ...stages)` moves each item through every stage on its own, with no wait between stages, so a fast item can reach the last stage while a slow one is still in the first. Each stage gets `(previous, item, index)`. A stage that throws or returns `null` ends that item as `null`. It never rejects. Reach for it first whenever work has several stages.
- `parallel(thunks)` takes functions (`() => agent(...)`), not promises, runs them all and waits for every one. A thunk that throws becomes `null` and the call never rejects. It is a barrier: use it only when you need all results at once.
- `phase(title)` starts a progress group. `log(message)` and `console.log` print a narrator line.
- `args` is a copy of the tool's `args`, or `undefined`.
- `budget` is `{total, spent(), remaining()}`. `total` is `null` unless the user set a token target such as "+500k"; then `remaining()` counts down and `agent()` throws once it reaches zero. Without a target `remaining()` is `Infinity`.
- `workflow()` is not available: inline the other script's body instead.
- `setTimeout` and `clearTimeout` work and are cleared when the run stops.

## What agents get

- An agent's final text is the value `agent()` returns, not a message to a person, so agents answer with raw data. Use `schema` when you need fields.
- Agents load the project's AGENTS.md and CLAUDE.md files and the skills, as you did. Do not tell them to read those again or copy their rules into prompts; name the one rule a stage needs, if any.
- Agents have `read`, `grep`, `find`, `ls`, `bash`, `edit` and `write`, and no MCP tools. They cannot start agents or workflows or ask the user anything.
- Agents can edit files. When a stage must only look, write READ-ONLY into its prompt, and give parallel writers `isolation: 'worktree'`.

## Language and determinism

Scripts are plain JavaScript. Type annotations, interfaces and generics do not parse. The body runs as an async function: use `await` and `return` at the top level. Standard built-ins work, but `Date.now()`, `Math.random()` and `new Date()` without arguments throw, because a resumed run must replay the same calls: pass times in through `args`, stamp results after the run, and vary prompts or labels by index instead of drawing random numbers. Scripts have no filesystem or Node access; they reach the world only through agents.

## Pipeline first

Reach for `pipeline()` unless a later stage needs the whole earlier result set. A barrier is right only when:
- you dedupe or merge across all findings before costly follow-up work;
- you skip the rest when the total is zero ("no findings, no verification");
- a prompt compares one item against all the others.

It is not justified by a flatten, map or filter (do that inside a stage: `pipeline(items, find, r => r.issues, verifyAll)`), by stages that feel separate, or by tidier code: a barrier makes every fast item wait for the slowest.

Warning sign:

```js
const a = await parallel(items.map(i => () => agent(...)))
const b = a.filter(Boolean).flatMap(r => r.issues)   // no cross-item need
const c = await parallel(b.map(x => () => agent(...)))
```

The middle step needs no barrier; make it a pipeline stage.

A barrier that earns its place, deduping before an expensive check:

```js
const rounds = await parallel(LENSES.map(l => () => agent(l.prompt, { schema: ISSUES })))
const unique = uniqueByLocation(rounds.filter(Boolean).flatMap(r => r.issues))   // needs every result
const checked = await parallel(unique.map(i => () => agent(checkPrompt(i), { schema: VERDICT })))
```

## Scale

At most 16 agents run at once across this Pi, workflows and `Agent` together; the rest wait in a queue and start as slots free. There is no limit on how many agents a run starts or how many items one `parallel()` or `pipeline()` takes, so a runaway loop is your bug to prevent: give every loop an exit.

Loop until a count:

```js
const cases = []
while (cases.length < 12) {
  const r = await agent(`Write a failing edge case for parseDuration not in: ${cases.map(c => c.name).join(', ')}`, { schema: CASES })
  cases.push(...r.cases)
  log(`${cases.length}/12 edge cases`)
}
```

Loop until the budget runs low. Check `budget.total` first: without a target the loop would never end.

```js
const notes = []
while (budget.total && budget.remaining() > 40_000) {
  notes.push(await agent(`Summarize module ${notes.length + 1} of MODULES (READ-ONLY)`, { schema: NOTE }))
}
```

Exhaustive review, composed: finders, dedupe against everything seen, a panel of lenses per finding, until two rounds find nothing new.

```js
const seen = new Set(), kept = []
let quiet = 0
while (quiet < 2) {
  const batches = await parallel(FINDERS.map(f => () => agent(f.prompt, { phase: 'Find', schema: ISSUES })))
  const found = batches.filter(Boolean).flatMap(b => b.issues)
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

Dedupe against `seen`, not against `kept`: otherwise rejected findings come back every round and the loop never ends.

## Quality patterns

Combine them as the task needs.
- **Adversarial check**: several independent skeptics per claim, each told to refute it and to say refuted when unsure. Keep the claim only if most fail to refute it.
- **Lens panel**: when a claim can fail in several ways, give each checker a different lens (correctness, security, performance, does it reproduce) rather than repeating the same check.
- **Judge panel**: several attempts from different starting points (smallest change first, risk first, user first), scored by independent judges; build on the winner and borrow the best of the rest. Use it when there are many reasonable solutions.
- **Loop until quiet**: for discovery of unknown size, keep running finders until K rounds in a row add nothing. A fixed count misses the tail.
- **Several search angles**: agents that each search differently (by location, by content, by owner, by time); each finds what the others cannot.
- **Gap critic**: a last agent that asks what is missing (an angle not tried, a claim not checked, a source not read); its answer is the next round.
- **Say what you dropped**: when the script samples, keeps a top N or skips retries, `log()` what it left out. A silent cut reads as full coverage.

Size the run to the request: "any bugs?" wants a few finders and one check each; "audit this thoroughly" wants a wide finder pool, three to five skeptics per finding and a synthesis stage. When unsure, lean thorough for research, review and audits, and brief for quick checks. Invent other shapes (brackets, repair loops, staged escalation) when they fit; use a workflow whenever the control flow (loops, branches, fan-out) should be code rather than your judgment turn by turn.

## Resume and recovery

A run survives `/reload`; when Pi exits it pauses, and it continues by itself when its session reopens. Its notification arrives once. To rerun after an edit, a stop or a failure, call `Workflow({scriptPath, resumeFromRunId})` with the run id from the launch result, in the same session, after stopping the old run with `TaskStop` if it is still going. The longest unchanged prefix of `agent()` calls replays from the journal; the first changed or new call and everything after it run live, so the same script and `args` replay completely. Agents that failed (`null`, for example on a usage limit) run again on resume.

Before you explain an empty or odd result, read `journal.jsonl` in the run's directory: it records what each agent actually returned, and a cached result can itself be empty.
