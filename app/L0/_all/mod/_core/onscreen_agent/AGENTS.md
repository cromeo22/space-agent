# AGENTS

## Purpose

`_core/onscreen_agent/` owns the floating routed overlay agent.

It mounts into the router overlay layer, keeps its own floating shell, prompt files, persistence, attachments, execution loop, and overlay-specific interaction model, and reuses shared visual primitives for rendering and dialogs. It is the first-party user-facing agent surface under `_core/`.

Documentation is top priority for this module. After any change under `_core/onscreen_agent/`, update this file and any affected parent docs in the same session.

## Documentation Hierarchy

`_core/onscreen_agent/AGENTS.md` owns the overlay runtime, shared onscreen skill-loading contract, and the map of deeper docs inside this subtree.

Current deeper docs:

- `app/L0/_all/mod/_core/onscreen_agent/ext/skills/development/AGENTS.md`

Update rules:

- update this file when overlay-wide runtime behavior, skill loading, or ownership boundaries change
- update the deeper development-skill doc when the development skill tree, routing map, or mirrored source contracts change
- when framework, router, API, path, permission, or auth contracts change in ways that affect the development skill tree, update the deeper doc in the same session

## Ownership

This module owns:

- `ext/html/page/router/overlay/end/onscreen-agent.html`: thin adapter that mounts the overlay into the router overlay seam
- `ext/skills/`: starter onscreen-agent skill folders, each ending in `skill.md`
- `panel.html`: overlay UI
- `response-markdown.css`: overlay-local markdown presentation overrides for assistant responses
- `store.js`: floating-shell state, send loop, persistence, avatar drag behavior, history resize behavior, display mode, and overlay menus
- `view.js`: shared-thread-view wiring
- `skills.js`: onscreen skill catalog building, skill frontmatter metadata flags, automatic skill-prompt sections, `space.skills.load(...)`, and skill-related JS extension seams
- `api.js`, `prompt.js`, `execution.js`, `attachments.js`, and `llm-params.js`: local runtime helpers, with `api.js` and `prompt.js` also owning request and prompt JS extension seams
- `config.js` and `storage.js`: persisted settings, position, display mode, and history
- `system-prompt.md`, `compact-prompt.md`, and `compact-prompt-auto.md`: shipped prompt files
- `res/`: overlay-local assets
- the `space.onscreenAgent` runtime namespace for overlay display control and externally triggered prompt submission

## Persistence And Prompt Contract

Current persistence paths:

- config: `~/conf/onscreen-agent.yaml`
- history: `~/hist/onscreen-agent.json`

Current config fields include:

- provider settings and params
- `max_tokens`
- optional `custom_system_prompt`
- `agent_x`
- `agent_y`
- optional `history_height`
- `display_mode`

Legacy compatibility:

- `display_mode` is the canonical persisted mode field
- `storage.js` still accepts legacy `collapsed` values when older configs are loaded
- `storage.js` also normalizes numeric coordinate scalars from the lightweight YAML parser before the overlay store applies `agent_x` and `agent_y`
- when config is rewritten, legacy `collapsed` is mirrored from `display_mode` so the two fields do not drift

Current defaults:

- API endpoint: `https://openrouter.ai/api/v1/chat/completions`
- model: `openai/gpt-5.4-mini`
- params: `temperature:0.2`
- max tokens: `64000`
- default display mode: compact

Prompt rules:

- `system-prompt.md` is the firmware prompt
- custom instructions are appended under `## User specific instructions`
- skill frontmatter may include a `metadata` object for runtime-owned flags; `metadata.always_loaded: true` marks a readable skill file for automatic prompt inclusion
- the runtime prompt appends the top-level onscreen skill catalog built from readable `mod/*/*/ext/skills/*/skill.md` files
- after that catalog, the runtime appends a separate `## Automatically Loaded Skills` section containing repeated `path: <skill-id>` lines plus the full skill file content for readable `mod/*/*/ext/skills/**/skill.md` entries whose frontmatter sets `metadata.always_loaded: true`
- prompt construction exposes JS seams at `_core/onscreen_agent/prompt.js/fetchDefaultOnscreenAgentSystemPrompt`, `_core/onscreen_agent/prompt.js/fetchOnscreenAgentHistoryCompactPrompt`, `_core/onscreen_agent/prompt.js/buildOnscreenAgentSystemPromptSections`, and `_core/onscreen_agent/prompt.js/buildRuntimeOnscreenAgentSystemPrompt`
- prompt extensions should prefer the sections seam when they need to append or replace whole prompt sections; the final builder seam is for last-mile rewrites of the assembled string
- `_core/spaces` currently uses the sections seam to inject a live `## Current Open Space` block only while the routed spaces canvas is open, sourcing widget ids, names, order, positions, sizes, and state from `space.current`
- the firmware prompt should treat `space.api.userSelfInfo().scope` as the canonical way to discover readable and writable frontend roots before development-oriented file changes
- the firmware prompt should also remind the agent to `return await ...` for browser mutations that need confirmation, should explicitly use `return await space.current.renderWidget(...)` instead of fire-and-forget widget writes, should keep widget-rendering guidance short and example-driven, should point widget authors at `space.utils.markdown.render(text, target)` for simple markdown output inside widgets, should refer to the active thread as `space.chat`, should use `space.utils.yaml.parse(...)` plus `space.utils.yaml.stringify(...)`, and should keep the current spaces widget-size ceiling (`12x12`) explicit
- `compact-prompt.md` is used for user-triggered history compaction
- `compact-prompt-auto.md` is used for automatic compaction during the loop

