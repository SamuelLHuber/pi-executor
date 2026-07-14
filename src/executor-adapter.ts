import type { JsonObject, JsonValue } from "./http.ts";

export type ExecuteToolDetails = {
  baseUrl: string;
  scopeId?: string;
  structuredContent: JsonValue;
  isError: boolean;
  executionId?: string;
};

export type ExecuteToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ExecuteToolDetails;
};

type ExecutorToolOutcome = {
  text: string;
  structuredContent: JsonValue;
  isError: boolean;
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readExecutionId = (structuredContent: JsonValue): string | undefined => {
  if (!isJsonObject(structuredContent)) {
    return undefined;
  }

  return (structuredContent.status === "waiting_for_interaction" ||
    structuredContent.status === "user_approval_required") &&
    typeof structuredContent.executionId === "string"
    ? structuredContent.executionId
    : undefined;
};

export const parseJsonContent = (raw: string | undefined): JsonObject | undefined => {
  if (!raw || raw === "{}") {
    return undefined;
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return undefined;
  }

  return isJsonObject(parsed) ? parsed : undefined;
};

export const toToolResult = (
  outcome: ExecutorToolOutcome,
  meta: { baseUrl: string; scopeId?: string },
): ExecuteToolResult => ({
  content: [{ type: "text", text: outcome.text }],
  details: {
    baseUrl: meta.baseUrl,
    scopeId: meta.scopeId,
    structuredContent: outcome.structuredContent,
    isError: outcome.isError,
    executionId: readExecutionId(outcome.structuredContent),
  },
});

export const buildExecutorSystemPrompt = (description: string, hasResume: boolean): string =>
  [
    "Executor MCP parity guidance:",
    description,
    "",
    hasResume
      ? "Executor approvals happen in the Executor web UI. If execute returns user_approval_required, tell the user to approve in the opened browser page, then call resume with the exact executionId."
      : "Use execute for Executor work.",
  ].join("\n");
