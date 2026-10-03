import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { createExecutorTools } from "../src/tools.ts";
import { toToolResult } from "../src/executor-adapter.ts";

describe("Pi 1 integration contract", () => {
  test("Executor orchestration stays model-only and declares structured output", () => {
    for (const tool of createExecutorTools()) {
      expect(tool.exposure).toBe("model-only");
      expect(tool.outputSchema).toBeDefined();
    }
  });
  test("errors and approval IDs remain available at the host result boundary", () => {
    const result = toToolResult(
      {
        text: "approval needed",
        isError: true,
        structuredContent: { status: "user_approval_required", executionId: "exact-id" },
      },
      { baseUrl: "http://127.0.0.1:4788" },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent.result).toEqual({
      status: "user_approval_required",
      executionId: "exact-id",
    });
    expect(result.details.executionId).toBe("exact-id");
  });
  test("prompt guidance changes one structured section, not the leading system prompt", () => {
    const handlers = new Map<string, Function>();
    extension({
      registerTool() {},
      registerCommand() {},
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI);
    const event = {
      systemPrompt: "original",
      systemPromptOptions: { sections: { existing: "keep" } as Record<string, string> },
    };
    expect(handlers.get("before_agent_start")!(event)).toBeUndefined();
    expect(event.systemPrompt).toBe("original");
    expect(event.systemPromptOptions.sections.existing).toBe("keep");
    expect(event.systemPromptOptions.sections.executor).toContain("Executor approvals");
  });
});
