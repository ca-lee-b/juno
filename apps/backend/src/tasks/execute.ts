import type { Logger } from "pino";
import { type Execute, ExecutionError, type RepositorySandbox } from "@/execution/contracts";
import type { createIssueReader } from "@/github/issues";
import type { TaskRepository } from "@/tasks/repository";

type Dependencies = {
  tasks: Pick<TaskRepository, "start" | "setSource" | "setSandbox" | "complete" | "fail"> &
    Partial<Pick<TaskRepository, "conversation" | "latestDraft">>;
  readIssue: ReturnType<typeof createIssueReader>;
  createSandbox: (taskId: string) => Promise<RepositorySandbox>;
  execute: Execute;
  logger: Logger;
};

export function createExecutionHandler({
  tasks,
  readIssue,
  createSandbox,
  execute,
  logger,
}: Dependencies) {
  return async (taskId: string, lastAttempt: boolean) => {
    const task = await tasks.start(taskId);
    if (!task) return; // Terminal tasks are safe to redeliver.
    // A redelivered live job lost its owning worker. Re-running its initial prompt
    // in a new sandbox could repeat GitHub writes from the original thread.
    if (task.sandboxId) {
      await tasks.fail(taskId, true, "SESSION_LOST");
      return;
    }
    let operation = "load context";
    let sandbox: RepositorySandbox | undefined;
    async function release() {
      if (!sandbox) return;
      try {
        await sandbox.dispose();
      } catch {
        await sandbox.dispose();
      }
      sandbox = undefined;
    }
    try {
      const issue = await readIssue(task.input, task.sourceSha, task.publication);
      issue.sessionBranch = task.publication?.branch ?? `byo-pr-agent/${task.sessionId ?? task.id}`;
      const draft =
        task.sessionId && !task.publication?.prNumber
          ? await tasks.latestDraft?.(task.sessionId)
          : undefined;
      if (task.sessionId) {
        issue.instruction = task.instruction ?? "";
        issue.history = (await tasks.conversation?.(task.sessionId, taskId)) ?? [];
        if (draft?.sourceSha) issue.sha = draft.sourceSha;
      }
      await tasks.setSource(taskId, issue.sha, issue.branch, issue.title);
      operation = "create sandbox";
      sandbox = await createSandbox(taskId);
      await tasks.setSandbox(taskId, sandbox.id);
      operation = "checkout repository";
      await sandbox.clone(issue, draft?.result?.patch);
      operation = "run agent";
      const result = await execute(issue, sandbox);
      operation = "release sandbox";
      await release();
      operation = "save result";
      await tasks.complete(taskId, result);
      logger.info({ taskId, model: result.model, usage: result.usage }, "execution completed");
    } catch (error) {
      const failure = error instanceof ExecutionError ? error : new ExecutionError("SETUP_FAILED");
      if (
        operation === "run agent" &&
        error instanceof ExecutionError &&
        error.code === "SETUP_FAILED"
      )
        operation = "install agent tools";
      logger.warn(
        { taskId, operation, stage: failure.code, exitCode: failure.exitCode },
        "execution failed",
      );
      const liveFailure = operation === "run agent" && failure.code !== "SETUP_FAILED";
      let cleanupFailed = operation === "release sandbox";
      if (!cleanupFailed) {
        try {
          if (sandbox) {
            await release();
            await tasks.setSandbox(taskId, null);
          }
        } catch {
          cleanupFailed = true;
          logger.error(
            { taskId, sandboxId: sandbox?.id },
            "sandbox cleanup failed; TTL is the fallback",
          );
        }
      }
      await tasks.fail(
        taskId,
        lastAttempt || liveFailure || cleanupFailed || operation === "save result",
        cleanupFailed ? "CLEANUP_FAILED" : failure.code,
      );
      if (operation === "save result") await tasks.setSandbox(taskId, null);
      // Do not persist provider errors: they can contain credentials or repository content.
      const exit = failure.exitCode === undefined ? "" : `, exit ${failure.exitCode}`;
      throw new Error(`Task execution failed during ${operation} (${failure.code}${exit})`);
    }
  };
}
