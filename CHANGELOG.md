# pi-executor

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
