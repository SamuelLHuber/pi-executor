import { describe, expect, test } from "bun:test";
import { createExecutorTools, loadExecutorPrompt } from "../src/tools.ts";

const EXECUTE_DESCRIPTION =
  "Execute TypeScript in a sandboxed runtime with access to configured API tools.";

const RESUME_DESCRIPTION =
  "Resume a paused Executor execution after the user has completed the browser approval.";

describe("executor prompt + tool descriptions", () => {
  test("loadExecutorPrompt returns the static Executor guidance without connecting", () => {
    const prompt = loadExecutorPrompt();

    expect(prompt).toContain(EXECUTE_DESCRIPTION);
    expect(prompt).toContain("Executor approvals happen in the Executor web UI.");
  });

  test("createExecutorTools registers static execute and resume tools without connecting", () => {
    const tools = createExecutorTools();
    const executeTool = tools.find((tool) => tool.name === "execute");
    const resumeTool = tools.find((tool) => tool.name === "resume");

    expect(executeTool?.description).toBe(EXECUTE_DESCRIPTION);
    expect(resumeTool?.description).toBe(RESUME_DESCRIPTION);
  });
});
