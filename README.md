# deevs-pi-kit

Perfect pi kit to be 10x Deevs' engineer.

This is Deevs' portable [pi](https://pi.dev) package.

It is intentionally empty for now: add prompts, skills, extensions, and themes as the workflow evolves.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit
```

Pinned to a tag or commit:

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit@v0.1.0
```

Project-local install:

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l
```

## Structure

```text
.
├── extensions/   # TypeScript pi extensions
├── prompts/      # Markdown prompt templates
├── skills/       # Agent skills, each with SKILL.md
└── package.json  # pi package manifest
```

## Development

Try locally from another repo:

```bash
pi install /Users/deevs/programming/agents/deevs-pi-kit
```

Reload after edits inside pi:

```text
/reload
```
