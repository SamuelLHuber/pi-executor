import { Type, type Static } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "./http.ts";
import type { ExecutorMcpInspection } from "./mcp-client.ts";
import { inspectExecutorMcp, withExecutorMcpClient } from "./mcp-client.ts";
import {
  buildExecutorSystemPrompt,
  toToolResult,
  type ExecuteToolDetails,
  type ExecuteToolResult,
} from "./executor-adapter.ts";
import { resolveExecutorEndpoint } from "./connection.ts";
import { resolveExecutorSettings } from "./settings.ts";
import { renderExecutorStatus, setExecutorState } from "./status.ts";
import { findRunningSidecarForCwd } from "./sidecar.ts";

const DEFAULT_EXECUTE_DESCRIPTION =
  "Execute TypeScript in a sandboxed runtime with access to configured API tools.";

const DEFAULT_RESUME_DESCRIPTION =
  "Resume a paused Executor execution after the user has completed the browser approval.";

const inspectionCache = new Map<string, Promise<ExecutorMcpInspection | undefined>>();

const isJsonObject = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const launchBrowser = async (url: string): Promise<void> => {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  const launcher =
    platform === "darwin"
      ? { command: "open", args: [url] }
      : platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };

  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(launcher.command, launcher.args, {
      stdio: "ignore",
      detached: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
};

const buildInspectionCacheKey = (cwd: string, hasUI: boolean): string =>
  `${cwd}:${hasUI ? "ui" : "headless"}`;

const trimToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const readInspectedToolDescription = (
  inspection: ExecutorMcpInspection | undefined,
  toolName: string,
): string | undefined =>
  trimToUndefined(inspection?.tools.find((tool) => tool.name === toolName)?.description) ??
  (toolName === "execute" ? trimToUndefined(inspection?.instructions) : undefined);

const inspectConfiguredExecutor = async (
  cwd: string,
  hasUI: boolean,
): Promise<ExecutorMcpInspection | undefined> => {
  const cacheKey = buildInspectionCacheKey(cwd, hasUI);
  const cached = inspectionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inspectionPromise = (async (): Promise<ExecutorMcpInspection | undefined> => {
    try {
      const settings = await resolveExecutorSettings(cwd);

      if (settings.mode === "remote") {
        if (settings.remoteUrl.length === 0) {
          return undefined;
        }

        return await inspectExecutorMcp(settings.remoteUrl, hasUI, undefined, "browser");
      }

      if (settings.autoStart) {
        const endpoint = await resolveExecutorEndpoint(cwd);
        return await inspectExecutorMcp(endpoint.baseUrl, hasUI, endpoint.token, "browser");
      }

      const sidecar = await findRunningSidecarForCwd(cwd, settings.dataDir || undefined);
      if (!sidecar) {
        return undefined;
      }

      return await inspectExecutorMcp(sidecar.baseUrl, hasUI, undefined, "browser");
    } catch {
      return undefined;
    }
  })();

  inspectionCache.set(cacheKey, inspectionPromise);

  try {
    return await inspectionPromise;
  } catch {
    inspectionCache.delete(cacheKey);
    return undefined;
  }
};

const loadExecutorDescriptions = async (
  cwd: string,
  hasUI: boolean,
): Promise<{ executeDescription: string; resumeDescription: string }> => {
  const inspection = await inspectConfiguredExecutor(cwd, hasUI);

  return {
    executeDescription:
      readInspectedToolDescription(inspection, "execute") ?? DEFAULT_EXECUTE_DESCRIPTION,
    resumeDescription:
      readInspectedToolDescription(inspection, "resume") ?? DEFAULT_RESUME_DESCRIPTION,
  };
};

const connectExecutor = async (ctx: ExtensionContext) => {
  const settings = await resolveExecutorSettings(ctx.cwd);
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
    return endpoint;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setExecutorState(ctx.cwd, { kind: "error", message });
    renderExecutorStatus(ctx, settings, ctx.cwd);
    throw error;
  }
};

const readApprovalUrl = (value: JsonValue): string | undefined =>
  isJsonObject(value) && typeof value.approvalUrl === "string" ? value.approvalUrl : undefined;

