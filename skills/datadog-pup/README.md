# Datadog Pup Skill

Pi skill for using the `pup` CLI against Datadog safely and effectively.

Main instruction file: [`SKILL.md`](SKILL.md).

## Use for

- Datadog logs, metrics, traces, APM, monitors, SLOs, incidents, dashboards
- Service Catalog / IDP ownership lookups
- Live Debugger / Symbol DB workflows
- discovering Pup commands and flags
- safe read-first Datadog investigation

## Core defaults

```bash
pup auth status
DD_SITE=datadoghq.eu pup auth status   # if your org is on EU
pup agent schema --compact
pup <domain> --help
DD_SITE=datadoghq.eu pup --read-only <domain> <command> ... --output=json
```

Start narrow, use API-side filters/aggregates, and require explicit confirmation before Datadog writes.
