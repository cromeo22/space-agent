# AGENTS

## Purpose

`app/` is the primary Space Agent runtime.

Keep agent orchestration, prompt construction, tool flow, state management, user interaction, and optimistic UX in the browser whenever possible. Server-backed work in this tree should be browser clients for explicit server APIs, not server-side orchestration leaking into the frontend.

This is one of the five core docs. It owns app-wide architecture, composition rules, and development principles. Detailed module behavior belongs in deeper module-local docs.

Documentation is top priority for this area. After any change under `app/` or any app-facing contract change owned here, update this file and the closest owning module `AGENTS.md` files in the same session before finishing.

## Documentation Hierarchy

`/app/AGENTS.md` stays high-level. Module-local docs own the implementation details for major frontend modules.

Current module-local docs in the app tree:

- `app/L0/_all/mod/_core/dashboard/AGENTS.md`
- `app/L0/_all/mod/_core/framework/AGENTS.md`
- `app/L0/_all/mod/_core/router/AGENTS.md`
- `app/L0/_all/mod/_core/spaces/AGENTS.md`
- `app/L0/_all/mod/_core/visual/AGENTS.md`
- `app/L0/_all/mod/_core/admin/AGENTS.md`
- `app/L0/_all/mod/_core/admin/views/agent/AGENTS.md`
- `app/L0/_all/mod/_core/admin/views/files/AGENTS.md`
- `app/L0/_all/mod/_core/admin/views/modules/AGENTS.md`
- `app/L0/_all/mod/_core/onscreen_agent/AGENTS.md`
- `app/L0/_all/mod/_core/onscreen_menu/AGENTS.md`
- `app/L0/_admin/mod/_core/overlay_agent/AGENTS.md`

Update rules:

- update the nearest module doc when you change a documented module
- update this file only when the app-wide contract, ownership map, composition model, or shared frontend conventions changed
- keep implementation-specific detail out of this file when a deeper doc can own it

## How To Document App Child Docs

All app child docs at the same depth should use the same backbone.

Default module-doc section order:

- `Purpose`
- `Documentation Hierarchy` when the module owns deeper docs or stable sub-areas
- `Ownership`
- one or more concrete contract sections that cover the seams this module exposes
- `Development Guidance`

Required contract coverage for app docs:

- entry points and extension seams: page anchors, routed views, `ext/html/` and `ext/js/` files, exported runtime namespaces, iframe boundaries, and route mounts
- state and persistence: stores, `init()` or `mount()` or `unmount()` lifecycle, session or local storage keys, app-file paths, backend endpoints, and background async work
- component and DOM ownership: which HTML files mount which JS or store files, which components are thin adapters, and which DOM refs or `x-ref` inputs are required
- visual and style ownership: which CSS is shared versus local, which `_core/visual` primitives are reused, and any mirrored public-shell assets or visual constraints
- cross-module links: which other modules this one may call, extend, or be extended by, and which dependencies are intentionally forbidden

Child-doc split rules:

- parent app docs own domain-wide composition rules and the map of module docs
- module docs own the link between HTML, JS, stores, CSS, assets, and extension seams inside that module
- leaf view or component docs, when added, should own the exact UI, store, and API contract for that surface without re-documenting the whole module

Module-type emphasis:

- platform modules such as `framework/` and `visual/` should emphasize reusable namespaces, primitives, tokens, and import boundaries
- shell modules such as `router/` and `admin/` should emphasize anchors, routing, layout seams, and child-surface ownership
- feature modules and admin views should emphasize stores, API calls, persistence, component linkage, and local styling rules

When a module later grows multiple independently owned sub-areas, add a local `Documentation Hierarchy` section there before adding new child docs.

## Structure

The browser runtime is organized into three layers:

- `L0/`: immutable firmware changed through updates
- `L1/`: runtime-editable group customware
- `L2/`: runtime-editable user customware

Current browser entry surfaces are served from `server/pages/`:

