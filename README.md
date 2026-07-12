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

Configure the extension in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project).

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

- `mode`: `"local"` or `"remote"`
- `autoStart`: connect on session start
- `remoteUrl`: required for remote mode (e.g. `http://127.0.0.1:4788`)
- `showFooterStatus`: show the green dot in Pi's footer
- `stopLocalOnShutdown`: stop Pi-owned sidecars when the session ends
- `dataDir`: custom data directory for the executor sidecar
- `scopeDir`: workspace scope directory that determines the executor tenant. Defaults to `dataDir`. If you have legacy data created under a different directory (e.g. a specific project), set this to that path so the global executor can see it

You can also manage these interactively with `/executor-settings`.

## Execution modes

pi-executor supports three modes depending on how you configure it:

### 1. Remote mode

Connect to an existing executor server.

```json
// ~/.pi/agent/settings.json
{
  "piExecutor": {
    "mode": "remote",
    "remoteUrl": "http://127.0.0.1:4788"
  }
}
```

Pi never starts or stops this server. You run it yourself (e.g. `npx executor web --port 4788`).

### 2. Global-local mode (default)

When **no project settings** exist (no `.pi/settings.json` with a `piExecutor` key), Pi uses a **single shared executor** at `~/.executor` on port `4788`.

- `scopeDir` controls which workspace tenant the global executor uses. If your existing integrations were created while running executor inside a specific project, set `scopeDir` to that project's path so the global executor loads them

- The first Pi session that needs executor **checks if it's running**, and if not, **starts it detached**
- The executor survives Pi restarts because it is **not owned by any Pi session**
- All projects without explicit overrides share the same instance and the same integrations / connections
- `/executor-stop` refuses to stop the global executor because it would break other sessions

This is the default behaviour out of the box. You do not need to configure anything.

### 3. Project-local mode

To isolate a specific project, create a `.pi/settings.json` anywhere with any `piExecutor` key:

```json
{
  "piExecutor": {
    "dataDir": "./.executor"
  }
}
```

When a project has **any** explicit executor settings, it gets its own sidecar:

- Its own data directory (defaults to `<cwd>/.executor`)
- Port scanning to find a free port
- Full lifecycle ownership — Pi starts it on demand and **can** stop it with `/executor-stop`

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

### Global-local shared instance

By default (no project settings), pi-executor uses a single shared executor at `~/.executor` on port `4788`:

- The first session that needs executor **checks** if it's running via `server.json` and a health check
- If missing, it spawns the binary **detached** (`no-hup` style) with logs to `~/.executor/executor.stdout.log`
- No Pi session "owns" the global executor, so it survives shutdowns and restarts
- Other sessions simply discover and connect to the existing server

This means you can open Pi in many different projects and they all talk to the same executor instance.

### Project-local isolation

When a project has **any explicit settings** in `.pi/settings.json`, it gets full isolation:

- Its own `.executor/` directory inside the project
- Port scanning from `4788` upwards to find a free one
- Pi **owns** the lifecycle: starts it on demand, stops it on shutdown, `/executor-stop` works
- Auth tokens and integrations are scoped per directory

### Bearer token auto-flow

Current executor gates `/api/*` and `/mcp` behind a bearer token. The extension:

1. Spawns the sidecar (or connects to an existing one)
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

Sessions in **different projects with no explicit settings** share the **same** global executor at `~/.executor`. No conflicts.

Sessions in **different projects with explicit project settings** run fully isolated sidecars on separate ports. They do not interfere with each other.

If you want to share a single executor across **all** projects but still have Pi manage its lifecycle, switch one project to local mode with default settings and all others to remote mode pointing at it. But in practice, the global-local default handles this automatically.

## Development

```bash
cd ~/git/pi-executor-plugin
bun install
```

The extension loads TypeScript directly via jiti, so no build step is needed.

## License

MIT — same as the original.
