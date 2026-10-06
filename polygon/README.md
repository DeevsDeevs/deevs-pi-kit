# Polygon

End-to-end scenarios that run the real binaries (Pi in `--mode rpc`, `claude`, `codex`, Herdr) against the kit as it will be installed, inside a rootless Podman container. A scripted local model, the puppet, stands in for real models. Assertions are structural only: events, tool calls, dialogs, session entries, the puppet's request log, git state and a `/proc` census. Model prose is never read.

```bash
npm run polygon                          # every non-slow scenario on the puppet
npm run polygon -- --only modes,jobs-basic
npm run polygon -- --gate M0 --slow      # a milestone gate, slow scenarios included
npm run polygon -- --kit clone           # git clone --local HEAD + npm install --omit=dev --legacy-peer-deps, as Pi installs it
npm run polygon -- --kit installed       # the checkout `pi update` produced, read-only
npm run polygon -- --pi 1.0.1            # another Pi release than devDependencies pins
npm run polygon -- --list
```

Results land in `polygon/results/<run>/` (`latest` points at the newest): `summary.json`, and per scenario `result.json`, `events.jsonl` (the RPC lead), `requests.jsonl` (the puppet), `pi-stderr.log` and the sandbox `home/` and `repo/`. On red, read `polygon/results/latest/<name>/` before changing code. The exit code is non-zero on any failure.

## Sandbox

`Containerfile` holds Node 24, git, python3, tini, ripgrep, fd, Pi at the kit's devDependencies version, the latest Claude Code and Codex, and Herdr's official static release binary, checked against its published SHA-256. The image tag is a hash of the Containerfile and build args, built only when missing; `podman image rm` it to pick up newer Claude or Codex releases.

One container runs per polygon run. The kit is mounted read-only at `/kit` (a symlinked `node_modules` is mounted at its real path), `polygon/` at `/polygon`, and the run's results at `/results`. Each scenario gets its own `HOME` under `/results/<name>/home`, with Pi, Claude and Codex config dirs inside it, an env built from scratch, a git identity, and a `POLYGON_RUN` tag. Teardown closes the drivers, then SIGKILLs every process still carrying the tag; any such process fails the scenario.

## The puppet

One HTTP server per scenario: `/v1/chat/completions` for Pi's `polygon/puppet` provider (`models.json`), `/v1/messages` for Claude (`ANTHROPIC_BASE_URL`), `/v1/responses` for Codex (a `model_providers` entry), and `/codex/responses` for Pi's built-in `openai-codex` (its `baseUrl` repointed in `models.json`, a fake ChatGPT OAuth token in `auth.json`, the SSE transport). The first user message `POLYGON {json}` is the script:

```json
{ "agent": "lead", "steps": [
  { "id": "s1", "tool": "job_start", "args": { "name": "probe", "argv": ["sh", "-c", "echo ok"] } },
  { "id": "s2", "tool": "job_read", "args": { "id": "$/j_[0-9a-z]+_[0-9a-f]{8}/" } },
  { "id": "s3", "on": "ok", "text": "done" }
] }
```

The next step is the first one not yet said in the transcript whose `on` (if any) appears after the last assistant message, so `kill -9`, resume and child processes need no server state. A string arg `"$/re/"` becomes the last match of `re` in the transcript. A step's `usage` sets its reported prompt tokens (context-pressure tests). A `schema: "auto"` step calls `StructuredOutput` with the smallest value its schema accepts when the request offers that tool, and replies as text otherwise. Every model request is appended to `requests.jsonl` with its agent, step, model, tools offered, message and image counts, `service_tier`, and `marks`: the strings a scenario pushed onto `t.marks` that the raw request contains (a system-prompt section tag, a persona line, a skill name).

## Adding a scenario

Drop `polygon/scenarios/<name>.mjs`:

```js
export default {
	name: "jobs-basic", gate: "M0",        // gate may be an array; slow: true keeps it out of the default run
	                                        // pending: "<step>" skips it (listed as PENDING) unless named in --only
	async run(t) {                          // t: home, repo, kit, env, git(), dir, requestLog, marks
		const lead = rpc(t);                  // drive.mjs: send, prompt, script, until, kill9, restart
		await lead.script({ agent: "lead", steps: [...] });
		await lead.until((e) => e.type === "agent_settled");
		assert.deepEqual(toolCalls(lead.events).map((c) => c.isError), [false]);   // look.mjs readers
	},
};
```

`wf-cc-scripts` runs your recorded Claude Code workflow scripts unchanged. They come from private repositories, so they live only in the gitignored `polygon/private/` (`cp ~/.claude/projects/*/*/workflows/scripts/*.js polygon/private/`, with a run's recorded `args` beside its script as `<script>.args.json`); with none there the scenario stays pending.

`herdr(t)` starts a Herdr server under the sandbox `HOME`, creates a workspace and points later leads at it (`HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`).

## Live tier

`npm run polygon -- --login` opens a shell in the image whose `HOME` is the `pi-kit-polygon-login` Podman volume; log in to Pi, Claude and Codex there once, with copy-paste or device-code flows (`codex login --device-auth`) since the container has no browser. `--live` mounts that volume read-only at `/login` and runs only the scenarios marked `live: true`, four at a time. Your real `~/.pi`, `~/.claude` and `~/.codex` are never mounted; `--kit installed` mounts only the kit checkout under `~/.pi/agent/git`, read-only.
