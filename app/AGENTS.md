# AGENTS

## Purpose

`app/` is the primary Agent One runtime.

Keep agent orchestration, prompt construction, tool flow, state management, user interaction, and optimistic UX in the browser whenever possible. Server-backed work in this tree should be browser clients for explicit server APIs, not server-side orchestration leaking into the frontend.

## Structure

The browser runtime is organized into three layers:

- `L0/`: immutable firmware changed through updates
- `L1/`: runtime-editable group customware
- `L2/`: runtime-editable user customware

Current browser entry surfaces are served from `server/pages/`:

- `/`: main chat shell from `server/pages/index.html`
- `/admin`: admin shell from `server/pages/admin.html`
- `/login`: standalone login screen from `server/pages/login.html`
- `/logout`: server-side logout action that clears the session cookie and redirects to `/login`

Current shared module locations:

- `app/L0/_all/mod/_core/framework/`: shared frontend framework bootstrap, runtime helpers, API client, modal/component support
- `app/L0/_all/mod/_core/chat/`: current chat runtime, UI, storage, execution context, and LLM client helpers
- `app/L0/_all/mod/_core/admin/`: current admin UI modules
- `app/L0/test/`: firmware-side test and example customware fixtures

## Layer Rules And Module Model

- `L0` is firmware and should stay update-driven
- `L1` contains per-group customware; `_all` and `_admin` are special groups
- `L2` contains per-user customware; users should only write inside their own `L2/<username>/`
- `L1` and `L2` are transient runtime state and are gitignored; do not document repo-owned example content there as if it were durable framework structure
- groups may include users and other groups, and may declare managers that can write to that group's `L1` area
- group definitions live in `group.yaml` files under `app/L0/<group-id>/` and `app/L1/<group-id>/`
- read permission rules are explicit: users can read their own `L2/<username>/`, and can read `L0/<group>/` and `L1/<group>/` only for groups they belong to
- write permission rules are explicit: users can write their own `L2/<username>/`; users can write `L1/<group>/` only for groups they manage directly or through managing-group inclusion; `_admin` members can write any `L1/` and `L2/` path; nobody writes `L0/`
- modules are the supported browser extension unit
- each group or user owns a `mod/` folder, and module contents are namespaced as `mod/<author>/<repo>/...`
- browser-facing code and assets should normally be delivered through `/mod/...`
- the current inheritance model is `L0 -> L1 -> L2` across the effective group chain for the current user
- authenticated frontend fetches now rely on the server-issued session cookie after login; do not reintroduce client-trusted identity shortcuts

## Frontend Implementation Guide

- keep root HTML shells thin and static; session gating for root pages belongs in the server router, not in inline boot scripts
- keep page shells under `server/pages/` minimal; they should mount app modules rather than duplicating frontend logic there
- use `/mod/_core/framework/initFw.js` as the shared frontend bootstrap for framework-backed pages
- prefer Alpine stores created with `createStore(...)` for feature controllers
- gate store-dependent component content with `x-data` and `template x-if="$store.<name>"`
- use Alpine handlers such as `@click`, `@submit.prevent`, `@input`, `@keydown`, `x-model`, `x-text`, `x-ref`, `x-init`, and `x-destroy` instead of wiring most behavior through manual `querySelector` listeners
- pass DOM references into stores from Alpine via `x-ref`; do not make stores scan the whole document when direct refs will do
- keep stores responsible for state, persistence, async flows, and orchestration; move large render-only helpers into separate modules when templating alone becomes too dense
- expose shared browser-facing APIs through the `A1` runtime namespace
- keep feature-specific runtime state in the owning feature namespace or store, such as `A1.currentChat`, not in generic runtime globals
- keep new runtime features in module folders, not in ad hoc top-level static paths
- legacy extension helpers still exist under the framework area; do not expand them casually if the module-based `/mod/...` model already covers the use case

## Current State

- `server/pages/index.html` and `server/pages/admin.html` are plain module-backed shells; the server router decides whether to serve them or redirect to `/login`
- `server/pages/login.html` contains the login submit flow inline, can create a temporary guest account through `/api/create_guest`, and exchanges credentials for a server session before redirecting to `/`
- `/logout` is handled entirely by the server pages layer; there is no standalone logout page shell in `app/` or `server/pages/`
- browser-side file changes still require a manual browser refresh; live reload is not wired into the app runtime yet
- when app structure, layer behavior, module layout, entry shells, or frontend conventions change, update this file in the same session
