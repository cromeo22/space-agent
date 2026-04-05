# AGENTS

## Purpose

`_core/spaces/` owns the main user-facing spaces canvas.

It is the routed feature module that lists spaces, opens a selected space, persists per-space manifests and per-widget YAML files under the authenticated user's app files, exposes `space.current` plus the stable `space.spaces` runtime namespace, and replays widget renderers into the framework-owned grid.

Documentation is top priority for this module. After any change under `_core/spaces/`, update this file and any affected parent docs in the same session.

## Ownership

This module owns:

- `view.html`: routed spaces canvas shell and widget-grid mount point
- `store.js`: spaces store, route-driven loading, runtime namespace registration, current-space replay, widget-card lifecycle, renderer cleanup, and direct-manipulation layout interactions
- `spaces.css`: spaces shell layout, widget-grid styling, and lightweight widget fallback presentation
- `widget-content.css`: widget-body markdown and shared content presentation for rendered widget output
- `dashboard-launcher.html`, `dashboard-launcher.js`, and `dashboard-launcher.css`: dashboard-injected spaces launcher surface
- `constants.js`: stable route, filesystem, schema, and widget-size constants for this module
- `storage.js`: logical app-file paths, `space.yaml` and widget-YAML parsing and serialization, space CRUD helpers, legacy widget migration, widget file writes, and public `/~/...` URL resolution
- `layout.js`: grid layout normalization, collision-safe placement, render-size resolution, and centered viewport-width first-fit packing for moving, resizing, minimizing, repairing, and rearranging widgets
- `widget-sdk-core.js` and `widget-sdk.js`: compatibility widget SDK for legacy `defineWidget(...)` modules plus shared widget-size normalization helpers
- `widget-render.js`: lightweight DOM rendering for simple widget return values such as strings, arrays, nodes, or JSON fallbacks
- `ext/html/_core/dashboard/content_end/spaces-dashboard-launcher.html`: thin dashboard extension adapter
- `ext/js/_core/onscreen_agent/prompt.js/buildOnscreenAgentSystemPromptSections/end/current-space.js`: spaces-owned prompt-section injection that reports live current-space widget state to the onscreen agent when the routed space is open
- `ext/skills/spaces/skill.md`: onscreen-agent guidance for creating or updating space widgets; its frontmatter sets `metadata.always_loaded: true` so widget-authoring rules are always present in the onscreen prompt

## Persistence And Widget Contract

Spaces persist under the authenticated user's `~/spaces/<spaceId>/` root.

Current files and folders:

- `space.yaml`: canonical space manifest with `schema`, `id`, `title`, timestamps, layout order, signed position overrides, size overrides, and minimized widget ids
- `widgets/<widgetId>.yaml`: persisted widget definition file with `schema`, `id`, `name`, default `cols`, default `rows`, optional default `col` or `row`, and a multiline `renderer` function source string
- `data/`: widget-owned structured data or downloaded files
- `assets/`: widget-owned images or other static assets referenced through `/~/...` fetch URLs
- new spaces are created empty; do not seed starter widgets into fresh manifests or widget folders
- `listSpaces()` should enumerate manifests by recursively listing the authenticated user's `~/spaces/` root and selecting `spaces/<spaceId>/space.yaml`; if that root does not exist yet, treat it as the normal empty-state case instead of surfacing an error in the dashboard launcher
- `removeSpace(...)` should delete the entire `~/spaces/<spaceId>/` tree recursively instead of trying to remove files piecemeal from the dashboard launcher
- legacy `widgets/*.js` files should be treated as migration input only; `storage.js` now converts them to widget YAML on read and removes the old module files
- `removeWidgets(...)` should rewrite `space.yaml` once, batch-delete the current widget YAML files, and still tolerate already-migrated missing legacy `widgets/*.js` paths

Current widget contract:

- the preferred authoring surface is `space.current.renderWidget({ id, name, cols, rows, renderer })`; the old `defineWidget(...)` module surface remains compatibility-only
- widget ids come from the widget filename; the manifest does not own the canonical widget registry anymore
- the widget `renderer` is stored as one function source string in widget YAML; first-party examples and skills should prefer the concise async-arrow shape shown in `ext/skills/spaces/skill.md`
- the framework creates the widget body element and passes it to `renderer(parent, space, ctx)`
- `renderer(...)` should normally render directly into `parent`; simple returned strings, arrays, nodes, or fallback objects may still be rendered by the framework, but widget primitive helper DSLs are no longer part of this module contract
- widgets that need formatted prose should prefer `space.utils.markdown.render(text, target)` so the framework-owned markdown wrapper and widget-global markdown styles stay aligned
- `renderer(...)` may optionally return a cleanup function, or `{ output, cleanup }`, so rerenders and removals can tear down listeners or timers safely
- the framework owns the outer card, the responsive grid, error states, rerender cleanup, and reload behavior, but it must not inject widget header chrome such as ids, titles, or dimension labels above widget output
- widget default size and optional default position live in the widget YAML file; the actual live layout after rearrange or resize lives in `space.yaml`
- widget size is capped at `12` columns by `12` rows; size normalization and resize interactions must clamp to that ceiling
- generated or agent-authored widgets should choose only the grid footprint they actually need rather than defaulting to oversized cards; one logical grid cell is roughly `85px` square, about `5.3rem` at a `16px` root size, so widget defaults should use a reasonable column/row count and aspect ratio for the rendered content
- generated widget scaffolds should not inject instructional title blocks or storage-explainer copy into the visible widget output

