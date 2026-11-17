import { setTimeout } from "node:timers/promises";
import type { Queue } from "bullmq";
import type { Logger } from "pino";
import { JOB_ATTEMPTS } from "@/queue/connection";
import type { TaskRepository } from "@/tasks/repository";

export async function dispatchPending(
  tasks: Pick<TaskRepository, "pending" | "published">,
  queue: Pick<Queue, "add">,
) {
  for (const { taskId } of await tasks.pending()) {
    // A crash between add and published is safe: the same job ID is added again.
    await queue.add(
      "analyze",
      { taskId },
      {
        jobId: taskId,
        attempts: JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    await tasks.published(taskId);
  }
}

export async function runDispatcher(
  tasks: Pick<TaskRepository, "pending" | "published">,
  queue: Pick<Queue, "add">,
  logger: Pick<Logger, "warn">,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      await dispatchPending(tasks, queue);
    } catch (err) {
      if (signal.aborted) break;
      logger.warn({ err }, "outbox dispatch failed; retrying");
    }
    if (signal.aborted) break;
    await setTimeout(1000, undefined, { signal }).catch(() => undefined);
  }
}
