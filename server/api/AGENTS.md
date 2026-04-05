# AGENTS

## Purpose

`server/api/` contains the HTTP endpoint modules loaded under `/api/<endpoint>`.

This folder should stay thin. Endpoints should validate input, call shared infrastructure helpers, and return explicit results. They should not duplicate auth, filesystem, inheritance, or permission logic that already exists elsewhere in `server/lib/`.

Documentation is top priority for this subtree. After any change under `server/api/`, update this file and any affected parent or helper docs in the same session.

## Discovery Contract

API endpoint modules are discovered dynamically from `server/api/*.js` by `server/lib/api/registry.js`.

Current loader rules:

- every `.js` file in this folder is treated as an endpoint module
- the route name comes from the filename, for example `file_read.js` -> `/api/file_read`
- multiword endpoint names must use object-first underscore naming
- supported exported handlers are `get`, `post`, `put`, `patch`, `delete`, `head`, and `options`
- endpoints are authenticated by default
- endpoints opt into public access only by exporting `allowAnonymous = true`

## Endpoint Families

Public auth and health endpoints:

- `health`
- `guest_create`
- `login_challenge`
- `login`
- `login_check`

Current rules:

- these are the only explicit anonymous endpoints today
- login uses the shared auth service challenge and proof flow unless runtime config disables password login
- successful login sets the `space_session` cookie through the auth service, while the durable session verifier stays in `L2/<username>/meta/logins.json`
- `guest_create` creates an `L2` guest user and refreshes the watchdog only when runtime config allows guest accounts

App-file endpoints:

- `file_list`
- `file_paths`
- `file_read`
- `file_write`
- `file_delete`
- `file_copy`
- `file_move`
- `file_info`
- `folder_download`

Current rules:

- these endpoints delegate to `server/lib/customware/file_access.js`
- they operate on app-rooted paths and supported endpoints also accept `~` or `~/...`
- batch operations validate all targets before any mutation begins
- endpoint-specific validation should stay thin and reuse the shared helper contract
- `folder_download` supports `HEAD` for permission-only validation and `GET` or `POST` for the actual streamed ZIP response
- `folder_download` validates readable folder paths through the shared file-access permission model, creates a ZIP archive in `server/tmp/`, and returns a streamed attachment response without buffering the archive in memory

Module endpoints:

- `module_list`
- `module_info`
- `module_install`
- `module_remove`

Current rules:

- these endpoints delegate to `server/lib/customware/module_manage.js`
- writable operations must reuse the shared permission model and refresh the watchdog after mutation

Runtime and identity endpoints:

- `extensions_load`
- `password_generate`
- `user_self_info`

Important notes:

- `extensions_load` resolves HTML or JS extension request paths through the shared layered override system and supports grouped request batches
- frontend HTML anchors and JS hooks currently resolve through `ext/html/...` and `ext/js/...` request paths respectively
- `user_self_info` returns the authenticated user's derived identity plus a serialized frontend access-scope snapshot from the shared app-file permission model
- `password_generate` is an authenticated utility endpoint that returns the backend-sealed `password.json` payload and should stay narrow

## Handler Contract

Handlers receive the request context assembled by `server/router/router.js`, including:

- parsed body
- query params
- headers
- request and response objects
- request URL
- authenticated user
- project directories
- auth service
- watchdog and derived indexes

Handlers may return:

- plain JavaScript values
- explicit HTTP-style `{ status, headers, body }` or `{ status, headers, stream }` shapes
- Web `Response` objects

Throw errors with a `statusCode` when the route should return a non-500 error.

## Development Guidance

- keep endpoints narrow and explicit
- keep auth, permission, inheritance, and filesystem policy in shared helpers
- do not add endpoint-local filesystem walks when `path_index` or shared helpers already answer the question
- if frontend-facing API or extension-resolution semantics change, also update `app/L0/_all/mod/_core/onscreen_agent/ext/skills/development/` because its development skills mirror this contract
- if you add or remove endpoints, or change endpoint-family semantics, update this file and `/server/AGENTS.md`
