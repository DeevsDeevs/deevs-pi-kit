# Reference

Everything the [README](../README.md) skips: what each extension does, `pi-kit.json`, upgrade notes and the skills.

## Requirements

- Pi 1.4.0+ and Node 22.19+.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit        # every project
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l     # this project only
pi update git:github.com/DeevsDeevs/deevs-pi-kit         # upgrade
```

Then `/reload`; `pi config` toggles single extensions and skills. No production dependencies.

### Upgrade notes

- The `Agent`, `Workflow`, `SendMessage`, `TaskStop` and `ListAgents` tools, the `/agents` command, the `workflow-authoring` skill, the lead's working rules, the silent-turn reminder and the `models`, `lead` and `autonomy` keys are gone with pi-durable. Run other agents through hc with the agent-system `hc-flow` skill. Let running kit agents and workflows end before updating; their store under `~/.pi/agent/pi-kit/agents/` is no longer read and can be deleted.
- Jobs, monitors, Claude Code and Codex workers, chains, missions, collaborators, the guard, `wiki`, `arxiv` and the notifier are gone. A session store that still holds a running job, monitor or CLI worker may not resume; let such work end first, or delete that session's store under `~/.pi/agent/pi-kit/agents/`.

## Extensions

- `todo_list`: a session todo widget. [More](../extensions/todos/README.md).
- `ask_user`: asks before irreversible choices.
- `codex-fast`: `service_tier: "priority"` on the lead's ChatGPT-login requests when `codexFast` is on.
- `chains`: at session start, the chains skill's `list --max 5` (chains newest first, each latest link's title, age and next step) for the session's folder goes into the system prompt; nothing when the folder has no chains or the skill isn't installed. At the end of a run, if the skill's `remind` says the session is due (30 minutes with no link saved, once per session), it adds a visible `[chains reminder]` message and continues once. No tools.
- `hc`: inside an hc terminal (`HC_TERMINAL_ID` set), one line in the system prompt points the lead at the `hc` skill, and at `hc-flow` for other agents. No tools.

### Print mode

`pi -p` has no `ask_user`.

## pi-kit.json

Global `~/.pi/agent/pi-kit.json`, per-project `.pi/pi-kit.json` (wins key by key), re-read on every use. An unparsable file or an off-schema value is skipped and warns once. Every key is optional:

```json
{
  "codexFast": false
}
```

- `codexFast`: `service_tier: "priority"` on the lead's own ChatGPT-login requests, never with an API key. An untrusted project's value is ignored.

## Skills

`todos` and `ask-user` teach the lead the kit's tools.

## Development

```bash
npm install
npm run check    # typecheck, tests, audit, pack
```
