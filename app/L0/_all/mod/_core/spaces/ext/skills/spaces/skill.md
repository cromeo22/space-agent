---
name: Spaces Widgets
description: Create or update persisted space widgets through `space.current.renderWidget(...)` and the `_core/spaces` layout helpers.
metadata:
  always_loaded: true
---

Use this skill when the user asks the agent to create, update, rearrange, or remove widgets inside a space.

## Storage Layout

- Spaces live under `~/spaces/<spaceId>/`.
- The manifest is `~/spaces/<spaceId>/space.yaml`.
- Widget files live under `~/spaces/<spaceId>/widgets/<widgetId>.yaml`.
- Widget-owned support files can live under `~/spaces/<spaceId>/data/` or `~/spaces/<spaceId>/assets/`.
- `space.yaml` stores space metadata plus the live layout.
- Each widget YAML file stores the widget metadata and the renderer code together in one file.

## Prefer The Runtime Helpers

The spaces module exposes `space.current` for the open space and `space.spaces` for broader CRUD.

Useful helpers:

- `space.current.renderWidget({ id, name, cols, rows, renderer })`
- `space.current.removeWidget(widgetId)`
- `space.current.removeWidgets(["widget-id", ...])`
- `space.current.removeAllWidgets()`
- `await space.current.reload()`
- `await space.current.repairLayout()`
- `await space.current.rearrange()`
- `await space.current.rearrangeWidgets([{ id, col?, row?, cols?, rows? }, ...])`
- `await space.current.toggleWidgets(["widget-id", ...])`
- `space.current.widgets`
- `space.current.byId`
- `await space.spaces.listSpaces()`
- `await space.spaces.createSpace({ title })`
- `await space.spaces.removeSpace(spaceId)`
- `await space.spaces.openSpace(spaceId)`
- `await space.spaces.rearrangeWidgets({ spaceId?, widgets })`
- `await space.spaces.saveSpaceMeta({ id, title })`
- `await space.spaces.saveSpaceLayout({ id, widgetIds?, widgetPositions?, widgetSizes?, minimizedWidgetIds? })`
- `await space.spaces.toggleWidgets({ spaceId?, widgetIds })`
- `await space.spaces.upsertWidget({ spaceId?, widgetId?, name?, cols?, rows?, renderer?, source? })`
- `await space.spaces.removeWidgets({ spaceId?, widgetIds })`
- `await space.spaces.removeAllWidgets(spaceId? | { spaceId? })`
- `space.utils.markdown.render(text, target)`
- `space.spaces.items`
- `space.spaces.byId`
- `space.spaces.createWidgetSource({ id, name, cols, rows, renderer })`

If the user is already inside a space, prefer `space.current.*`. Freshly created spaces are empty canvases, so write the first widget yourself instead of expecting starter content.
While a space is open, the onscreen system prompt also injects the live `space.current.widgets` snapshot; those widget entries include `state`, `position`, logical `size`, and `renderedSize`.

## Widget Authoring Contract

Preferred shape:

```js
return await space.current.renderWidget({
  id: "hello",
  name: "Hello",
  cols: 6,
  rows: 3,
  renderer: async (parent, spaceRef) => {
    spaceRef.utils.markdown.render(
      [
        "### Hello widget",
        "",
        "Rendered directly from one YAML file."
      ].join("\\n"),
      parent
    );
  }
})
```

Rules:

- `return await space.current.renderWidget(...)` so browser execution confirms the result instead of finishing with no returned value.
- Widget size is capped at `12` columns by `12` rows. Do not ask for or persist anything larger than `12x12`.
- Choose a reasonable widget size based on the actual content instead of defaulting to oversized cards. One grid cell is roughly `85px` square, which is about `5.3rem` at a `16px` root font size, so pick sensible column and row counts and a reasonable aspect ratio for the UI you are rendering.
- Render into `parent`; for markdown-heavy output, prefer `space.utils.markdown.render(markdownText, parent)`.
- Prefer the batch helpers over manual `saveSpaceLayout(...)` map surgery when the task is to move, minimize, restore, or delete several widgets.
- Widget content should adapt to the chosen card size and continue to behave correctly when the user resizes the widget later. Avoid layouts that only work at one exact size; prefer flexible wrapping, internal scrolling where appropriate, and sizing that follows the widget body instead of hard-coded viewport assumptions.
- If you attach listeners, timers, or other long-lived effects, return a cleanup function from `renderer(...)`.
- Do not patch unrelated global page DOM from widgets. Keep effects scoped to the widget unless there is an explicit user request.
- Do not capture plain unmodified keys from `window`, `document`, or other global listeners in ways that block typing into chat. If a widget needs keyboard input, require focus on the widget itself, or use modified shortcuts such as `Ctrl` or `Cmd` combinations instead of plain keys like letters, `Space`, or bare `Enter`.

## Recommended Agent Flow

1. Inspect or create the target space with `space.current` or `space.spaces`, and read `space.current.widgets` when a space is already open.
2. Write or rewrite widgets through `space.current.renderWidget(...)`.
3. Use `await space.current.rearrangeWidgets(...)`, `await space.current.toggleWidgets(...)`, `await space.current.removeWidgets(...)`, or `await space.current.removeAllWidgets()` for batch layout or state changes.
4. Call `await space.current.repairLayout()` after bulk edits or if layout collisions are possible.
5. Call `await space.current.rearrange()` only when the user explicitly wants the built-in packed centered recovery layout.
6. Call `await space.current.reload()` only when you need to force a fresh replay.

## Persistence Rule

- Rewrite widgets by widget id instead of trying to patch previous DOM output.
- The manifest controls live order, live positions, live sizes, and minimized state.
- Widget YAML files control widget identity, default size, optional default position, and renderer code.
- Positions use a centered logical grid where `0,0` is the canvas origin and negative coordinates are valid.
