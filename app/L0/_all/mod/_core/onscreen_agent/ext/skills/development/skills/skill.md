---
name: Skill Authoring
description: Author or update onscreen chat-agent skills under ext/skills with the correct catalog, routing, and maintenance rules.
---

Use this skill when creating or updating skills for the onscreen chat agent.

## Skill File Layout

- Onscreen chat-agent skills live inside browser modules under `mod/<author>/<repo>/ext/skills/...`.
- Repo-owned first-party onscreen skills should normally live under `app/L0/_all/mod/_core/<module>/ext/skills/...`.
- Group-scoped or admin-only onscreen skills may live under readable customware roots such as `app/L0/_admin/mod/_core/<module>/ext/skills/...`.
- A skill file is always named `skill.md`.
- The skill id is the path relative to `ext/skills/` with the trailing `/skill.md` removed.

Examples:

- `mod/_core/onscreen_agent/ext/skills/development/skill.md` -> `development`
- `mod/_core/onscreen_agent/ext/skills/development/modules-routing/skill.md` -> `development/modules-routing`

## Catalog Rules

- The onscreen prompt catalog lists only top-level skills from `ext/skills/*/skill.md`.
- Nested skills are not listed by default.
- Any readable skill at any depth can still be auto-injected into the system prompt when its frontmatter sets `metadata.always_loaded: true`.
- Auto-injected skills appear after the catalog in the `## Automatically Loaded Skills` prompt section as repeated `path: <skill-id>` blocks followed by the full skill file content.
- Routing skills should tell the agent which deeper skill ids to load next.
- `space.skills.load("<path>")` loads the full skill file on demand and inserts its content into history through execution output.
- A plain top-level `await space.skills.load("<path>")` is enough to inject the skill content; use `return` only if you also want the execution result value explicitly.

## Conflict Rules

- Skill ids must be unique across readable mods.
- If a skill is visible only to a narrower audience, still give it a top-level id that will not collide with shared `_all` skills that those users can also read.
- Conflicting ids are omitted from the catalog.
- Loading a conflicting id fails with an ambiguity error.

## Skill Content Rules

- Start with frontmatter containing `name`, `description`, and optional runtime-owned `metadata`.
- Use `metadata.always_loaded: true` only when the skill should always be present in the system prompt without an explicit `space.skills.load(...)` call.
- Keep the top-level router skill directive and concise.
- Keep nested skills focused on one stable area.
- Prefer exact file paths, runtime names, and examples over vague guidance.
- If a skill subtree becomes complex, add an `AGENTS.md` file inside that subtree and keep it current.

## Maintenance Rules

- When a mirrored source contract changes, update the affected skill files in the same session.
- Do not let skill guidance drift away from the owning `AGENTS.md` files.
- For the development super-skill specifically, keep `ext/skills/development/AGENTS.md` current whenever the framework, router, API, layer, or auth contracts it mirrors change.
