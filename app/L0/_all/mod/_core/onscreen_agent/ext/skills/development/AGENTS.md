# AGENTS

## Purpose

`ext/skills/development/` owns the onscreen agent's frontend development super-skill.

This subtree is the durable development reference for the overlay chat agent. It must stay aligned with the current app, framework, router, API, layer, and auth contracts so the agent can develop frontend features safely and predictably without drifting into backend changes.

Documentation is top priority for this subtree. After any change under `ext/skills/development/`, or any mirrored source-contract change, update this file and the affected skill files in the same session.

## Documentation Hierarchy

This parent doc owns the nested development-skill map, source-doc mirror rules, and update policy. The child `skill.md` files own the concrete guidance for one development area each.

Current child skills:

- `skill.md`: router skill that tells the agent which deeper development skills to load next
- `frontend-runtime/skill.md`: editable browser-runtime, store, visual, and framework usage rules
- `modules-routing/skill.md`: module placement, routed view creation, and router seam rules
- `extensions-components/skill.md`: `ext/html/`, `ext/js/`, `x-extension`, and `x-component` contracts
- `app-files-apis/skill.md`: frontend use of `space.api`, app-file paths, and permission-aware data access
- `layers-ownership/skill.md`: `L0` or `L1` or `L2`, groups, users, and override order
- `skills/skill.md`: authoring chat-agent skills under `ext/skills/`
- `backend-reference/skill.md`: read-only backend architecture reference for frontend work

Update rules:

- update `skill.md` when the routing map, recommended load order, or allowed development scope changes
- update the matching child skill when its mirrored source contract changes
- keep the child skills consistent with the source docs listed below
- remove stale guidance immediately when a source contract changes

## Ownership

This subtree owns:

- the top-level `development` skill id exposed to the onscreen agent catalog
- the nested development skill ids under `development/...`
- the maintenance contract that keeps those skills aligned with the current repo docs

Source-doc mirror map:

- `frontend-runtime/skill.md` mirrors `/app/AGENTS.md` and `/app/L0/_all/mod/_core/framework/AGENTS.md`
- `modules-routing/skill.md` mirrors `/app/AGENTS.md` and `/app/L0/_all/mod/_core/router/AGENTS.md`
- `extensions-components/skill.md` mirrors `/app/AGENTS.md` and `/app/L0/_all/mod/_core/framework/AGENTS.md`
- `app-files-apis/skill.md` mirrors `/app/AGENTS.md`, `/server/api/AGENTS.md`, and `/server/lib/customware/AGENTS.md`, including the `user_self_info` scope snapshot contract
- `layers-ownership/skill.md` mirrors `/AGENTS.md`, `/app/AGENTS.md`, `/server/lib/customware/AGENTS.md`, and `/server/lib/auth/AGENTS.md`
- `skills/skill.md` mirrors `/app/L0/_all/mod/_core/onscreen_agent/AGENTS.md` and the onscreen skill runtime contract
- `backend-reference/skill.md` mirrors `/server/AGENTS.md`, `/server/api/AGENTS.md`, `/server/lib/customware/AGENTS.md`, and `/server/lib/auth/AGENTS.md`

## Local Contracts

- the router skill must tell the agent to load one or more deeper skills before making development changes
- the router skill and `app-files-apis/skill.md` must tell the agent to inspect `space.api.userSelfInfo().scope` before choosing writable app roots
- this skill set only authorizes frontend development in `app/`; the backend reference skill is for understanding contracts, not for editing `server/`, `commands/`, or `packaging/`
- nested skills should stay focused on one area rather than repeating the whole architecture
- `frontend-runtime/skill.md` must keep the shared runtime helper list current, including browser utilities such as `space.utils.markdown.render(...)`
- when a complex area grows, add another nested skill instead of bloating the router skill
- if a mirrored contract changes in a source doc, update the affected development skills in the same session even if this subtree itself was not directly edited

## Development Guidance

- keep the router skill short and directive
- keep child skills concrete and task-oriented
- prefer exact path examples and file locations over abstract advice
- call out read-only backend boundaries explicitly wherever backend context appears
- if framework, router, API, layer, permission, or auth rules change, update this subtree before finishing the session