## JS Extension Seams

Overlay chat behavior is intentionally extensible through `ext/js/` hooks rather than private store patching.

Current stable seams:

- `skills.js` exposes `_core/onscreen_agent/skills.js/listDiscoveredSkillFiles`, `_core/onscreen_agent/skills.js/loadOnscreenSkillIndex`, `_core/onscreen_agent/skills.js/loadOnscreenSkillCatalog`, `_core/onscreen_agent/skills.js/buildOnscreenSkillsPromptSection`, `_core/onscreen_agent/skills.js/buildOnscreenAutomaticallyLoadedSkillsPromptSection`, `_core/onscreen_agent/skills.js/loadOnscreenSkill`, and `_core/onscreen_agent/skills.js/installOnscreenSkillRuntime`; use these to add virtual skills, rewrite the visible skill catalog, override automatic-skill prompt injection, override skill loads, or augment `space.skills`
- `api.js` exposes `_core/onscreen_agent/api.js/prepareOnscreenAgentCompletionRequest` and `_core/onscreen_agent/api.js/streamOnscreenAgentCompletion`; request-prep hooks receive the outbound `headers`, `requestBody`, `requestUrl`, and derived `messages`, and `requestBody` is the authoritative payload sent to the LLM
- `store.js` exposes `_core/onscreen_agent/store.js/processOnscreenAgentMessage`; it runs before overlay messages are committed or reused after key lifecycle steps and receives a context object with `phase`, `message`, `history`, and `store`

Current runtime namespace:

- `store.js` also registers `space.onscreenAgent`
- `store.js` also publishes the active overlay thread snapshot at `space.chat`, including `messages` and live `attachments` helpers for the current surface
- `space.onscreenAgent.show(options?)` opens the overlay without submitting a prompt and preserves the current display mode unless `options.mode` explicitly requests compact or full
- `space.onscreenAgent.submitPrompt(promptText, options?)` opens the overlay, seeds the composer, and submits or queues the prompt through the owned send loop while preserving the current display mode unless `options.mode` explicitly requests compact or full

Current `processOnscreenAgentMessage` phases:

- `submit`: a user draft was converted into the first outbound message
- `assistant-response`: a streamed assistant reply finished, or a stopped reply produced partial content, before metrics and persistence run
- `execution-output`: browser execution results were converted into the follow-up user message
- `execution-retry`: the overlay is generating a protocol-correction retry message
- `history-compact`: history compaction produced the replacement summary message

Phase-specific context fields may include `draftSubmission`, `responseMeta`, `executionResults`, `executionOutputMessage`, or compaction `mode`.

## Overlay Contract

Current overlay behavior:

