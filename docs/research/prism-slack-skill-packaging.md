# Prism Slack skill packaging research

## Decision

Use the Agent Skills layout:

```text
.agents/skills/prism-slack/
└── SKILL.md
```

The directory name and frontmatter `name` must both be `prism-slack`.
The minimum frontmatter is:

```yaml
---
name: prism-slack
description: Use when configuring or sending Slack-compatible messages through Prism from a Windows-first local agent workflow.
---
```

Keep the main skill under 500 lines and approximately 5,000 tokens. Put
optional implementation detail in one-level-deep references or scripts only
when the skill needs it. The Prism setup guide should link to the skill rather
than duplicate its procedure.

## Hosted distribution

The Prism website distributes the complete skill tree through a public,
build-generated bundle:

- `/skills/install.md` is the canonical human- and agent-readable procedure.
- `/skills/manifest.json` describes the independent skill version, file hashes,
  and immutable archive path.
- `/skills/latest.zip` is the revalidated alias for the current bundle.
- `/skills/archive/<versioned-file>.zip` is immutable and cacheable.

The archive preserves a top-level `prism-slack/` directory and is generated
from this repository's `.agents/skills/prism-slack/` source. Its independent
`VERSION` file starts at `1.0.0`; generated artifacts are excluded from source
control. The homepage CTA derives the prompt origin from the browser's current
web origin, not from a server environment variable or request headers.

## Evidence

- The Agent Skills specification requires a skill directory containing
  `SKILL.md`, YAML frontmatter, and matching lowercase hyphenated `name`:
  [Agent Skills specification](https://agentskills.io/specification.md).
- The specification recommends concise imperative instructions, workflow
  steps, safety guardrails, examples, and progressive disclosure through
  optional `scripts/` and `references/` directories:
  [Agent Skills specification](https://agentskills.io/specification.md).
- The repository's setup guide already owns the Prism API and security
  procedure, including the host URL, bearer authentication, health/status/
  capabilities checks, and Slack-compatible forwarding:
  [`docs/setup.md`](../setup.md).
- The repository security guidance prohibits exposing Prism developer tokens or
  Slack credentials in docs, prompts, screenshots, or logs:
  [`docs/security.md`](../security.md).

## Invocation guidance

The description should mention both configuration and sending so implicit
skill selection can identify the workflow. Agents that support explicit skill
invocation can use `$prism-slack`; other clients may expose the same skill
through their own explicit invocation syntax. The skill should remain portable
by standardizing on direct PowerShell/HTTP calls and documenting the reference
MCP adapter as optional.
