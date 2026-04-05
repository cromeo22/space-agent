---
name: Frontend Runtime
description: Editable frontend runtime rules for framework pages, stores, shared runtime namespaces, and reusable visual patterns.
---

Use this skill when the task changes browser runtime behavior, framework-backed UI, store orchestration, shared helpers, or general frontend composition under `app/`.

## Editable Scope

- You may edit `app/`.
- Keep agent logic in the browser when possible.
- Treat `server/` as read-only infrastructure from this skill set.

## Where First-Party Frontend Code Lives

- Repo-owned first-party frontend code should normally live under `app/L0/_all/mod/_core/...`.
- New shared browser-runtime helpers belong in `_core/framework/` only when multiple modules genuinely need them.
- New shared UI primitives belong in `_core/visual/`.
- Do not place durable repo-owned first-party features directly into `L1` or `L2`.

## Framework Boot And Runtime

- Framework-backed pages boot through `/mod/_core/framework/js/initFw.js`.
- The runtime installs onto `globalThis.space`.
- Current shared runtime surface includes:
  - `space.api`
  - `space.config`
  - `space.chat` when the current agent surface publishes the active thread snapshot
  - `space.fw.createStore`
  - `space.utils.markdown.render(text, target)`
  - `space.utils.markdown.parseDocument`
  - `space.utils.yaml.parse` and `space.utils.yaml.stringify`
  - `space.proxy`
  - `space.download`
  - `space.fetchExternal(...)`

`space.utils.markdown.render(...)` is the shared browser markdown wrapper. It inserts a `.markdown` root so the owning feature can style rendered markdown predictably.

`space.api` includes attachment-style helpers such as `space.api.folderDownloadUrl(pathOrOptions)` when a feature needs a same-origin download URL instead of a fetched blob.

## Store Pattern

- Create stores with `space.fw.createStore(name, model)`.
- Use `init()` for one-time startup and `mount(refs)` or `unmount()` for DOM-bound lifecycle.
- Component HTML owns structure and Alpine bindings.
- Stores own state, persistence, async work, and API orchestration.
- Small utilities own parsing, transforms, and rendering helpers that would make the store too dense.
- Pass DOM refs explicitly with `x-ref`; do not scan the document when direct refs will do.

## Visual And Composition Rules

- Reuse `_core/visual` before inventing feature-local chrome, dialogs, menus, or conversation patterns.
- Keep page shells thin and static; mount real features through modules.
- If a helper or style pattern repeats across features, move it into a clearly shared owner.
- Keep the browser runtime deliberate and readable, not overloaded with one-off patterns.

## Promotion Rules

- If a contract is used by only one module, keep it in that module.
- If multiple modules need the same runtime helper, move it into `_core/framework`.
- If multiple modules share a presentation pattern, move it into `_core/visual`.

## Mandatory Doc Follow-Up

- When framework runtime, shared namespaces, bootstrap order, or reusable frontend primitives change, update the owning `AGENTS.md` files and the `development` skill subtree in the same session.