- the module mounts only through the router overlay seam at `page/router/overlay/end`
- the shell supports compact and full display modes
- avatar drag positioning, action menus, history-edge resizing, and visibility recovery are owned by `store.js`
- `panel.html` passes `shell`, `avatar`, panel, thread, and dialog refs into `store.js`; the store uses those refs to clamp the saved position against the current viewport and to detect when the astronaut has drifted fully off-screen
- the full-mode history subtree mounts only in full mode; compact mode does not keep a history container mounted
- the full-mode history uses a non-scrolling outer shell for placement, chrome, and the resize grip, with an inner scroller that owns thread overflow
- in full mode, the history panel can be resized vertically from a full-width invisible handle that straddles the outer top or bottom border based on orientation, while a centered grip marks the draggable edge and the chosen height persists in config
- when full mode mounts, the history shell resets its raw height to the currently available viewport space on the chosen side, using the panel geometry before mount and the history shell geometry after mount, so expansion never keeps a stale oversize height
- the compact and full composer panels accept attachments from either the file picker or direct file drag-and-drop onto the chat box
- saved `agent_x`, `agent_y`, and `display_mode` are loaded during init before prompt startup continues, and the floating shell stays unmounted until that startup config load has resolved so refreshes never flash the default bottom-left position before the stored coordinates are applied
- the first shell paint should ease in with a short reveal once startup positioning is ready, but avoid ancestor opacity fades on the shell itself because they break the backdrop blur used by the history and composer surfaces
- internal startup statuses such as prompt bootstrapping may gate controls, but they should not replace the composer placeholder because they are not user-relevant; user-visible errors and action results should still surface through `status`
- when the persisted LLM settings still match the shipped defaults and the API key is blank, the composer blocks the full textarea area with a blurred overlay and centered `Set API key` action until credentials are configured
- in compact mode, when a streamed assistant reply reaches the `_____javascript` separator, the UI bubble should surface the pre-execution reply text immediately while the composer status switches into the code-writing placeholder; do not wait for browser execution to finish before showing that bubble
- after mount and after config load, the store re-clamps the saved position to the current viewport and persists any correction back to config
- while mounted, the store also re-checks visibility on resize, `visibilitychange`, `focus`, `pageshow`, and on a periodic timer so monitor changes or desktop switches cannot leave the astronaut permanently off-screen
- browser execution blocks use the `_____javascript` separator and are executed locally through `execution.js`
- the surface uses the shared `createAgentThreadView(...)` renderer from `_core/visual/conversation/thread-view.js`
- `view.js` enables the shared marked-backed chat-bubble markdown renderer for the overlay and assigns the `onscreen-agent-response-markdown` class so assistant-response-specific heading and table tuning stays local to this module
- `panel.html` loads `response-markdown.css` after the base overlay stylesheet; keep assistant-response markdown element overrides there instead of patching `_core/visual` for overlay-only presentation, and style markdown tables through the shared `.message-markdown-table-wrap` wrapper rather than changing the table element into a scroll container
- the compact floating UI bubble is a separate overlay surface owned by `panel.html`, `store.js`, and `onscreen-agent.css`; it should render through the shared markdown helper into a local content ref instead of using plain `x-text`
- native dialogs use the shared dialog helpers from `_core/visual/forms/dialog.js`
- lightweight action menus use the shared popover positioning helper from `_core/visual/chrome/popover.js`
- the floating root and its compact action menu reserve effectively topmost z-index bands so routed content and dynamically rendered surfaces do not obstruct the overlay controls
- the compact composer action menu stays hidden through its initial positioning passes, closes when avatar dragging starts, and chooses up or down placement from the trigger button midpoint against the 50% viewport line rather than reusing the UI bubble breakpoint
- history-destructive controls must stay disabled when the thread is empty: full-mode footer `Clear chat`, full-mode footer `Compact context`, and compact-mode action-menu entries for those same actions should all be unavailable until history exists
- the loop supports queued follow-up submissions, stop requests, attachment revalidation, and animation-frame streaming patches; when the direct streaming-row patch cannot apply, the full-mode thread should fall back to a frame-batched full render so assistant history still updates live
- prompt-history previews and token counts are derived from the prepared outbound request payload so request-prep extensions stay visible in the context window instead of only affecting the final fetch call
- when an execution follow-up turn returns no assistant content, the runtime retries the same request once automatically before sending a protocol-correction user message
- empty-response protocol-correction messages must stay short, must not re-echo the prior execution output, and should tell the agent to continue from the execution output above
- `space.skills.load("<path>")` loads onscreen skills on demand using skill ids relative to `ext/skills/` and excluding the trailing `/skill.md`
- only top-level skills are injected into the prompt catalog by default; routing skills can direct the agent to deeper skill ids
- any readable skill at any depth may also be auto-injected into the prompt when its frontmatter sets `metadata.always_loaded: true`
- loaded onscreen skills are captured as execution-side effects and inserted into the user-side execution-output message with the full skill file content, even when the JavaScript block uses plain `await space.skills.load(...)` without a final `return`
- skill discovery uses the app-file permission model plus layered owner-scope ordering, and same-module layered overrides replace lower-ranked skill files before the catalog is built
- readable group-scoped modules such as `L0/_admin/mod/...` may contribute additional onscreen skills; those skills are visible only to users who can read that group root
- skill ids must be unique across readable modules; conflicting ids are omitted from the prompt catalog and load attempts fail with an ambiguity error

## Development Guidance

- keep overlay-specific behavior local to this module
- do not import admin-agent internals for convenience
- use the router overlay seam rather than reaching around the router shell
- when another module needs to change overlay prompt, skill, request, or message behavior, add or consume the local JS seams here instead of reaching into private store state from outside the module
- keep onscreen skill discovery and runtime behavior separate from the admin agent even when copying skill content for starter coverage
- keep `ext/skills/development/` aligned with the current frontend and read-only backend contracts so the onscreen agent's development guidance does not drift
- if behavior becomes meaningfully shared with the admin agent, promote it into `_core/framework` or `_core/visual` instead of creating cross-surface dependencies
- if you change the router overlay contract, persistence paths, skill discovery, or prompt execution behavior, update this file and the relevant parent docs in the same session