## Runtime Namespace

`store.js` registers both `space.current` and `space.spaces`.

Current stable helpers include:

- `space.current.renderWidget(optionsOrId, cols?, rows?, renderer?)`
- `space.current.removeWidget(widgetId)`
- `space.current.removeWidgets(widgetIds)`
- `space.current.removeAllWidgets()`
- `space.current.reload()`
- `space.current.reloadWidget(widgetId)`
- `space.current.repairLayout()`
- `space.current.rearrange()`
- `space.current.rearrangeWidgets([{ id, col?, row?, cols?, rows? }, ...])`
- `space.current.saveLayout({ ... })`
- `space.current.saveMeta({ ... })`
- `space.current.toggleWidgets(widgetIds)`
- `space.current.widgets`
- `space.current.byId`
- `space.spaces.items`
- `space.spaces.all`
- `space.spaces.byId`
- `space.spaces.current`
- `space.spaces.listSpaces()`
- `space.spaces.readSpace(spaceId)`
- `space.spaces.createSpace(options?)`
- `space.spaces.removeSpace(spaceId?)`
- `space.spaces.openSpace(spaceId, options?)`
- `space.spaces.reloadWidget(widgetId | { widgetId, spaceId? })`
- `space.spaces.rearrangeWidgets({ spaceId?, widgets })`
- `space.spaces.saveSpaceMeta({ id, ... })`
- `space.spaces.saveSpaceLayout({ id, widgetIds?, widgetPositions?, widgetSizes?, minimizedWidgetIds? })`
- `space.spaces.toggleWidgets({ spaceId?, widgetIds })`
- `space.spaces.upsertWidget({ spaceId?, widgetId?, name?, cols?, rows?, renderer?, source? })`
- `space.spaces.renderWidget(optionsOrId, cols?, rows?, renderer?)`
- `space.spaces.removeWidget({ spaceId?, widgetId })`
- `space.spaces.removeWidgets({ spaceId?, widgetIds })`
- `space.spaces.removeAllWidgets(spaceId? | { spaceId? })`
- `space.spaces.reloadCurrentSpace()`
- `space.spaces.repairLayout(spaceId?)`
- `space.spaces.getCurrentSpace()`
- `space.spaces.createWidgetSource(options?)`
- `space.spaces.resolveAppUrl(logicalPath)`

Current runtime split:

- Alpine UI state lives in the `spacesPage` store exposed as `$store.spacesPage`
- current-space browser authoring should go through `space.current`
- `space.current.widgets` and `space.current.byId` should expose each live widget's `id`, `name`, `state`, `position`, logical `size`, and `renderedSize` so prompt injection and browser execution can reason about the current canvas without re-reading `space.yaml`
- cross-space CRUD, collections, and lower-level helpers live under `space.spaces`
- caught spaces errors should be logged with `console.error(...)` before the UI shows its fallback notice
- while the routed spaces canvas is open, the spaces-owned prompt extension should inject a `## Current Open Space` section through `_core/onscreen_agent/prompt.js/buildOnscreenAgentSystemPromptSections` that includes the current space id and title, widget order, and each widget's id, name, state, position, and size, plus the current-space batch helper signatures
- the routed spaces page should stay canvas-only; listing spaces, creating spaces, and other management chrome belong on dashboard or overlay seams, not inside the space itself
- a space with zero widgets should render the centered empty-canvas prompt with the login-style floating title motion instead of injecting demo widget content, and the prompt headline should stay white, regular-weight, and keep its intended short line breaks when viewport width allows
- the empty-canvas prompt should also show a muted, non-animated example grid under the floating headline so the page suggests the kinds of agent-driven spaces users can ask for
- the example grid should use clickable prompt buttons that route through `space.onscreenAgent.submitPrompt(...)` rather than reaching into overlay DOM internals, and those prompts should preserve the overlay's current display mode unless a mode is explicitly requested
- the persisted widget coordinate system is centered: `0,0` is the canvas origin at screen center, positions can be negative, and widget positions are saved as signed logical grid coordinates rather than viewport-relative offsets
- the visible space canvas should stay viewport-sized with no native scrollbars and should visually cover the whole routed page width; navigation outside the initial view happens through explicit background drag panning, not by turning the page into a tall scroll surface
- the spaces root may keep a local viewport-bleed fallback so the canvas still fills the screen even if an upstream routed shell wrapper remains narrower than the viewport
- grid cells should stay square; on wider screens the canvas should reveal more columns rather than stretching each column wider than its row height
- the canvas navigation model is camera-based: background dragging pans the visible window over the logical grid without resetting to keep widgets in frame, and camera movement is clamped to the current widget extent instead of allowing unbounded travel away from placed content
- wheel navigation should pan the same camera in both axes using the browser-provided `WheelEvent` deltas directly, only normalizing `deltaMode` for line/page units, and should not hijack wheel input from widget-local scroll containers that can still scroll natively
- widgets can be moved by the subtle full-width top drag strip, reloaded from the left header control, resized from the bottom-right handle, minimized from the top control button, and removed from the top close button
- icon-bearing header controls such as reload and close should render with the shared `x-icon` glyph path instead of raw text characters so the control chrome stays visually aligned
- widget header controls must stay pointer-interactive above the drag strip; clicking reload, minimize, or close must not fall through into widget-move drag start
- widget cards should use one flat dark surface color rather than a gradient, and the header chrome should use that same surface color with light transparency plus a restrained blur so text never overlaps title or control icons while scrolling underneath
- the widget body is the scroll owner; its header-offset and bottom padding must stay inside the card height so resized widgets can scroll all the way to their last content line without clipping the bottom edge
- widget keyboard handling must not steal normal onscreen-agent chat typing through global plain-key listeners; widgets that need keyboard input should either listen only while their own DOM is focused or use modified shortcuts such as `Ctrl` or `Cmd` combinations instead of bare letters, `Space`, or bare `Enter`
- widget content should stay responsive to its own card dimensions and to later user resizes; avoid renderer layouts that depend on one fixed widget size, and prefer flexible wrapping, percentage-based sizing within the widget body, and local scrolling when content outgrows the available area
- move and resize interactions should feel smooth during pointer movement, then resolve and persist onto the snapped logical grid when released; temporary grid lines should appear only during widget move or resize, not during background pan, and dragging near the viewport edge may nudge the camera slowly but must stay within the existing widget bounds
- widget titles belong in the top bar so minimized widgets remain identifiable
- the outer widget card is the only required visual container; generated widget renderers should not impose their own nested rounded card backgrounds by default unless the user explicitly asks for that extra chrome
- widget removal should delete the current widget file and tolerate a missing legacy widget-file path instead of failing the close action on already-migrated spaces
- the routed canvas currently includes a small `Rearrange` button that recenters the camera at `0,0`, preserves minimized widgets, and rewrites widget positions into a centered packed layout that scans cells left to right and top to bottom, skips occupied cells immediately, and at each free cell places the largest remaining widget that fits within the viewport-width column threshold before moving onward; when continuing on the current row would make the occupied layout too thin, the packer should advance to the next row instead
- widgets created through `space.current.renderWidget(...)`, `space.spaces.renderWidget(...)`, or `space.spaces.upsertWidget(...)` should default into the first-fit best open slot under that same viewport-width packing rule rather than always starting at the origin or a static fallback coordinate, including the same verticality guard used by rearrange
- full space replays, including refreshes and agent-driven widget additions, should use a short fade-in so content does not pop in abruptly

Current dashboard integration:

- `_core/dashboard/` exposes the `_core/dashboard/content_end` seam
- `_core/spaces` injects the existing-space list, each space id, per-space delete action, and New Space launcher through that seam
- dashboard-specific spaces UI should stay in this module, not in the dashboard owner

## Development Guidance

- keep persistence in logical app files under `~/spaces/`; do not introduce server-owned special storage for spaces
- keep `space.yaml` and widget YAML files within the lightweight YAML subset that the shipped parser can round-trip reliably, including multiline block scalars for renderer source
- keep layout normalization non-recursive for both size and position coercion so malformed or defaulted manifest values cannot blow the stack during space load
- keep manifest normalization compatible with both serialized string size tokens and in-memory widget-size objects so persisted resizes survive refreshes
- keep rearrange packing deterministic and viewport-aware: prefer greedy largest-first cell scanning within a viewport-width column threshold over a simple one-line strip, while still returning stable non-overlapping logical coordinates centered back onto the canvas
- keep the verticality guard shared across rearrange and default new-widget placement: evaluate occupied width, occupied height, and fill ratio together, and advance to the next row when the projected layout becomes too horizontally thin
- keep new-widget auto-placement and rearrange on the same shared first-fit placement logic instead of duplicating separate heuristics in store and storage layers
- keep current-space external mutations smooth: when the active space replays after agent-driven widget add or layout changes, prefer in-place re-render with previous-rect animation and camera preservation instead of a full loading-state reset
- keep spaces height on a stable viewport-sized path that does not rely on fragile percentage-height chains; do not subtract stale fixed chrome heights such as old `100dvh - 5.5rem` offsets inside `spaces.css`
- keep widget renderers isolated and replayable; use the framework-owned grid rather than storing DOM snapshots
- keep widget-wide markdown or prose presentation in `widget-content.css` so direct widget rendering and markdown helpers share one global style owner
- do not rebuild widget primitive helper DSLs here; prefer direct DOM rendering and `space.utils.markdown.render(...)`
- if the routed feature contract, runtime namespace, or persisted space layout changes, update this file and `/app/AGENTS.md`
