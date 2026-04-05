# AGENTS

## Purpose

`_core/framework/` is the shared frontend platform layer.

It owns browser bootstrap, runtime installation, extension loading, component loading, Alpine integration, API client helpers, and small cross-feature utilities. It should stay generic and reusable. Feature-specific behavior belongs in owning modules, not here.

Documentation is top priority for this module. After any change under `_core/framework/`, update this file and any affected parent docs in the same session.

## Ownership

This module owns:

- `js/initFw.js`: shared frontend bootstrap entry for framework-backed pages
- `js/runtime.js`: runtime installation onto `globalThis.space`
- `js/markdown-frontmatter.js`: markdown frontmatter parsing plus safe markdown-to-DOM rendering helpers
- `js/server-config.js`: injected page-meta parsing for frontend-exposed backend runtime parameters
- `js/extensions.js`: `space.extend`, HTML extension loading, JS hook loading, lookup caching, and batching
- `js/moduleResolution.js`: propagation of `maxLayer` into framework-managed module and extension requests
- `js/components.js`: `<x-component>` loading, recursive component imports, and `xAttrs(...)`
- `js/AlpineStore.js`: store registration helper used by the runtime and legacy modules
- Alpine directives and magic helpers registered during bootstrap
- shared browser API helpers in `js/api-client.js`, `js/api.js`, `js/fetch-proxy.js`, `js/download.js`, and `js/proxy-url.js`
- small shared parsing and utility helpers such as markdown frontmatter, YAML, and token counting
- shared framework CSS and icon font assets under `css/`

## Boot And Runtime Contract

Framework-backed page shells load `/mod/_core/framework/js/initFw.js` once.

Current boot order:

1. `initFw.js` imports `extensions.js` first so `space.extend` exists before other framework modules expose seams.
2. `initializeRuntime(...)` publishes the shared runtime onto `globalThis.space`.
3. `initializer.initialize()` runs the first extensible framework bootstrap step.
4. Alpine and framework support modules are loaded.
5. Framework directives and magic helpers are registered.

`initializeRuntime(...)` currently publishes:

- `space.api`
- `space.config`
- `space.chat` when an agent surface publishes the active thread messages plus attachment handles
- `space.fw.createStore`
- `space.utils.markdown.render(text, target)` as a simple browser wrapper around the shared marked renderer; it replaces `target` contents with a `.markdown` root when a target is provided
- `space.utils.markdown.parseDocument`
- `space.utils.yaml.parse` and `stringify`, including multiline block-scalar strings used by persisted widget renderer source
- `space.proxy`
- `space.download`
- `space.fetchExternal(...)`

Current API helper contract:

- `space.api.userSelfInfo()` is the canonical frontend snapshot for authenticated identity plus readable and writable logical app roots; frontend agents should use it before choosing where to store files or modules
- `space.api.folderDownloadUrl(pathOrOptions)` builds the same-origin attachment URL for a permission-checked folder ZIP download without fetching the archive into browser memory

Rules:

- do not import `extensions.js` from feature modules just to reach `space.extend`; use `globalThis.space.extend(...)`
- do not publish the runtime into `parent`, `top`, or sibling frames
- if bootstrap order changes, update this doc and `/app/AGENTS.md`

## Extension And Component System

`extensions.js` owns both HTML extension lookup and JS hook execution.

Important contracts:

- `<x-extension id="some/path">` resolves HTML adapters from `mod/<author>/<repo>/ext/html/some/path/*.html`
- `space.extend(import.meta, ...)` requires a valid module ref and wraps standalone functions only
- `space.extend(...)` and `callJsExtensions("some/path", ...)` resolve JS hook files from `mod/<author>/<repo>/ext/js/<extension-point>/*.js` or `*.mjs`
- extension callers should name only the seam; the runtime chooses the `html/` or `js/` subfolder implicitly
- wrapped functions expose `/start` and `/end` hook points and become async
- uncached extension lookups are batched to one `/api/extensions_load` request per frame
- empty extension lookups are cached as valid results
- `moduleResolution.js` preserves page-level `maxLayer` for `/mod/...` and `/api/extensions_load` requests

`components.js` owns `<x-component>` loading.

Current loader behavior:

- component sources may be full HTML documents or fragments
- stylesheets and styles are appended to the target element
- module scripts are loaded through dynamic `import()`
- nested `<x-component>` nodes are loaded recursively
- parent wrapper attributes are exposed to descendants through `xAttrs($el)`

Rules:

- keep `ext/html/` adapter files thin and mount real components from owning modules
- keep `ext/js/` hook files focused on hook behavior instead of turning them into alternate feature entry points
- keep components declarative and import feature stores explicitly
- if a hook or component behavior becomes feature-specific, move it out of framework

## Development Guidance

- keep this module focused on platform concerns, not feature logic
- add shared runtime helpers here only when multiple modules genuinely need them
- prefer explicit small runtime namespaces over loose globals
- if a contract is used by only one module, keep it in that module instead of promoting it here too early
- when bootstrap, runtime namespaces, extension loading, or component loading change, also update `app/L0/_all/mod/_core/onscreen_agent/ext/skills/development/` because the onscreen development skill mirrors this module's contract
- when changing bootstrap, runtime namespaces, extension loading, or component loading, update `/app/AGENTS.md` in the same session