- `/`: main app shell from `server/pages/index.html`
- `/admin`: admin shell from `server/pages/admin.html`, with `meta[name="space-max-layer"]` set to `0` so module and extension resolution stay `L0`-only
- `/login`: standalone public auth entry from `server/pages/login.html`
- `/enter`: firmware-backed launcher from `server/pages/enter.html`, available to authenticated sessions and single-user runtime while unauthenticated multi-user requests are redirected to `/login`
- `/logout`: server-side logout action that clears the session cookie and redirects to `/login`

Current major first-party modules under `app/L0/_all/mod/_core/`:

- `framework/`: frontend bootstrap, runtime primitives, component loader, extension system, shared utilities
- `visual/`: shared visual language, canvas, chrome, buttons, dialog helpers, and conversation rendering primitives
- `router/`: root routed shell for the authenticated app; route-level frame width, height or scroll policy, and other shell-owned layout overrides belong here rather than in feature modules, but routed pages own their own content padding
- `admin/`: firmware-backed admin shell and panels
- `onscreen_agent/`: floating routed overlay agent and the first-party user-facing agent surface
- `onscreen_menu/`: top-right routed shell menu extension
- `dashboard/`, `spaces/`, and the `space/` compatibility shim: current routed feature surfaces under the router

## Layer Rules And Module Model

- `L0` is firmware and should stay update-driven
- `L1` contains per-group customware; `_all` and `_admin` are special groups
- `L2` contains per-user customware; users should only write inside their own `L2/<username>/`
- the writable `L1` and `L2` layers are logical app paths first; on disk they default to `app/L1` and `app/L2`, but the backend may relocate them to `CUSTOMWARE_PATH/L1` and `CUSTOMWARE_PATH/L2`
- repo-local `app/L1` and `app/L2` are transient runtime state and are gitignored; do not document repo-owned example content there as if it were durable framework structure
- `L2/<username>/user.yaml` stores user metadata such as `full_name`; auth state lives under `L2/<username>/meta/`
- groups may include users and other groups, and may declare managers that can write to that group's `L1` area
- read permissions are explicit: a user can read their own `L2/<username>/`, and can read `L0/<group>/` and `L1/<group>/` for groups they belong to
- write permissions are explicit: a user can write their own `L2/<username>/`; a user can write `L1/<group>/` only when they manage that group directly or through a managing-group include chain; members of `_admin` can write any `L1/` and `L2/` path; nobody writes `L0/`
- modules are the supported browser delivery and extension unit
- each group or user owns a `mod/` folder, and module contents are namespaced as `mod/<author>/<repo>/...`
- browser-facing code and assets should normally be delivered through `/mod/...`
- group-scoped onscreen skill packs may live under readable layer roots such as `L0/_admin/mod/.../ext/skills/`; visibility follows the same readable-root permission model as app-file discovery
- page shells may clamp module and extension resolution with `meta[name="space-max-layer"]`; the current admin shell sets `0`
- page shells may also receive injected `meta[name="space-config"]` tags for runtime parameters marked `frontend_exposed`
- authenticated app-file APIs operate on logical app-rooted paths such as `L2/alice/user.yaml` or `/app/L2/alice/user.yaml`, and supported APIs may use `~` or `~/...` as shorthand for the authenticated user's `L2/<username>/...`
- first-party application development should happen primarily under `app/L0/_all/mod/_core/`
- use `L1` and `L2` for layered overrides and customware behavior, not as the main home for repo-owned first-party features

## Frontend Composition Model

The frontend is built as a chain of shells, modules, and extension seams.

Current boot flow:

1. A page shell in `server/pages/` loads shared framework CSS and `/mod/_core/framework/js/initFw.js`.
2. The shell exposes one top-level HTML anchor in the body.
3. `initFw.js` installs the runtime, extension system, Alpine helpers, and shared bootstrap behavior.
4. The first mounted module owns the next seam and exposes more anchors or wrapped functions.
5. Other modules compose into those explicit seams instead of patching private internals.

Current entry anchors:

- `/` exposes `body/start`, which mounts `_core/router`
- `/admin` exposes `page/admin/body/start`, which mounts `_core/admin`

Default composition guidance:

- keep page shells small
- mount real features through thin `ext/html/...` adapter files
- let the owning module expose the next seam
- add explicit extension points when downstream customization is realistic

## Extension And Component Contracts

There are two primary extension styles in the frontend runtime.

HTML extension anchors:

- declare a seam with `<x-extension id="some/path">`
- matching HTML files live at `mod/<author>/<repo>/ext/html/some/path/*.html`
- HTML callers name only the seam; the runtime loads `<x-extension>` tags from the module's `ext/html/` tree automatically
- thin extension files should usually mount the real component from the module root instead of containing the entire feature directly
- root page anchors such as `body/start` and `page/admin/body/start` are fixed shell contracts; module-owned anchors should be named after the owning module path, for example `_core/router/shell_start`

JS extension hooks:

- use `space.extend(import.meta, async function name() {})` for behavior seams
- wrapped functions expose `/start` and `/end` hook points
- wrapped functions become async and should be awaited by callers
- JS hook files live at `mod/<author>/<repo>/ext/js/<extension-point>/*.js` or `*.mjs`
- JS callers name only the seam; the runtime loads hooks from the module's `ext/js/` tree automatically
- use `callJsExtensions("name", data)` only when the seam is an explicit event rather than a function lifecycle

Resolution and overrides:

- `/api/extensions_load` resolves extension files from the accessible `L0 -> L1 -> L2` inheritance chain
- `maxLayer` constrains only module and extension resolution
- identical module-relative extension file paths override lower-ranked layers
- different filenames under the same extension point compose together
- prefer additive composition before full same-path replacement

`<x-component>` contract:

- components may be full HTML documents or fragments
- the loader mounts styles, module scripts, and body nodes, then recursively loads nested `<x-component>` tags
- component HTML should stay declarative and bind to stores instead of carrying dense inline logic
- import a feature's store module in the component that owns the feature, not in unrelated parent shells

## Store And Runtime Model

The default frontend pattern is Alpine plus store-backed modules.

Ownership split:

- component HTML owns structure and Alpine bindings
- stores own state, persistence, async work, server calls, and orchestration
- module utilities own rendering helpers, transforms, and protocol logic that would make the store too dense
- `space` owns shared runtime APIs and explicit cross-feature namespaces

Store guidance:

- create stores with `space.fw.createStore(name, model)` on framework-backed pages
- use `init()` for one-time startup and `mount(refs)` plus `unmount()` for DOM-bound lifecycle
- pass DOM references with `x-ref`; do not make stores scan the document when direct refs will do
- gate store-dependent UI with `x-data` plus `template x-if="$store.<name>"`
- keep store names aligned with the exported binding and the `$store.<name>` key

Runtime guidance:

- framework-backed pages that boot through `/mod/_core/framework/js/initFw.js` already initialize the runtime before feature modules mount
- `globalThis.space` is scoped to the current window or iframe only; do not publish it into other browsing contexts
- use `space.api` for authenticated backend calls
- use `space.api.folderDownloadUrl(...)` when a folder download should stay as a browser attachment instead of fetching the archive blob into frontend memory
- keep feature-owned runtime namespaces under `space` explicit and narrow; `_core/spaces` owns `space.current` for current-space widget authoring, live widget-state descriptors, and batch layout or toggle or removal helpers plus `space.spaces` for persisted space CRUD, loaded-space collections, lower-level widget/storage helpers, and spaces-owned prompt context injection, `_core/onscreen_agent` owns `space.onscreenAgent` for overlay display control and prompt submission, and agent surfaces publish the active thread snapshot at `space.chat`
- use `space.api.userSelfInfo()` as the canonical browser-side identity and scope snapshot; it returns group membership plus the readable and writable logical app roots the current user can use from the frontend
- use `space.config` for frontend reads of backend parameters that were explicitly marked `frontend_exposed`
- use `space.utils.markdown.render(text, target)` for lightweight shared markdown rendering into a `.markdown` wrapper and `space.utils.markdown.parseDocument(...)` for frontmatter parsing; keep feature-local presentation in the owning module's CSS
- use `space.utils.yaml.parse(...)` and `space.utils.yaml.stringify(...)` for lightweight frontend YAML parsing and serialization owned by browser modules
- browser storage is for small non-authoritative UI state; persistent user state belongs in app files or explicit backend APIs

