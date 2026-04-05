# AGENTS

## Purpose

`_core/visual/` owns the shared Space Agent visual system.

It provides the reusable canvas, chrome, buttons, dialogs, cards, and conversation rendering primitives that feature modules compose on top of. It should own shared presentation logic, not feature-specific state or workflows.

Documentation is top priority for this module. After any change under `_core/visual/`, update this file and any affected parent docs in the same session.

## Ownership

Current sub-areas:

- `index.css`: shared visual aggregator that imports the reusable layers
- `canvas/`: authenticated shared backdrop CSS and JS runtimes
- `chrome/`: topbar, popover, toast, and light chrome behavior
- `actions/`: shared button and attachment-chip styling
- `forms/`: native dialog styling and helpers
- `conversation/`: shared agent-thread rendering helpers
- `surfaces/`: shared panel and card treatments

## Current Contracts

Canvas:

- `canvas/space-canvas.css` owns the DOM-backed space backdrop visuals for authenticated surfaces
- `canvas/spaceBackdropCore.js` owns the shared backdrop runtime, including resize-safe scale resync that forces `--space-backdrop-scale` back to `1`
- `canvas/spaceBackdropStatic.js` installs the static authenticated backdrop and registers `space.visual.installStaticBackdrop(...)`
- `canvas/spaceBackdropAnimated.js` installs the animated variant and registers `space.visual.installAnimatedBackdrop(...)`
- `canvas/spaceBackdrop.js` re-exports the animated variant as the generic backdrop installer

Chrome:

- `chrome/topbar.css` owns the shared glass topbar and menu-panel contract used by routed menus and admin tabs
- `chrome/popover.css` plus `chrome/popover.js` own the shared fixed-position dropdown or overflow-menu positioning contract
- `chrome/toast.css` plus `chrome/toast.js` own the shared fixed-position toast stack and register `space.visual.showToast(message, options)`

Actions and forms:

- `actions/buttons.css` owns shared `primary-button`, `secondary-button`, and `confirm-button` treatments plus composer-attachment chip styling
- `forms/dialog.css` plus `forms/dialog.js` own the shared native `<dialog>` presentation and open or close helpers

Conversation and surfaces:

- `conversation/thread-view.js` exports `createAgentThreadView(config)` and is the shared renderer used by the admin agent and onscreen agent
- `conversation/thread-view.js` supports an opt-in chat-bubble markdown mode through `config.renderMarkdownWithMarked`; that mode routes settled non-streaming assistant and user bubbles through the shared framework markdown helper, escapes raw HTML before parsing, strips unsafe markdown link or image URLs after render, wraps rendered tables in `.message-markdown-table-wrap`, removes empty generated table headers, and lets the owning feature attach a local assistant markdown class through `config.assistantMarkdownClassName`
- `surfaces/cards.css` owns shared panel or card wrappers such as `space-panel`

## Visual System Rules

- solve shared presentation problems here before cloning styles into feature modules
- keep the overall direction calm, dark, and readable rather than loud or novelty-driven
- avoid putting feature logic, API calls, or store state into this module
- when a primitive is only used by one feature, keep it local until reuse is real
- when changing the shared backdrop system, also review the mirrored public-shell copies in `server/pages/res/space-backdrop.css` and `server/pages/res/space-backdrop.js`

## Development Guidance

- prefer semantic tokens from `_core/framework/css/colors.css`
- prefer composing existing visual primitives over inventing near-duplicates
- keep the baseline bubble markdown layout in `_core/visual/conversation/agent-thread.css`; add only feature-specific markdown tuning in the owning surface stylesheet
- if a feature needs new shared chrome or surface behavior, add the smallest reusable primitive here and keep feature orchestration in the owning module
- if a visual change affects app-wide direction, update `/app/AGENTS.md`; if it affects pre-auth mirrored shells, update `server/pages/AGENTS.md` too
