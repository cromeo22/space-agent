# AGENTS

## Purpose

`_core/dashboard/` owns the default routed dashboard view.

It is a small routed landing surface under the router. The dashboard owns its base hero layout and any stable extension seams it exposes, but feature-specific launchers or summaries should compose into those seams instead of being hardwired into the dashboard module itself.

Documentation is top priority for this module. After any change under `_core/dashboard/`, update this file and any affected parent docs in the same session.

## Ownership

This module owns:

- `view.html`: routed dashboard shell and extension anchors
- `dashboard.css`: dashboard-local layout and hero styling

## Local Contracts

Current route contract:

- the dashboard is routed at `#/dashboard`
- it should stay a small landing surface, not a second app shell
- the dashboard must own its own page padding because the router shell no longer injects shared route padding

Current extension seams:

- `_core/dashboard/content_end`: content injected at the end of the hero card

Rules:

- feature modules may inject dashboard content through the dashboard-owned seam
- dashboard should not import feature-specific state or persistence helpers directly when the extension system can own the composition

## Development Guidance

- keep dashboard-owned copy and styling minimal
- add or change dashboard seams here rather than reaching into the DOM from another module
- if dashboard routing or stable seams change, update this file and `/app/AGENTS.md`
