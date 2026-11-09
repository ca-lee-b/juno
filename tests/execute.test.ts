import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@/logger";
import { createExecutionHandler } from "@/tasks/execute";
import type { Task } from "@/tasks/types";

type Dependencies = Parameters<typeof createExecutionHandler>[0];

function setup() {
  const task: Task = {
    id: "task-1",
    input: { owner: "octocat", repo: "hello-world", issueNumber: 1 },
    status: "running",
    attempts: 1,
    sandboxId: null,
    sourceSha: "a".repeat(40),
    sourceBranch: "main",
    publication: null,
    result: null,
    model: null,
    promptVersion: null,
    usage: null,
    errorCode: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const tasks = {
    start: vi.fn<Dependencies["tasks"]["start"]>().mockResolvedValue(task),
    setSource: vi.fn<Dependencies["tasks"]["setSource"]>(),
    setSandbox: vi.fn<Dependencies["tasks"]["setSandbox"]>(),
    complete: vi.fn<Dependencies["tasks"]["complete"]>(),
    fail: vi.fn<Dependencies["tasks"]["fail"]>(),
  };
  const sandbox = {
    id: "sandbox-1",
    clone: vi.fn(),
    execute: vi.fn(),
    dispose: vi.fn(),
  };
  const createSandbox = vi.fn<Dependencies["createSandbox"]>().mockResolvedValue(sandbox);
  const readIssue = vi.fn<Dependencies["readIssue"]>().mockResolvedValue({
    ...task.input,
    title: "Fix the issue",
    body: "Issue details",
    sha: "a".repeat(40),
    branch: "main",
    private: false,
  });
  const result = {
    result: {
      prTitle: "fix: address the issue",
      prDescription: "Review changes",
      summary: "Implemented the issue",
      patch: "test patch",
    },
    model: "test",
    promptVersion: "test",
    usage: { inputTokens: 3, outputTokens: 2 },
  } satisfies Awaited<ReturnType<Dependencies["execute"]>>;
  const execute = vi.fn<Dependencies["execute"]>().mockResolvedValue(result);
  const handle = createExecutionHandler({
    tasks,
    createSandbox,
    readIssue,
    execute,
    logger: createLogger("silent"),
  });
  return { tasks, sandbox, createSandbox, readIssue, execute, result, handle };
}

describe("execution lifecycle", () => {
  it("persists the execution result and disposes the sandbox", async () => {
    const { handle, tasks, sandbox, result } = setup();
    await handle("task-1", false);
    expect(tasks.complete).toHaveBeenCalledOnce();
    expect(tasks.complete).toHaveBeenCalledWith("task-1", result);
    expect(tasks.complete.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.dispose.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(sandbox.dispose).toHaveBeenCalledOnce();
    expect(tasks.setSandbox).toHaveBeenLastCalledWith("task-1", null);
  });
  it("skips redelivery of terminal tasks", async () => {
    const { handle, tasks, createSandbox } = setup();
    tasks.start.mockResolvedValue(undefined);
    await handle("task-1", false);
    expect(createSandbox).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "records retry/terminal failure and cleans up (final=%s)",
    async (final) => {
      const { handle, tasks, sandbox, execute } = setup();
      execute.mockRejectedValue(new Error("provider secret"));
      await expect(handle("task-1", final)).rejects.toThrow("Task execution failed");
      expect(tasks.fail).toHaveBeenCalledWith("task-1", final, "SETUP_FAILED");
      expect(sandbox.dispose).toHaveBeenCalledOnce();
      expect(tasks.complete).not.toHaveBeenCalled();
    },
  );
  it("cleans up even if recording the sandbox ID fails", async () => {
    const { handle, tasks, sandbox } = setup();
    tasks.setSandbox.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(handle("task-1", false)).rejects.toThrow();
    expect(sandbox.dispose).toHaveBeenCalledOnce();
  });
  it("does not rerun successful model work when cleanup fails", async () => {
    const { handle, tasks, sandbox } = setup();
    sandbox.dispose.mockRejectedValue(new Error("cleanup unavailable"));
    await handle("task-1", false);
    expect(tasks.complete).toHaveBeenCalledOnce();
    expect(tasks.fail).not.toHaveBeenCalled();
    expect(tasks.setSandbox).not.toHaveBeenCalledWith("task-1", null);
  });
});