## Visual Direction

Space Agent frontend work should look like one deliberate system rather than a mix of unrelated component-library defaults.

- minimal first: solve hierarchy with spacing, alignment, type scale, and one strong surface before adding extra chrome
- use the semantic color tokens from `app/L0/_all/mod/_core/framework/css/colors.css`
- use the shared visual system in `app/L0/_all/mod/_core/visual/` before inventing feature-local backgrounds, buttons, dialogs, or menus
- keep the dark space direction calm and readable; avoid noisy sci-fi chrome and neon overload
- if a style pattern appears in more than one place, move it into `_core/visual`
- public shells that cannot load authenticated `/mod/...` assets should keep mirrored local assets aligned with the shared system rather than re-inventing a second design language

Detailed visual subsystem rules now live in `app/L0/_all/mod/_core/visual/AGENTS.md`.

## App Development Principles

- build new first-party features as modules under `app/L0/_all/mod/_core/<feature>/`
- treat page shells as extension roots, not as the application body
- keep extension files thin and keep real implementation in ordinary module files
- if another feature needs to modify owned behavior, expose a seam in the owner instead of reaching into private internals
- extend the onscreen overlay through the JS seams documented in `_core/onscreen_agent/AGENTS.md` instead of patching `store.js`, `prompt.js`, `skills.js`, or `api.js` from another module
- when a style, helper, or runtime contract will be reused by multiple modules, move it into `_core/visual`, `_core/framework`, or another clearly shared owning module
- do not grow `server/pages/*.html` beyond shell concerns when modules and extension anchors can own the composition
- do not build new repo-owned first-party app features directly inside transient `L1` or `L2` customware

## Current Major Module Owners

- `framework/` owns frontend bootstrap and runtime primitives; see `app/L0/_all/mod/_core/framework/AGENTS.md`
- `router/` owns the authenticated app shell, routing, and routed extension anchors; see `app/L0/_all/mod/_core/router/AGENTS.md`
- `dashboard/` owns the routed dashboard shell and its dashboard-local extension seam; see `app/L0/_all/mod/_core/dashboard/AGENTS.md`
- `visual/` owns the shared visual system and reusable presentation primitives; see `app/L0/_all/mod/_core/visual/AGENTS.md`
- `admin/` owns the firmware-backed admin shell, panels, and admin-specific skills/runtime glue; see `app/L0/_all/mod/_core/admin/AGENTS.md`
- `admin/views/agent/` owns the admin-side agent surface; see `app/L0/_all/mod/_core/admin/views/agent/AGENTS.md`
- `admin/views/files/` owns the firmware-backed file browser; see `app/L0/_all/mod/_core/admin/views/files/AGENTS.md`
- `admin/views/modules/` owns the firmware-backed modules panel; see `app/L0/_all/mod/_core/admin/views/modules/AGENTS.md`
- `onscreen_agent/` owns the floating routed overlay agent; see `app/L0/_all/mod/_core/onscreen_agent/AGENTS.md`
- `onscreen_menu/` owns the routed shell menu extension; see `app/L0/_all/mod/_core/onscreen_menu/AGENTS.md`
- `spaces/` owns the routed spaces canvas, empty-canvas prompt, widget SDK, and persisted centered-coordinate space runtime; see `app/L0/_all/mod/_core/spaces/AGENTS.md`

## Guidance

- keep root HTML shells thin and static; session gating belongs in the server router, not in inline frontend boot code
- cache empty extension lookups as valid results; a missing extension point should not cause repeated polling
- because extension lookups are cached in memory, adding new `ext/html/...` or `ext/js/...` files often requires a refresh before the running page discovers them
- browser-side file changes still require a manual browser refresh; live reload is not wired into the app runtime yet
- when you add or change a stable app seam, update the owning local doc and this file if the app-wide composition model changed
