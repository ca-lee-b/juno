import type { Logger } from "pino";
import {
  type Execute,
  ExecutionError,
  type IssueContext,
  type RepositorySandbox,
} from "@/execution/contracts";
import type { TaskInput } from "@/tasks/input";
import type { TaskRepository } from "@/tasks/repository";

type Dependencies = {
  tasks: Pick<TaskRepository, "start" | "setSource" | "setSandbox" | "complete" | "fail">;
  readIssue: (input: TaskInput, sourceSha: string | null) => Promise<IssueContext>;
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
    let sandbox: RepositorySandbox | undefined;
    try {
      const issue = await readIssue(task.input, task.sourceSha);
      await tasks.setSource(taskId, issue.sha, issue.branch);
      sandbox = await createSandbox(taskId);
      await tasks.setSandbox(taskId, sandbox.id);
      await sandbox.clone(issue);
      const result = await execute(issue, sandbox);
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
