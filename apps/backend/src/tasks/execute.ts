import type { Logger } from "pino";
import {
  type Execute,
  ExecutionError,
  type IssueContext,
  type RepositorySandbox,
} from "@/execution/contracts";
import type { TaskInput } from "@/tasks/input";
import type { TaskRepository } from "@/tasks/repository";

import type { createRevisionPublisher } from "@/tasks/revision";

type Dependencies = {
  revisions?: ReturnType<typeof createRevisionPublisher>;
  tasks: Pick<TaskRepository, "start" | "setSource" | "setSandbox" | "complete" | "fail"> &
    Partial<Pick<TaskRepository, "conversation" | "latestDraft">>;
  readIssue: (input: TaskInput, sourceSha: string | null) => Promise<IssueContext>;
  createSandbox: (taskId: string, retry?: boolean) => Promise<RepositorySandbox>;
  execute: Execute;
  logger: Logger;
};

export function createExecutionHandler({
  revisions,
  tasks,
  readIssue,
  createSandbox,
  execute,
  logger,
}: Dependencies) {
  return async (taskId: string, lastAttempt: boolean) => {
    const task = await tasks.start(taskId);
    if (!task) return; // Terminal tasks are safe to redeliver.
    let operation = "load context";
    let sandbox: RepositorySandbox | undefined;
    try {
      if (task.sessionId && task.result && task.sourceSha && revisions) {
        operation = "publish revision";
        await revisions.push(task, task.sourceSha, task.result.patch);
        await tasks.complete(taskId, task);
        return;
      }
      const head =
        task.sessionId && task.publication?.prNumber ? await revisions?.head(task) : undefined;
      const draft = task.sessionId && !head ? await tasks.latestDraft?.(task.sessionId) : undefined;
      const issue = await readIssue(
        task.input,
        task.sourceSha ?? head?.sha ?? draft?.sourceSha ?? null,
      );
      if (task.sessionId) {
        if (head) issue.reviewComments = (await revisions?.comments(task)) ?? [];
        issue.branch = head?.branch ?? draft?.sourceBranch ?? issue.branch;
        issue.instruction = task.instruction ?? "";
        issue.history = (await tasks.conversation?.(task.sessionId, taskId)) ?? [];
      }
      await tasks.setSource(taskId, issue.sha, issue.branch, issue.title);
      operation = "create sandbox";
      sandbox = await createSandbox(taskId, task.attempts > 1);
      await tasks.setSandbox(taskId, sandbox.id);
      operation = "checkout repository";
      await sandbox.clone(issue, draft?.result?.patch);
      operation = "run agent";
      const result = await execute(issue, sandbox);
      if (head && revisions) {
        await tasks.complete(taskId, result, true);
        operation = "publish revision";
        await revisions.push(task, issue.sha, result.result.patch);
      }
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
      await tasks.fail(taskId, lastAttempt, failure.code);
      // Do not persist provider errors: they can contain credentials or repository content.
      const exit = failure.exitCode === undefined ? "" : `, exit ${failure.exitCode}`;
      throw new Error(`Task execution failed during ${operation} (${failure.code}${exit})`);
    } finally {
      if (sandbox) {
        try {
          await sandbox.dispose();
          await tasks.setSandbox(taskId, null);
        } catch {
          logger.error(
            { taskId, sandboxId: sandbox.id },
            "sandbox cleanup failed; TTL is the fallback",
          );
        }
      }
    }
  };
}
