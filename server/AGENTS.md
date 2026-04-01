# AGENTS

## Purpose

`server/` is the thin local infrastructure runtime.

It should not become the main application runtime. Keep browser concerns in `app/` and keep this tree focused on explicit infrastructure contracts that the browser or CLI needs.

## Responsibilities

- serve the root HTML entry shells from `server/pages/`
- resolve browser-delivered modules from the layered `app/L0`, `app/L1`, and `app/L2` customware model
- expose server API modules from `server/api/`
- provide the outbound fetch proxy at `/api/proxy`
- own SQLite access and related integrity-safe persistence operations when persistence work is implemented
- support local development and source-checkout update flows without turning the server into business-logic orchestration

## Structure

Current server layout:

- `server/app.js`: server factory and subsystem bootstrap
- `server/server.js`: startup entry used by the CLI and thin host flows
- `server/config.js`: default host, port, and filesystem roots
- `server/dev-server.js`: source-checkout dev supervisor used by `npm run dev`
- `server/package.json`: ES module package boundary for the backend
- `server/pages/`: root HTML shell files served at `/`, `/login`, and `/admin`
- `server/api/`: endpoint modules loaded by endpoint name
- `server/router/router.js`: top-level request routing order and API dispatch
- `server/router/pages-handler.js`: page-route handler for page auth gating, redirects, and page actions such as `/logout`
- `server/router/mod-handler.js`: `/mod/...` static module resolution and file serving
- `server/router/request-context.js`: AsyncLocalStorage-backed request context and authenticated user resolution
- `server/router/request-body.js`: low-level request body parsing helpers
- `server/router/cors.js`: API CORS policy and preflight handling
- `server/router/responses.js`: shared response writers for JSON, redirects, file responses, and API result serialization
- `server/router/proxy.js`: outbound fetch proxy transport used by `/api/proxy`
- `server/lib/api/registry.js`: API module discovery
- `server/lib/auth/`: password verifier, login session, user file, and auth service helpers
- `server/lib/utils/`: shared low-level utilities such as app-path normalization and lightweight YAML helpers
- `server/lib/customware/`: layout parsing, group index building, and module inheritance resolution
- `server/lib/customware/file-access.js`: reusable app-path permission checks plus `file_read`, `file_write`, and `file_list` helper operations
- `server/lib/file-watch/config.yaml`: declarative watched-file handler configuration
- `server/lib/file-watch/handlers/`: watchdog handler classes such as `path-index`, `group-index`, and `user-index`, loaded by name from config
- `server/lib/file-watch/watchdog.js`: reusable filesystem watchdog that dispatches matching change events to handlers and exposes handler indexes
- `server/lib/git/`: backend-abstracted Git clients used by the `update` command

## Request Flow And Runtime Contracts

- request routing order is: API preflight handling, `/api/proxy`, `/api/<endpoint>`, `/mod/...`, then pages as the last fallback
- non-`/mod` and non-`/api` requests stay limited to root HTML shells and page actions owned by the pages layer
- the router-side pages handler owns page auth gating and page-route actions: unauthenticated requests for protected pages redirect to `/login`, authenticated requests to `/login` redirect to `/`, and `/logout` clears the current session then redirects to `/login`
- `/mod/...` requests resolve through the layered customware model, using the watched `path-index` plus the group index to select the best accessible match from `L0`, `L1`, and `L2`
- request identity is now derived from the server-issued `agent_one_session` cookie via the router-side request-context helper and the watched `user-index`
- `app/L2/<username>/user.yaml` stores the password verifier under a nested `password:` object and `app/L2/<username>/logins.json` stores active session codes
- only explicit public endpoints such as login status, login challenge, login completion, and health may run without authentication; other APIs and `/mod/...` fetches must require a valid session
- root page shells are pretty-routed as `/`, `/login`, and `/admin`; legacy `.html` requests redirect to those routes
- app filesystem APIs use app-rooted paths like `L2/alice/user.yaml` or `/app/L2/alice/user.yaml`
- read permissions are: own `L2/<username>/`, plus `L0/<group>/` and `L1/<group>/` for groups the user belongs to
- write permissions are: own `L2/<username>/`; managed `L1/<group>/`; `_admin` members may write any `L1/` and `L2/`; nobody writes `L0/`
- watchdog infrastructure is config-driven
- `path-index` is a normal watchdog handler, not a special side channel
- `group-index` derives group membership and management relationships from `group.yaml`
- `user-index` derives L2 user/verifier/session state from `user.yaml`, `logins.json`, and the path index
- add new watchdog handlers by adding handler classes and wiring them in `server/lib/file-watch/config.yaml`, not by manually binding handlers in `server/app.js`

## API Module Contract

Endpoint files are named by route:

- `/api/health` loads `server/api/health.js`
- `/api/file_read` loads `server/api/file_read.js`

Endpoint modules may export method handlers such as:

- `get(context)`
- `post(context)`
- `put(context)`
- `patch(context)`
- `delete(context)`
- `head(context)`
- `options(context)`

Handler context may include parsed body data, query parameters, headers, request and response objects, `requestUrl`, `user`, app/server directory references, and watched-file indexes.

Handlers may return:

- plain JavaScript values, which are serialized as JSON automatically
- explicit HTTP-style response objects when status, headers, binary bodies, or streaming behavior matter
- Web `Response` objects for advanced cases

Current endpoint set:

- `health`
- `check_login`
- `login_challenge`
- `login`
- `create_guest`
- `file_read`
- `file_write`
- `file_list`
- `db`
- `load_webui_extensions`

Current status notes:

- `db` is a placeholder route family for future SQLite work
- `check_login`, `login_challenge`, `login`, and `create_guest` are the current public auth-related endpoints
- `login` enforces a fixed minimum response time before returning success or authentication failure so password attempts are not reflected as instant responses
- `create_guest` creates a temporary L2 guest user with generated credentials, refreshes the watchdog indexes, and leaves the actual login step to the normal frontend login flow
- `file_read`, `file_write`, and `file_list` are the current authenticated app-filesystem APIs; they operate on app-rooted paths and enforce the layer/group/user permission rules through the shared file-access library
- the current page shells live in `server/pages/`, while all page-serving logic stays in `server/router/pages-handler.js`
- `load_webui_extensions` resolves extension files from layered `mod/**/ext/**` paths using the current user's group inheritance and exact module-path overrides

## Server Implementation Guide

- keep endpoints narrow and explicit
- prefer plain JavaScript return values for simple JSON APIs
- use explicit response objects only when needed
- keep shared server libraries infrastructure-focused and reusable
- keep proxy transport, API hosting, file watching, and persistence concerns separate from app orchestration
- keep `server/app.js` focused on bootstrapping core subsystems, not on special-case registration logic
- keep `server/pages/` limited to static page assets and keep routing logic in `server/router/`
- keep app-path permission checks in shared server libraries, not duplicated inside each file API endpoint
- prefer deterministic loader folders and name-based discovery for APIs, watched-file handlers, workers, and similar extension points
- keep inheritance resolution explicit and small
- keep new persistence APIs explicit, small, and integrity-safe
- do not move browser-side agent logic onto the server by default
- keep backend modules in `server/` on ES module syntax with `import` and `export`
- when server responsibilities, request flow, API contracts, watched-file behavior, or persistence architecture change, update this file in the same session
