# Polygon

End-to-end scenarios that run the real binaries (Pi in `--mode rpc`, `claude`, `codex`, Herdr) against the kit as it will be installed, inside a rootless Podman container. A scripted local model, the puppet, stands in for real models. Assertions are structural only: events, tool calls, dialogs, session entries, the puppet's request log, git state and a `/proc` census. Model prose is never read.

```bash
npm run polygon                          # every non-slow scenario on the puppet
npm run polygon -- --only modes,jobs-basic
npm run polygon -- --gate M0 --slow      # a milestone gate, slow scenarios included
npm run polygon -- --kit clone           # git clone --local HEAD + npm install --omit=dev --legacy-peer-deps, as Pi installs it
npm run polygon -- --kit installed       # the checkout `pi update` produced, read-only
npm run polygon -- --pi 1.0.1            # another Pi release than devDependencies pins
npm run polygon -- --pi-runtime node     # Pi from npm on Node instead of the Bun release binary
npm run polygon -- --list
```

Scenarios run up to twelve at a time (a quarter of the CPUs; four on `--live`); those marked `timing: true` bound latency and run alone afterwards, so a bound measures the kit rather than the load. Results land in `polygon/results/<run>/` (`latest` points at the newest): `summary.json` (with the image's exact `pi`, `claude`, `codex` and `herdr` versions), and per scenario `result.json`, `events.jsonl` (the RPC lead), `requests.jsonl` (the puppet), `pi-stderr.log` and the sandbox `home/` and `repo/`. On red, read `polygon/results/latest/<name>/` before changing code. The exit code is non-zero on any failure.

## Sandbox

`Containerfile` holds Node 24, git, python3, tini, ripgrep, fd, the latest Claude Code and Codex, Herdr's official static release binary checked against its published SHA-256, and Pi at the kit's devDependencies version as its Bun-compiled release binary (`pi-linux-x64.tar.gz`, checked against the release's `SHA256SUMS`), the build users run. `--pi-runtime node` installs Pi from npm and runs it on Node instead, for comparison; `durable-load` asserts which runtime, and so which SQLite driver, the engine got. The image tag is a hash of the Containerfile and build args, built only when missing; `podman image rm` it to pick up newer Claude or Codex releases. `test/fixtures/cli/` holds Claude and Codex output recorded on the versions in its `versions.json`; when the image runs others, a run that includes `claude-worker` or `codex-worker` fails with a `cli-fixtures` row until you copy their new outputs there and update `versions.json`.

One container runs per polygon run, with `--network=none` (loopback only) unless `--live`; `--kit clone` installs its dependencies in a separate container first. The kit is mounted read-only at `/kit` (a symlinked `node_modules` is mounted at its real path), `polygon/` at `/polygon`, and the run's results at `/results`. Each scenario gets its own `HOME` under `/results/<name>/home`, with Pi, Claude and Codex config dirs inside it, an env built from scratch, a git identity, and a `POLYGON_RUN` tag. Teardown closes the drivers, then SIGKILLs every process still carrying the tag; any such process fails the scenario.

## The puppet

One HTTP server per scenario: `/v1/chat/completions` for Pi's `polygon/puppet` provider (`models.json`), `/v1/messages` for Claude (`ANTHROPIC_BASE_URL`) and Pi's built-in `anthropic` (its `baseUrl` repointed), `/v1/responses` for Codex (a `model_providers` entry), and `/codex/responses` for Pi's built-in `openai-codex` (its `baseUrl` repointed in `models.json`, a fake ChatGPT OAuth token in `auth.json`, the SSE transport). The first user message `POLYGON {json}` is the script:

```json
{ "agent": "lead", "steps": [
  { "id": "s1", "tool": "job_start", "args": { "command": "echo ok", "description": "probe" } },
  { "id": "s2", "tool": "read", "args": { "path": "$/[^ ]*/out/b[0-9a-z]{8}\\.log/" } },
  { "id": "s3", "on": "ok", "text": "done" }
] }
```

The next step is the first one not yet said in the transcript whose `on` (if any) appears after the last assistant message, so `kill -9`, resume and child processes need no server state. A string arg `"$/re/"` becomes the last match of `re` in the transcript. A step's `usage` sets its reported prompt tokens (context-pressure tests). A `schema: "auto"` step calls `StructuredOutput` with the smallest value its schema accepts when the request offers that tool, and replies as text otherwise. Every model request is appended to `requests.jsonl` with its agent, step, model, tools offered, message and image counts, `service_tier`, and `marks`: the strings a scenario pushed onto `t.marks` that the raw request contains (a system-prompt section tag, a persona line, a skill name).

## Adding a scenario

Drop `polygon/scenarios/<name>.mjs`:

```js
export default {
	name: "jobs-basic", gate: "M0",        // gate may be an array; slow: true keeps it out of the default run;
	                                        // timing: true runs it alone after the others
	                                        // pending: "<step>" skips it (listed as PENDING) unless named in --only
	async run(t) {                          // t: home, repo, kit, env, git(), dir, requestLog, marks, live, piRuntime
		const lead = rpc(t);                  // drive.mjs: send, prompt, script, until, kill9, restart
		await lead.script({ agent: "lead", steps: [...] });
		await lead.until((e) => e.type === "agent_settled");
		assert.deepEqual(toolCalls(lead.events).map((c) => c.isError), [false]);   // look.mjs readers
	},
};
```

`wf-cc-scripts` runs your recorded Claude Code workflow scripts unchanged. They come from private repositories, so they live only in the gitignored `polygon/private/` (`cp ~/.claude/projects/*/*/workflows/scripts/*.js polygon/private/`, with a run's recorded `args` beside its script as `<script>.args.json`); with none there the scenario stays pending.

`herdr(t)` starts a Herdr server under the sandbox `HOME`, creates a workspace and points later leads at it (`HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`).

## Size ceilings

`ceilings.json` caps the production lines (`.ts`, `.mjs`, `.js`) of each area; `size-ceilings` fails when one is over. A step that adds code raises its area by its stated lines in the same commit, and a step that deletes code lowers it. An area set above the plan's number says why in its `why` field.

## Live tier

The polygon has its own logins, in the `pi-kit-polygon-login` Podman volume. Your real `~/.pi`, `~/.claude` and `~/.codex` are never mounted; `--kit installed` mounts only the kit checkout under `~/.pi/agent/git`, read-only.

```bash
npm run polygon -- --login               # once: Pi /login (Sign in with ChatGPT, Anthropic), claude auth login, codex login --device-auth
npm run polygon -- --live --smoke        # agent-background and model-inherit on real models, about 15 requests
npm run polygon -- --live [--gate M1]    # every scenario marked live: true, four at a time
npm run polygon -- --live --max-requests 100
```

`--login` runs the three logins in one interactive container on the host network, so a browser's OAuth callback to `localhost` reaches it; afterwards, check that your own logins still work. Each `--live` run then starts one serial freshen container, the only thing that ever mounts the volume: it refreshes each Pi OAuth login (`openai`, `openai-codex`, `anthropic`) when it expires within 2 h, or 45 min for `openai`, whose Sign in with ChatGPT tokens live 60 min (`pi auth print-bearer-token`, no model call) and Claude's and Codex's with one tiny request each, then stages a copy whose refresh tokens are invalid placeholders. Every scenario `HOME` gets that copy, so the worst a scenario can do is fail, never log the polygon out; the copies are deleted at teardown. An empty volume stops the run with a pointer to `--login`.

On `--live`, scripts carry a line telling a real model to follow them, Pi's lead is the kit's `lead` model on the first staged login of `openai`, `openai-codex` and `anthropic` (the order `sol` prefers), waits stretch sixfold, and the puppet passes the `openai-codex` and Anthropic wires through to the real APIs, still logging every model request with its HTTP status. That log is the request guard: scheduling stops at `--max-requests` (default 400, the freshen requests included) or at the first HTTP 429, which marks that scenario `quota` rather than `fail`; a 401 or 403 fails a scenario at once. Codex CLI requests, and a Pi lead and its agents on `openai`, go to OpenAI directly and are not counted yet, so `model-inherit` reads what agents ran on from their durable stores (`agentReplyModels`), not from the request log; the other live scenarios that assert on `requests(t)` still need a lead on `openai-codex` or `anthropic`.