const openApprovalUrl = async (
  approvalUrl: string,
  endpoint: Awaited<ReturnType<typeof connectExecutor>>,
  ctx: ExtensionContext,
): Promise<string> => {
  const url = new URL(approvalUrl, endpoint.baseUrl);
  if (endpoint.token) {
    url.searchParams.set("_token", endpoint.token);
  }

  const href = url.toString();
  try {
    await launchBrowser(href);
    ctx.ui.notify(`Opened Executor approval in browser: ${href}`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Open this Executor approval URL manually:\n${href}\n\n${message}`, "warning");
  }
  return href;
};

const buildExecuteTool = (description: string) =>
  defineTool({
    name: "execute",
    label: "Execute",
    description,
    promptSnippet: "Execute TypeScript in Executor's sandboxed runtime with configured API tools.",
    promptGuidelines: [
      "Search inside execute before calling Executor tools directly in code.",
      "Use execute instead of top-level helper tools for Executor discovery and invocation.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "JavaScript code to execute" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> {
      const endpoint = await connectExecutor(ctx);

      const outcome = await withExecutorMcpClient(
        endpoint.baseUrl,
        { hasUI: ctx.hasUI, token: endpoint.token, elicitationMode: "browser" },
        async (client) => client.execute(params.code),
      );

      const result = toToolResult(outcome, {
        baseUrl: endpoint.baseUrl,
        scopeId: endpoint.token ? `executor-${endpoint.mode}` : undefined,
      });

      const approvalUrl = readApprovalUrl(result.details.structuredContent);
      if (!approvalUrl) {
        return result;
      }

      const openedUrl = await openApprovalUrl(approvalUrl, endpoint, ctx);
      return {
        ...result,
        content: [
          {
            type: "text",
            text: `${result.content[0]?.text ?? "User approval required."}\n\nOpened approval URL: ${openedUrl}`,
          },
        ],
      };
    },
  });

const buildResumeTool = (description: string) =>
  defineTool({
    name: "resume",
    label: "Resume",
    description,
    promptSnippet:
      "Resume a paused Executor execution after the user has completed the browser approval.",
    promptGuidelines: ["Use the exact executionId returned by execute after browser approval."],
    parameters: Type.Object({
      executionId: Type.String({ description: "The execution ID from the paused result" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> {
      const endpoint = await connectExecutor(ctx);

      const outcome = await withExecutorMcpClient(
        endpoint.baseUrl,
        { hasUI: false, token: endpoint.token, elicitationMode: "browser" },
        async (client) => client.resume(params.executionId),
      );

      return toToolResult(outcome, {
        baseUrl: endpoint.baseUrl,
        scopeId: endpoint.token ? `executor-${endpoint.mode}` : undefined,
      });
    },
  });

export const loadExecutorPrompt = async (cwd: string, hasUI: boolean): Promise<string> => {
  const { executeDescription } = await loadExecutorDescriptions(cwd, hasUI);
  return buildExecutorSystemPrompt(executeDescription, true);
};

export const isExecutorToolDetails = (value: object | null): value is ExecuteToolDetails => {
  if (!value || !("baseUrl" in value) || !("isError" in value)) {
    return false;
  }

  const maybe = value as Record<string, unknown>;
  return (
    typeof maybe.baseUrl === "string" &&
    (maybe.scopeId === undefined || typeof maybe.scopeId === "string") &&
    typeof maybe.isError === "boolean"
  );
};

export const createExecutorTools = async (
  cwd: string,
  hasUI: boolean,
): Promise<ToolDefinition[]> => {
  const { executeDescription, resumeDescription } = await loadExecutorDescriptions(cwd, hasUI);
  return [buildExecuteTool(executeDescription), buildResumeTool(resumeDescription)];
};

export const registerExecutorTools = async (
  pi: ExtensionAPI,
  cwd: string,
  hasUI: boolean,
): Promise<void> => {
  for (const tool of await createExecutorTools(cwd, hasUI)) {
    pi.registerTool(tool);
  }
};

export type ExecuteToolInput = Static<ReturnType<typeof buildExecuteTool>["parameters"]>;
export type ResumeToolInput = Static<ReturnType<typeof buildResumeTool>["parameters"]>;
