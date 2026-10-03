# pi-executor

## 0.3.0 — 2026-10-03

- Use a structured prompt section instead of replacing the leading system prompt.
- Expose Executor's orchestration/approval tools as model-only to avoid nesting them inside native codemode.
- Declare structured output and return host-level error flags while retaining rendering details and exact approval IDs.
- Never adopt a reused port when the registered process has exited.
- Update discovery skill examples to the current integrations API and search-result envelope.
- Pin Pi 1.0.0 development dependencies.

Verification: 24 passing Bun tests, TypeScript, formatting and lint checks; real Pi 1.0 extension-loader smoke check. Live read-only integration inventory confirmed five MCP and two OpenAPI integrations. Approval/resume transport is fixture-tested; no real mutation was performed.

## 0.2.7

### Patch Changes

- Register Executor tools and prompt guidance without connecting to Executor during Pi startup.
- Move auto-start/status checks to background work so slow or failed Executor startup does not block the prompt.
- Keep explicit `/executor-start`, `/executor-web`, and first `execute`/`resume` calls as the places that synchronously connect and surface failures.

## 0.2.6

### Patch Changes

- Document the global-local executor mode fallback more clearly.
- Apply formatting cleanup to executor command imports.
- Remove an unused test import so linting passes on the current toolchain.

## 0.2.4

### Patch Changes

- Use Executor browser approval pages instead of Pi native approval dialogs.

## 0.2.3

### Patch Changes

- 1e9aad7: Use `server.json` discovery for shared dataDir; fix tilde-expansion in registry key
  - Discover running executor instances via `~/.executor/server-control/server.json` instead of relying solely on the custom sidecar registry, enabling cross-session and cross-process reuse.
  - Fix tilde-expansion bug in `computeRegistryKey` that caused duplicate sidecar spawn attempts when `dataDir` was set to `~/.executor`.

## 0.2.0

### Minor Changes

- e526ba1: Inital Release of Pi-executor

## 0.0.1

### Patch Changes

- 02567d3: Initial Release
