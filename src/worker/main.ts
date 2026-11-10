import { Queue, Worker } from "bullmq";
import { z } from "zod";
import { createExecutor } from "@/agent/executor";
import { readWorkerConfig } from "@/config";
import { createDatabase } from "@/db/client";
import { createIssueReader } from "@/github/issues";
import { createLogger } from "@/logger";
import { createRedis, JOB_ATTEMPTS, QUEUE_NAME } from "@/queue/connection";
import { runDispatcher } from "@/queue/dispatcher";
import { createSandboxProvider } from "@/sandbox/daytona";
import { createExecutionHandler } from "@/tasks/execute";
import { TaskRepository } from "@/tasks/repository";

const config = readWorkerConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDatabase(config.DATABASE_URL);
db.on("error", () => logger.error("database connection failed"));
const tasks = new TaskRepository(db);
const producer = createRedis(config.REDIS_URL, "producer");
const consumer = createRedis(config.REDIS_URL, "worker");
for (const connection of [producer, consumer])
  connection.on("error", () => logger.error("Redis connection failed"));
const queue = new Queue(QUEUE_NAME, { connection: producer });
queue.on("error", () => logger.error("queue failed"));
const execute = createExecutionHandler({
  tasks,
  logger,
  readIssue: createIssueReader(config.GITHUB_TOKEN),
  createSandbox: createSandboxProvider(config),
  execute: createExecutor(config),
});
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { taskId } = z.object({ taskId: z.uuid() }).parse(job.data);
    await execute(taskId, job.attemptsMade + 1 >= (job.opts.attempts ?? JOB_ATTEMPTS));
  },
  { connection: consumer, concurrency: config.WORKER_CONCURRENCY },
);
worker.on("error", () => logger.error("worker failed"));
worker.on("failed", (job) => {
  logger.warn({ taskId: job?.id }, "job attempt failed");
  // Covers BullMQ terminal failures such as exceeding the stalled-job limit.
  if (job)
    void job
      .getState()
      .then(async (state) => {
        if (state === "failed" && job.id) await tasks.fail(job.id, true);
      })
      .catch(() => logger.error("failed to reconcile terminal job"));
});
const controller = new AbortController();
const dispatcher = runDispatcher(tasks, queue, logger, controller.signal);
logger.info({ concurrency: config.WORKER_CONCURRENCY }, "worker started");

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void (async () => {
      controller.abort();
      // Active work is bounded; forced termination is recovered by BullMQ's stalled-job handling.
      const deadline = setTimeout(
        () => process.exit(1),
        2 * config.AGENT_TIMEOUT_MS + 180000,
      ).unref();
      await dispatcher;
      await worker.close();
      await queue.close();
      await Promise.all([producer.quit(), consumer.quit(), db.end()]);
      clearTimeout(deadline);
    })().catch(() => {
      logger.error("shutdown failed");
      process.exitCode = 1;
    });
  });
}
