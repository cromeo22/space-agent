# AGENTS

## Introduction

Agent One is a browser-first AI agent runtime.

The browser app is the primary runtime. The Node.js side exists as thin infrastructure around it for:

- outbound fetch proxying when the browser would otherwise hit CORS limits
- server-owned APIs and other narrow infrastructure contracts
- ownership of the SQLite persistence file and integrity-safe persistence operations
- local development and optional desktop hosting

Documentation quality is one of the most important parts of this project. Without high-quality agent docs, agents go rogue and architecture drifts. Treat these files as part of the runtime, not as optional notes.

This repository keeps three primary agent documentation files:

- `/AGENTS.md`
- `/app/AGENTS.md`
- `/server/AGENTS.md`

Subtree-local `AGENTS.md` files may also exist when they carry scoped guidance for a specific area such as CLI commands. Keep them aligned with the primary docs instead of treating them as a separate competing documentation system.

## Programming Guide

These rules apply across the codebase:

- keep implementations lean; prefer refactoring and simplification over adding bloat
- do not repeat code unnecessarily; when logic repeats, extract a shared implementation
- design new functionality to be reusable when that reuse is realistic
- do not hardwire features directly to each other when a small explicit contract or abstraction will do
- prefer composition, registries, and stable module boundaries over ad hoc cross-dependencies
- code must stay clean, readable, and reusable
- avoid boilerplate and ceremony unless they solve a real maintenance, safety, or clarity problem
- use deterministic discovery patterns for pluggable systems
- keep each handler type in one predictable folder and load implementations by explicit name, config, or convention
- apply the same deterministic loading rule to API handlers, watched-file handlers, workers, and other extension points that serve the same role
- do not create one-off loader paths for a single feature when that feature belongs in an existing handler or extension system
- when multiple objects should share the same interface, prefer JavaScript classes with a shared superclass and explicit overridden methods
- do not model shared interfaces as plain objects that are inspected at runtime to see whether a function exists
- use ES module syntax throughout the codebase; prefer `import` and `export` and avoid CommonJS forms such as `require` and `module.exports`
- some legacy CommonJS still exists in the repository; treat it as migration debt, not as a pattern to copy
- keep as much agent logic in the browser as possible
- treat the server as infrastructure, not as the main application runtime
- prefer explicit, small contracts between browser and server
- prefer maintainable filesystem structure over clever routing shortcuts

## Structure And Concepts Overview

Top-level structure:

- `A1.js`: root CLI router that discovers command modules dynamically
- `commands/`: CLI command modules such as `serve`, `help`, `version`, and `update`
- `app/`: browser runtime, layered customware model, shared frontend modules, and browser test surfaces
- `server/`: thin local infrastructure runtime, with root page shells under `server/pages/`, request routing under `server/router/`, API hosting, fetch proxying, watched-file indexes, auth/session infrastructure, and Git support code for update flows
- `packaging/`: optional Electron host and packaging scripts; keep native hosts thin

Project concepts:

- browser first, server last
- modules are the browser delivery unit for code, markup, styles, and assets
- browser modules are namespaced as `mod/<author>/<repo>/...`
- the layered browser model is `app/L0` firmware, `app/L1` group customware, and `app/L2` user customware
- `app/L1` and `app/L2` are transient runtime state and are gitignored; do not treat them as durable repo-owned sample content
- `app/L2/<username>/user.yaml` stores the user's login verifier under a `password:` object, and `app/L2/<username>/logins.json` stores active session codes
- the server resolves `/mod/...` requests through that layered inheritance model using watchdog-backed indexes
- the browser now authenticates through the server at `/login`, uses a server-issued session cookie for both API and file access, and clears that session through `/logout`
- the login screen can currently spawn temporary guest users through a public server endpoint; those guests are ordinary `app/L2/<username>/` users with generated credentials
- app file APIs now operate on app-rooted paths such as `L2/alice/user.yaml` or `/app/L2/alice/user.yaml`, not on `/mod/...` cascade paths
- read permissions are: a user can read their own `L2/<username>/`, and can read `L0/<group>/` and `L1/<group>/` for groups they belong to
- write permissions are: a user can write their own `L2/<username>/`; a user can write `L1/<group>/` only when they manage that group directly or through a managing group include chain; members of `_admin` can write any `L1/` and `L2/` path; nobody writes `L0/`
- non-`/api` and non-`/mod` browser entry routes are served from `server/pages/`; `/login` is public and the protected page shells live behind the router-side session gate
- the server-side backend under `server/` is expected to use ES module syntax throughout
- detailed browser-runtime rules live in `/app/AGENTS.md`
- detailed server-runtime rules live in `/server/AGENTS.md`

Supported CLI surface:

- `node A1.js serve`
- `node A1.js update`
- `node A1.js help`
- `node A1.js --help`
- `node A1.js version`
- `node A1.js --version`
- `node A1.js user create`
- `node A1.js user password`
- `node A1.js group create`
- `node A1.js group add`
- `node A1.js group remove`

Development and packaging surface:

- Node.js 20 or newer
- `npm install` for the standard source checkout
- `npm install --omit=optional` when native optional dependencies are not expected to work
- `npm run dev` to run the local dev supervisor
- `node A1.js serve` to run the server directly
- `npm run install:packaging` to install packaging-only dependencies
- `npm run desktop:dev`, `npm run desktop:pack`, and `npm run desktop:dist` for the Electron host and packaging flow

## Documentation Maintenance

All agent-facing documentation lives in the three `AGENTS.md` files. The root `README.md` is intentionally removed so the project has one documentation system for agents instead of split, drifting sources.

Documentation ownership:

- `/AGENTS.md` owns repo-wide rules, project identity, top-level structure, CLI surface, packaging surface, and documentation policy
- `/app/AGENTS.md` owns browser-runtime architecture, layer rules, frontend patterns, and app-specific current state
- `/server/AGENTS.md` owns server responsibilities, API contracts, watched-file/customware infrastructure, and server-specific current state
- subtree-local `AGENTS.md` files may document narrower implementation areas when they stay consistent with the primary docs

Documentation rules:

- keep app-specific details in `/app/AGENTS.md`, not in the root file
- keep server-specific details in `/server/AGENTS.md`, not in the root file
- do not duplicate detailed app or server information in `/AGENTS.md`; keep root high level and point to the owning file
- when subtree-local `AGENTS.md` files exist, keep them scoped, concise, and consistent with the root/app/server docs
- do not create parallel `README.md` or `readme.md` files for architecture or agent guidance; keep durable project documentation in the AGENTS files rather than split README architecture notes
- after every edit session, review whether architecture, folder layout, commands, API contracts, loader behavior, watcher behavior, extension points, or conventions changed
- if they changed, update the relevant `AGENTS.md` files in the same session before finishing
- if a change affects both app and server, update both local docs and update the root file if the top-level contract changed
- remove stale or contradictory documentation immediately; do not leave drift for later
- when code reveals undocumented architecture, document it
- keep these files explicit, current, and high signal at all times
