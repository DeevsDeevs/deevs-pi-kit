---
name: datadog-pup
description: Use the `pup` CLI to inspect and operate Datadog safely. Use when the user asks about Datadog logs, metrics, monitors, APM/traces, incidents, dashboards, SLOs, Live Debugger, Service Catalog, or Pup itself.
---

# Datadog via Pup

Use this skill when interacting with Datadog through the `pup` CLI. Pup is broad and self-describing; prefer live command discovery over memorized flags.

## First moves

1. Check the binary and auth/site:

```bash
which pup
pup --version
pup auth status
```

If auth is missing or expired on the default site, check whether the user is on another Datadog site such as `datadoghq.eu`:

```bash
DD_SITE=datadoghq.eu pup auth status
```

Ask the user to run `pup auth login` or provide the correct `DD_SITE` when needed. For this user's current Datadog org, prefer `DD_SITE=datadoghq.eu` or export it for the session:

```bash
export DD_SITE=datadoghq.eu
```

Do not loop on 401/403.

2. Discover commands before guessing:

```bash
pup agent schema --compact          # broad command map
pup agent guide                     # agent-facing usage guide
pup <domain> --help                 # domain-specific schema/help
```

For schema/help only, `FORCE_AGENT_MODE=1` is useful because help becomes JSON. Do **not** use forced agent mode for write operations unless also using `--read-only`; agent mode may auto-approve prompts.

3. Prefer JSON output and bounded queries:

```bash
DD_SITE=datadoghq.eu pup --read-only logs search --query="status:error" --from="1h" --limit=20 --output=json
```

Use `--read-only` for exploration. Remove it only for explicit, user-approved create/update/delete actions.

## Safety rules

- Treat Datadog as production data until proven otherwise.
- Default to read-only. Writes include create/update/delete, downtime changes, debugger probe creation, workflow runs, key/user changes, and config changes.
- Get explicit confirmation before writes. Show the exact command or JSON body first.
- Use API-side filters and aggregation; do not fetch huge datasets and post-process locally.
- Always specify `--from` for logs, metrics, traces, events, and SLO status.
- Start narrow: 15m-1h and low limits. Widen only with a reason.
- Redact secrets, tokens, emails, user IDs, request bodies, and sensitive log attributes unless the user explicitly needs them.
- Preserve IDs and links in summaries so findings are auditable.
- If 401/403: stop and report auth/scope issue; suggest `pup auth refresh`, `pup auth login`, or API/app-key scopes.
- If 429: back off and narrow the query.

## Common read workflows

### Logs: count first, then sample

```bash
pup --read-only logs aggregate \
  --query="status:error env:prod" \
  --from="1h" \
  --compute="count" \
  --group-by="service" \
  --output=json

pup --read-only logs search \
  --query="status:error env:prod service:<service>" \
  --from="1h" \
  --limit=20 \
  --output=json
```

Use log query syntax: `status:error`, `service:api`, `env:prod`, `@http.status_code:[500 TO 599]`, quoted phrases, `AND`/`OR`, and negation.

### Metrics: use Datadog metric query syntax

```bash
pup --read-only metrics query \
  --query="avg:system.cpu.user{env:prod} by {host}" \
  --from="1h" \
  --output=json

pup --read-only metrics list --filter="trace.*" --output=json
```

Shape: `<aggregation>:<metric>{<scope>} by {<group>}`.

### APM and traces

```bash
pup --read-only apm services list --env production --output=json
pup --read-only apm services stats --env production --from="1h" --output=json
pup --read-only traces search --query="service:<service> status:error" --from="1h" --limit=20 --output=json
pup --read-only traces aggregate --query="service:<service>" --from="1h" --compute="avg(@duration)" --group-by="resource_name" --output=json
```

Critical: trace/APM durations in trace search are often nanoseconds. `1s = 1000000000`, `500ms = 500000000`.

### Monitors, SLOs, incidents

```bash
pup --read-only monitors list --tags="service:<service>" --output=json
pup --read-only monitors search --query="status:Alert" --output=json
pup --read-only slos list --output=json
pup --read-only incidents list --query="status:active" --output=json
```

For large orgs, avoid unfiltered monitor lists. Filter by `service:`, `team:`, `env:`, name, or status.

### Service Catalog / IDP

```bash
pup --read-only idp find <service> --output=json
pup --read-only idp assist <service> --output=json
pup --read-only idp owner <service> --output=json
pup --read-only idp deps <service> --output=json
```

Use this before guessing ownership, on-call, dependencies, or service health.

### Live Debugger / Symbol DB

Live Debugger can affect production services. Use only with explicit user approval.

```bash
pup --read-only debugger context <service> --fields service,language,envs
pup --read-only symdb search --service <service> --query "Controller" --view probe-locations
```

Before creating a probe, confirm service, environment, location, captures, TTL, and cleanup plan. Prefer capture expressions over full snapshots. Use a short TTL. Delete the probe after use.

If watching a probe or other long-running command, use Pi managed background processes:

```text
proc_start name="pup-debugger-watch" command="pup debugger probes watch <id> --timeout 60 --limit 10 --fields message,captures,timestamp"
proc_read ...
proc_signal ...
```

## Writes and changes

Before any create/update/delete/run action:

1. Explain what will change and why.
2. Prepare JSON/YAML body in a temporary or project file if needed.
3. Run validation/list/get commands where available.
4. Show exact command.
5. Ask for confirmation.
6. Execute with the smallest scope.
7. Verify with a read command.
8. Record created IDs and rollback/cleanup steps.

Prefer body files over long inline JSON:

```bash
pup monitors create --file monitor.json --output=json
pup dashboards update <id> --file dashboard.json --output=json
```

Use `--yes` only after user approval. Do not use `--yes` to bypass ambiguity.

## Domain map

Use `pup agent schema --compact` for the live list. Common domains:

- `logs` — search/aggregate log events
- `metrics` — query/list metric series
- `traces` — span search/aggregate and trace metrics
- `apm` — services, resources, dependencies, flow maps
- `monitors` / `downtime` — alerting and maintenance windows
- `slos` — SLO list/get/status
- `incidents` / `on-call` / `cases` — incident response and ownership
- `dashboards` / `notebooks` — investigation artifacts
- `idp` / `service-catalog` — service ownership and dependencies
- `security`, `audit-logs`, `csm-threats` — security and audit data
- `rum`, `synthetics`, `error-tracking` — user-facing app health
- `cloud`, `infrastructure`, `containers`, `network`, `processes` — infra visibility
- `usage`, `costs` — billing and cost attribution
- `debugger`, `symdb` — live runtime inspection
- `workflows`, `runbooks`, `investigations`, `bits` — automation/AI operations

Some domains may require API/app keys even when OAuth is configured. If a command says OAuth scopes are unsupported or insufficient, report that and ask for the right credential path.

## Reporting results

Summarize, do not dump raw JSON unless requested:

```text
What I checked
- command + time range + filters

Findings
- counts/trends/top services/errors
- relevant IDs/links

Caveats
- auth/site/scope limits
- sampling/retention/time range limits

Next safe query
- one or two options
```

When investigating incidents, preserve chronology: deploy/event changes, monitor state, log spikes, trace latency/errors, infra metrics, and active incidents.
