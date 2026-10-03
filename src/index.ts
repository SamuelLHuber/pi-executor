import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExecutorCommands } from "./commands.ts";
import { resolveExecutorEndpoint } from "./connection.ts";
import { resolveExecutorSettings } from "./settings.ts";
import { refreshExecutorStatus, renderExecutorStatus, setExecutorState } from "./status.ts";
import { shutdownOwnedSidecars } from "./sidecar.ts";
import { isExecutorToolDetails, loadExecutorPrompt, registerExecutorTools } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
  registerExecutorTools(pi);

  pi.on("session_start", (_event, ctx) => {
    void (async () => {
      const settings = await resolveExecutorSettings(ctx.cwd);
      await refreshExecutorStatus(ctx, settings, ctx.cwd);

      if (!settings.autoStart) {
        return;
      }

      setExecutorState(ctx.cwd, { kind: "connecting", mode: settings.mode });
      renderExecutorStatus(ctx, settings, ctx.cwd);

      try {
        const endpoint = await resolveExecutorEndpoint(ctx.cwd);
        setExecutorState(ctx.cwd, {
          kind: "ready",
          mode: endpoint.mode,
          baseUrl: endpoint.baseUrl,
        });
        renderExecutorStatus(ctx, settings, ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setExecutorState(ctx.cwd, { kind: "error", message });
        renderExecutorStatus(ctx, settings, ctx.cwd);
        ctx.ui.notify(`Executor auto-start failed: ${message}`, "warning");
      }
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Executor status refresh failed: ${message}`, "warning");
    });
  });

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.executor = loadExecutorPrompt();
  });

  pi.on("tool_result", async (event) => {
    if (
      (event.toolName === "execute" || event.toolName === "resume") &&
      typeof event.details === "object" &&
      event.details !== null &&
      isExecutorToolDetails(event.details)
    ) {
      return { isError: event.details.isError };
    }
  });

  registerExecutorCommands(pi);

  pi.on("session_shutdown", async (_event, ctx) => {
    const settings = await resolveExecutorSettings(ctx.cwd);
    if (!settings.stopLocalOnShutdown) {
      return;
    }

    await shutdownOwnedSidecars();
    setExecutorState(ctx.cwd, { kind: "idle" });
  });
}
