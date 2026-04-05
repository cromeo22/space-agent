# AGENTS

## Purpose

`_core/admin/views/agent/` owns the admin-side agent surface.

It is a standalone admin module inside `_core/admin/`, with its own prompt files, persistence, attachments, execution loop, settings, and rendering helpers. It should not depend on `_core/onscreen_agent` internals.

Documentation is top priority for this surface. After any change under `views/agent/`, update this file and any affected parent docs in the same session.

## Ownership

This surface owns:

- `panel.html`: mounted admin agent UI
- `store.js`: main state, send loop, compaction flow, dialog control, and persistence orchestration
- `api.js`, `prompt.js`, `execution.js`, `attachments.js`, `llm-params.js`, and `view.js`: local runtime helpers
- `config.js` and `storage.js`: persisted settings and history contract
- `system-prompt.md`, `compact-prompt.md`, and `compact-prompt-auto.md`: firmware prompt files
- `skills.js`: admin skill catalog building and `space.admin.loadSkill(...)`

## Persistence And Prompt Contract

Current persistence paths:

- config: `~/conf/admin-chat.yaml`
- history: `~/hist/admin-chat.json`

Current stored config fields are written in YAML as:

- `api_endpoint`
- `api_key`
- `model`
- `params`
- `max_tokens`
- optional `custom_system_prompt`

Current defaults:

- API endpoint: `https://openrouter.ai/api/v1/chat/completions`
- model: `openai/gpt-5.4-mini`
- params: `temperature:0.2`
- compaction threshold: `64000` tokens

Prompt rules:

- `system-prompt.md` is the fixed firmware prompt
- user-authored custom instructions are stored separately and injected under `## User specific instructions`
- `compact-prompt.md` is used for user-invoked history compaction
- `compact-prompt-auto.md` is used for automatic compaction during the loop
- the runtime prompt also appends the current admin skill catalog built from `skills/*/SKILL.md`

## Execution And UI Contract

Current behavior:

- browser execution blocks are detected by the `_____javascript` separator
- `execution.js` runs browser-side JavaScript in an async wrapper and formats console output and result values for the thread
- when an execution follow-up turn returns no assistant content, the runtime retries the same request once automatically before sending a short protocol-correction user message
- empty-response protocol-correction messages must not re-echo the prior execution output; they should tell the agent to continue from the execution output above or provide the user-facing answer
- loaded admin skills are passed through execution as typed runtime values, not pasted blindly into the prompt
- the surface uses the shared visual dialog helpers and shared thread renderer from `_core/visual`
- `view.js` enables the shared marked-backed chat-bubble markdown renderer so settled admin chat bubbles render markdown consistently with the onscreen agent
- `store.js` publishes the active admin thread snapshot at `space.chat`, including `messages` and live `attachments` helpers for the current surface
- assistant streaming is patched into the existing DOM at animation-frame cadence instead of full-thread rerenders
- prompt history token counts are tracked, shown in the UI, and used for compaction decisions
- the composer accepts attachments from either the file picker or direct file drag-and-drop onto the chat box
- the composer is disabled while compaction is actively running
- the loop supports stop requests and queued follow-up submissions
- restored attachment metadata is revalidated against current file availability

## Development Guidance

- keep all admin-agent-specific runtime logic local to this folder
- do not import `_core/onscreen_agent` internals for convenience
- prefer shared visual primitives from `_core/visual` for presentation and keep surface behavior here
- if you change persistence paths, skill discovery, execution protocol, or prompt composition, update this file and the parent admin docs
