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
    Partial<Pick<TaskRepository, "context">>;
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
    let sandbox: RepositorySandbox | undefined;
    try {
      if (task.sessionId && task.result && task.sourceSha && revisions) {
        await revisions.push(task, task.sourceSha, task.result.patch);
        await tasks.complete(taskId, task);
        return;
      }
      const head = task.sessionId ? await revisions?.head(task) : undefined;
      if (task.sessionId && !head) throw new Error("Missing PR");
      const issue = await readIssue(task.input, task.sourceSha ?? head?.sha ?? null);
      if (head) {
        issue.reviewComments = (await revisions?.comments(task)) ?? [];
        issue.branch = head.branch;
        issue.instruction = task.instruction ?? "";
        if (task.sessionId) issue.history = (await tasks.context?.(task.sessionId)) ?? [];
      }
      await tasks.setSource(taskId, issue.sha, issue.branch);
      sandbox = await createSandbox(taskId, task.attempts > 1);
      await tasks.setSandbox(taskId, sandbox.id);
      await sandbox.clone(issue);
      const result = await execute(issue, sandbox);
      if (head && revisions) {
        await tasks.complete(taskId, result, true);
        await revisions.push(task, issue.sha, result.result.patch);
      }
      await tasks.complete(taskId, result);
      logger.info({ taskId, model: result.model, usage: result.usage }, "execution completed");
    } catch (error) {
      const failure = error instanceof ExecutionError ? error : new ExecutionError("SETUP_FAILED");
      logger.warn({ taskId, stage: failure.code, exitCode: failure.exitCode }, "execution failed");
      await tasks.fail(taskId, lastAttempt, failure.code);
      // Do not persist provider errors: they can contain credentials or repository content.
      throw new Error("Task execution failed");
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
