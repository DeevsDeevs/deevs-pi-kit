# Concept Diagrams Skill

Agent-facing workflow for source-grounded visual explanations.

Main instruction file: [`SKILL.md`](SKILL.md).

This is intentionally Pi-native: Mermaid-first, source-cited for codebase diagrams, and focused on small reasoning diagrams rather than gallery-style generated art.

## Default output

Use Mermaid in Markdown unless the user asks for a polished file or SVG/HTML artifact.

Good default formats:

```text
flowchart LR/TB       architecture, data flow, dependency maps
sequenceDiagram       temporal interactions and protocols
stateDiagram-v2       lifecycle/status transitions
mindmap               loose concept clusters
```

## File outputs

When the user asks for durable docs, write Markdown under a project-local path such as:

```text
docs/diagrams/<slug>.md
```

When the user asks for a polished standalone visual, use:

```text
templates/standalone-svg.html
```

and write a self-contained `.html` file.

## Upgrades over a plain diagram skill

- starts from a five-question diagram brief
- uses readability budgets to avoid mega-diagrams
- distinguishes facts, assumptions, and inferred relationships
- supports multi-view diagram packs for complex systems
- integrates with wiki/docs paths without auto-writing broadly

## Guardrail

For codebase diagrams, inspect relevant files first and list the source paths used. Do not infer architecture from filenames alone.
