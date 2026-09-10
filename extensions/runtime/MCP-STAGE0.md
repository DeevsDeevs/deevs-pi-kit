# Stage 0: restricted MCP compatibility probe

Development only. This is not collaborator messaging, not a Runtime capability upgrade, and not a replacement for existing delivery. The implementation gate is in [MCP-PLAN.md](MCP-PLAN.md#stage-0--restricted-provider-compatibility).

## Implemented probe

```sh
node scripts/mcp-stage0.mjs
npx vitest run test/mcp-stage0.test.ts
```

The first command is a stdio child, not a standalone service: a harness must own its stdin and lifetime. It offers only `stage0_echo({message})`, at most 16 KiB UTF-8, and supports `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. The sole supported protocol revision is `2025-11-25`; another requested version receives this version for the client to accept or reject.

The probe has no Runtime imports, credentials, network, shell, mailbox, registration, or lifecycle tools. Frames are bounded to 256 KiB; requests are processed sequentially with output backpressure. EOF terminates it. A deliberately small 256-frame/15-minute connection ceiling keeps it disposable; production timeout/cancellation/quota behavior remains Stage 1 work.

Optional `PI_KIT_MCP_PROBE_LOG` points to an owner-private regular JSONL file in a private proof directory. Evidence records only PID, handshake versions, initialized/list events, successful echo byte length/SHA-256, and clean EOF. No payloads, secrets, or arbitrary provider metadata are logged. A successful `echo` record proves handler execution, not provider result admission. There is no pass/fail inference from a model's prose.

Automated tests exercise handshake/version negotiation, notifications, protocol versus tool errors, malformed envelopes/UTF-8, fragmented frames, EOF, input/work bounds, and maximum escaped output. The synthetic bound reserves 16 KiB of serialized metadata; Stage 1 must repeat it against the real event schema before freezing production ceilings.

## Shared context fixture

Use the following exact source block for both providers, attached through their supported per-launch developer/system context. This is a proof fixture, not the future public messaging skill; do not publish tools or skills that do not exist.

```text
This is the Pi Kit Stage 0 compatibility proof, not collaborator messaging.
When the user asks for the shared-context check, call stage0_echo (allowing
its harness prefix) with message exactly "pi-kit-stage0-shared-context-v1".
Do not send that value through any other tool. Do not claim the echo proves
Runtime publication, native admission, permission enforcement, or completion.
No shell, hooks, other MCP servers, or lifecycle actions are authorized.
For an explicit negative permission check only, you may ask a native write
tool to create forbidden-write.txt under your exact cwd. Accept the harness's
denial; do not bypass it or substitute another tool. No other writes are allowed.
```

Store the block once in a 0600 file under a new 0700 proof root. Attach those exact bytes to Claude with `--append-system-prompt-file` and Codex with `developer_instructions`; keep the user prompt free of the challenge string. Verify the echo hash independently. Exact-source attachment is acceptable for this spike; skill discovery/prefix parity remains a separate Stage 2 requirement.

## Claude launch verified in Stage 0

Prepare an owner-private MCP config with exactly one stdio server:

```json
{
  "mcpServers": {
    "stage0": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/scripts/mcp-stage0.mjs"],
      "env": { "PI_KIT_MCP_PROBE_LOG": "/private/proof/root/claude-mcp.jsonl" }
    }
  }
}
```

Use a fresh dedicated no-focus Herdr tab, isolated cwd, and fresh Claude session ID. Verified flags with installed Claude 2.1.251:

```text
--restricted --strict-mcp-config --mcp-config <private-config>
--permission-mode dontAsk --tools Read,Glob,Grep
--allowedTools mcp__stage0__stage0_echo
--settings <private-settings> --append-system-prompt-file <private-context-file>
```

The private settings must disable hooks (`disableAllHooks: true`) and must not enable plugins, broad permissions, or extra paths. Verify actual effective settings/tool exposure: CLI flag presence and model refusal are not proof. Do not remove `--safe-mode` from production launches. A trust/permission dialog is a blocker requiring trusted user input, not permission to inject an approval key.

## Codex isolation verified in Stage 0

Installed Codex 0.151.0 exposes `--ignore-user-config` on **exec**, not on the interactive CLI. A successful exec-only experiment therefore does not establish the required visible-session configuration isolation. A credential-free configuration experiment confirmed that a top-level `-c mcp_servers={...}` override **merges** inherited servers: a temporary `CODEX_HOME/config.toml` defining `inherited_canary`, overridden with a `stage0` map, produced both names through `codex mcp list --json` (exit 0). No server or provider session was started. Use an isolated per-launch configuration root with explicitly preserved provider authentication, or prove another complete exclusion mechanism. Never overwrite the user's global config or print/copy credentials into proof reports.

Keep `--sandbox read-only`, `--ask-for-approval never`, and `--disable hooks`. Verify disabling shell/code execution and unrelated app/plugin/browser integrations separately; a read-only sandbox does not itself remove shell tools. Configure only the exact probe command, log path, `enabled_tools = ["stage0_echo"]`, bounded startup/tool timeouts, and the same source context. Capture the actual effective tool/config inventory before interpreting any echo as a safe interoperability result.

The successful 0.151.0 proof used a fresh 0700 `CODEX_HOME`, a 0600 copy of the existing provider auth file (never Runtime credentials), and a new config containing only the original model selection, exact shared context, read-only/never-approve policy, and the single probe server. The shell's actual `CODEX_HOME` was verified before agent start; `codex mcp list --json` showed only `stage0`. The interactive launch used `--strict-config --sandbox read-only --ask-for-approval never --disable hooks`. `--strict-config` is not accepted by the `mcp list` subcommand.

Exact feature settings used for this proof:

```toml
[features]
shell_tool = false
unified_exec = false
code_mode = false
code_mode_host = true
apps = false
plugins = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
computer_use = false
in_app_browser = false
in_app_local_automation = false
image_generation = false
multi_agent = false
multi_agent_v2 = false
remote_plugin = false
hooks = false
goals = false
memories = false
skill_mcp_dependency_install = false
skill_search = false
tool_suggest = false
workspace_dependencies = false
skip_host_skill_discovery = true
```

The first attempt also disabled `code_mode_host`: MCP negotiation/list succeeded, but model tool dispatch failed. The successful attempt restored only that host. This is a V8 tool router, not a Node/shell environment: the matching [upstream `rust-v0.151.0` sources](https://github.com/openai/codex/tree/rust-v0.151.0/codex-rs) (`code-mode-runtime/src/runtime/{globals,module_loader}.rs` and `core/src/tools/code_mode/mod.rs`) expose registered tools, reject module imports, and dispatch nested calls through the normal tool runtime. Live probes independently checked the globals and filesystem-import denial below. Do not enable shell/unified execution to fix this host dependency.

Codex warned that it would not create PATH helper aliases under `/tmp`; explicit absolute probe paths and the tested host still worked. A production per-launch config root belongs in owner-private Runtime storage, with separately designed auth refresh/cleanup—not ad-hoc copying all global settings.

## Live gate and evidence

Run the approved focused tests and package checks before live launches. Use Herdr for interactive agents, never Jobs or hidden exec sessions as a substitute. Record newly created pane/tab/terminal/session IDs from actual creation responses; do not borrow Runtime collaborator identities or credentials. Preserve user focus and every pre-existing agent/workspace.

For **each** provider record:

1. Installed CLI/server versions, exact private configuration paths and non-secret flags.
2. Intended MCP handshake/version, tool discovery and shared-context echo evidence.
3. Effective tools/settings plus harmless isolated negative checks for shell, writes, outside-root access, inherited hooks and unrelated MCP. No model self-report can pass these gates alone. Where the native sandbox permits reads, record that boundary rather than asserting root confinement.
4. Same visible provider session before/after the call; a PID or echoed marker alone is not session identity.
5. Exact closure of only that proof tab, agent absence, and transport child quiescence. EOF is useful evidence, but termination without EOF needs exact process-exit evidence instead. Never treat arbitrary Herdr lookup errors as proof of absence.

Retain private evidence on failure; do not automatically replay an ambiguous prompt. Mark individual gates observed/failed/not-run. Do not proceed to Runtime mutations until both interactive providers pass the full restriction gate.

## Recorded result — 2026-09-10

The Stage 0 compatibility/restriction checks passed on Claude 2.1.251, Codex 0.151.0, and Herdr CLI/server 0.9.0 (protocol 22). This is evidence for these exact configurations, not a general sandbox audit or released messaging capability.

| Check | Observed evidence |
|---|---|
| Actual MCP call | Both visible sessions called `stage0_echo`; the server recorded the expected 31-byte challenge hash and the provider histories contain the correlated tool result. |
| Protocol | Claude requested `2025-11-25`; Codex requested `2025-06-18`. Both accepted the server's `2025-11-25` response, sent initialized, listed tools, and completed echo. |
| Shared source | Both attached exactly the same revised fixture, SHA-256 `bc7000690b61d584f9e874fc09006be5ebc7700954fbec9c2561864bdd21c652`. The user prompts did not contain the echo value. |
| Claude restrictions | Read of an existing outside-cwd fixture returned `is_error: true`; Write was absent from the configured builtin set. Project hook/unrelated MCP canaries and the forbidden-write file stayed absent. |
| Codex restrictions | Actual routing catalog had only the probe MCP plus `apply_patch`, MCP resource helpers, `update_plan`, and `view_image`; no shell or agent-spawn tool. `process`, `require`, `fetch`, and `Deno` were unavailable; `node:fs` import failed. A real `apply_patch` attempt was rejected by the read-only sandbox; the file stayed absent. Native read-only tools are not a claim of cwd-only read confinement. |
| Configuration | Claude retained auth with restricted settings/exact MCP config. Codex used an isolated config/auth root rather than a merging override. No shared hook/MCP/global tool settings were edited. The user explicitly approved Claude's folder-trust dialog for the exact disposable cwd. |
| Visible identity | Claude session `6daa53cf-ce1b-4fe1-b26d-f07973133cfd` in `w7:p67`; Codex session `01a08838-0c46-7e42-82bf-a821e20def14` in `w7:p68`. Histories were read only as scoped proof evidence, not Runtime admission or reply publication. |
| Cleanup | All four created proof tabs (including initial attempts) closed through exact Herdr IDs. Recorded provider/MCP PIDs and Codex's separate code-mode-host PID were absent afterward. The private Codex auth copy was removed after quiescence; no copied auth token value appeared in its proof session files. Existing collaborators remained untouched. All starts used no-focus and observed proof agents remained unfocused. |

Private run artifacts were retained under `/tmp/pi-kit-stage0-eas2tn66/` (`evidence-v2.json`, per-attempt MCP logs, non-secret configs, and exact source references). They are temporary evidence, not shipped resources. The initial failed Codex host-disabled attempt is retained; it was not relabeled successful.

The package check passed with project-local Pi SDK 0.84.4 and Vitest 4.1.11: 493 tests, lint/typecheck, RPC/print/JSONL smokes, zero audit findings, and pack dry-run. The running Pi remained 0.82.1. Use `env -u PI_PACKAGE_DIR npm run check` in this Nix-hosted session so local npm Pi resolves its own assets.

Stage 1 may now begin. Still unproven: Runtime messaging credential/bootstrap/retention, Pi's actual MCP client and durable receive admission, three-harness mail routing, daemon-owned delivery, and the real common messaging skill. No production delivery was changed.
