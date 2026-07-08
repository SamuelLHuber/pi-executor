# pi-executor

Pi extension that runs a local [Executor](https://executor.sh) sidecar and exposes
`execute`/`resume` agent tools so Pi can call any MCP server, OpenAPI spec, or
GraphQL endpoint without burning your context window.

Forked from [jeremyosih/pi-executor](https://github.com/jeremyosih/pi-executor).
This fork fixes compatibility with Executor >= 1.5.x and adds quality-of-life
improvements for daily use.

## Why this fork exists

The original `pi-executor` targets Executor <= 1.4.x which shipped the native
binary at `bin/runtime/executor`. Executor 1.5.x moved the binary to
platform-specific `optionalDependencies` packages (e.g. `executor-darwin-arm64`)
and changed boot behaviour in ways that broke the original extension:

- **Bootstrap failure**: the installer path changed, causing `BOOTSTRAP_FAILED`
- **Missing `--foreground`**: executor now needs `--foreground` for throwaway
  sidecars unless you previously ran `executor install`
- **Removed `/api/scope`**: health checks now use `/api/health`
- **Bearer token auth**: all gated surfaces require a token from
  `<dataDir>/server-control/auth.json`
- **Shared data directory**: multiple Pi sessions conflicted over `~/.executor`

This fork fixes all of the above.

## Install

In Pi, run:

```bash
pi install git:github.com/SamuelLHuber/pi-executor
```

Then `/reload` Pi to load the extension.

## Quick start

After `/reload` you should see a green executor dot in Pi's footer.

Open the Executor web UI (auto-authenticated):

```
/executor-web
```

Add your first integration from the web UI, or use `execute` to add one
programmatically:

```ts
const result = await tools.executor.mcp.addServer({
  transport: "stdio",
  name: "My MCP Server",
  command: "node",
  args: ["/path/to/server/build/index.js"],
  slug: "my-server",
});
```

Then create a connection for it:

```ts
const conn = await tools.executor.coreTools.connections.create({
  integration: "my-server",
  name: "default",
  template: "none",
});
```

Now the server's tools are available as `tools.my_server.*` inside `execute`.

## Agent-facing tools

- **`execute`** — run TypeScript inside Executor's sandboxed QuickJS runtime
- **`resume`** — resume a paused execution (headless / no-UI sessions only)

Inside `execute`, you get a `tools` lazy proxy with these discovery helpers:

- `tools.search({ query, namespace?, limit? })`
- `tools.describe.tool({ path })`
- `tools.executor.coreTools.integrations.list({})`
- `tools.executor.coreTools.connections.list({})`

Follow the **executor-usage** skill (`/skill:executor-usage`) for the full
discovery and calling pattern.

## Commands

| Command              | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `/executor-web`      | Open the Web UI with auto-authentication (`?_token=...`)  |
| `/executor-start`    | Start the sidecar and print its URL                       |
| `/executor-stop`     | Stop the local sidecar for the current cwd                |
| `/executor-settings` | Configure local vs remote, autoStart, footer status, etc. |
| `/executor-logs`     | Show the last 200 lines of sidecar stdout / stderr logs   |

## Settings

Configure the extension in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "piExecutor": {
    "mode": "local",
    "autoStart": true,
    "remoteUrl": "",
    "showFooterStatus": true,
    "stopLocalOnShutdown": true,
    "dataDir": ""
  }
}
```

- `mode`: `"local"` (spawn sidecar) or `"remote"` (connect to existing)
- `autoStart`: connect on session start
- `remoteUrl`: required for remote mode (e.g. `http://127.0.0.1:4788`)
- `showFooterStatus`: show the green dot in Pi's footer
- `stopLocalOnShutdown`: stop Pi-owned sidecars when the session ends
- `dataDir`: custom data directory for the executor sidecar. When empty, each project gets its own `<cwd>/.executor`. Set to e.g. `"~/.executor"` to share one global executor across all projects

You can also manage these interactively with `/executor-settings`.

## Global executor

By default every project gets its own sidecar and its own data directory (`<cwd>/.executor`). To run a single shared executor for all projects, set a global `dataDir` in `~/.pi/agent/settings.json`:

```json
{
  "piExecutor": {
    "dataDir": "~/.executor"
  }
}
```

With this setting:

- All Pi sessions connect to the same executor instance regardless of cwd
- Integrations, connections, and auth tokens live in one place (`~/.executor`)
- The first session that needs executor starts the sidecar; subsequent sessions reuse it
- Only the session that originally started the sidecar will auto-stop it on shutdown (unless another session explicitly runs `/executor-stop`)

## How to add integrations

### MCP server (stdio)

Most useful for connecting local MCP servers:

```ts
await tools.executor.mcp.addServer({
  transport: "stdio",
  name: "ERPNext",
  command: "node",
  args: ["/path/to/erpnext-server/build/index.js"],
  cwd: "/path/to/erpnext-server",
  slug: "erpnext",
});
```

Then create a connection. For env-var auth:

```ts
await tools.executor.coreTools.connections.create({
  integration: "erpnext",
  name: "default",
  template: "env",
});
```

For API key auth stored in the Executor keychain:

```ts
await tools.executor.coreTools.connections.createHandoff({
  integration: "openapi_petstore",
  label: "production",
});
// Returns a URL for the user to enter credentials in the web UI
```

### OpenAPI spec

```ts
await tools.executor.openapi.addSpec({
  spec: "https://petstore3.swagger.io/api/v3/openapi.json",
  namespace: "petstore",
  baseUrl: "https://petstore3.swagger.io/api/v3",
});
```

### GraphQL endpoint

```ts
await tools.executor.graphql.addEndpoint({
  endpoint: "https://api.github.com/graphql",
  namespace: "github",
});
```

## Using `execute` — the canonical pattern

1. **Search** for the tool you need
2. **Describe** it to see the TypeScript shapes
3. **Call** it with the full namespace path

```ts
const matches = await tools.search({ query: "linear issues", limit: 5 });
const path = matches.items[0]?.path;
if (!path) return "No matching tools found.";

const details = await tools.describe.tool({ path });
console.log(details.inputTypeScript);

const result = await tools.mcp_linear_app.list_issues({
  project: "<project-id>",
  limit: 5,
});

return result;
```

## Architecture

### Per-cwd data directories

Each project gets its own `.executor/` directory (inside the cwd) for data,
database, and auth tokens. This means:

- Multiple Pi sessions in different projects never conflict
- Each project has its own integrations catalog
- Auth tokens are scoped per directory, not shared globally

The sidecar spawned by Pi uses `EXECUTOR_DATA_DIR=<cwd>/.executor`.

### Bearer token auto-flow

Current executor gates `/api/*` and `/mcp` behind a bearer token. The extension:

1. Spawns the sidecar
2. Reads the token from `.executor/server-control/auth.json`
3. Passes it to the MCP client via `Authorization` headers
4. Includes it in `/executor-web` as `?_token=...` for auto-login

### Log files

Sidecar stdout and stderr are written to:

- `.executor/executor.stdout.log`
- `.executor/executor.stderr.log`

Use `/executor-logs` to view the last 200 lines from Pi, or read the files
directly.

## Troubleshooting

### "Executor auto-start failed: Executor runtime bootstrap failed"

The extension could not find the executor binary. Make sure `pi-executor` is
installed (it pulls `executor` as a dependency). If you have executor
installed globally, make sure it's on PATH or switch to remote mode pointing at
it.

### "Executor sidecar startup timed out"

- Check `.executor/executor.stdout.log` and `.executor/executor.stderr.log`
- Use `/executor-logs` from Pi
- Make sure no other executor is squatting the port (`lsof -i :4788`)
- Check if executor prompts for setup — run it manually with:
  `<executor_binary> web --port 4788 --foreground`

### Web UI asks for authentication

Use `/executor-web` which opens with `?_token=...` appended. If you opened the
bare URL manually, get the token from `.executor/server-control/auth.json`.

### "A local Executor foreground is already running"

Another executor process owns `~/.executor`. Either:

- Kill it (`pkill -f "executor web"`) and let Pi manage its own, or
- Switch to remote mode pointing at the existing instance

### Multiple Pi sessions

Each session spawns its own sidecar on a different port with its own
`.executor/` directory. They are fully isolated. If you want a single shared
executor, run it manually and point all Pi sessions at it via remote mode.

## Development

```bash
cd ~/git/pi-executor-plugin
bun install
```

The extension loads TypeScript directly via jiti, so no build step is needed.

## License

MIT — same as the original.
