import { expect, it, vi } from "vitest";
import { dispatchPending, runDispatcher } from "@/queue/dispatcher";

it("keeps the outbox pending if Redis is unavailable", async () => {
  const tasks = { pending: vi.fn().mockResolvedValue([{ taskId: "task-1" }]), published: vi.fn() };
  const queue = { add: vi.fn().mockRejectedValue(new Error("Redis offline")) };
  await expect(dispatchPending(tasks, queue)).rejects.toThrow("Redis offline");
  expect(tasks.published).not.toHaveBeenCalled();
});

it("logs the underlying dispatch error while running", async () => {
  const controller = new AbortController();
  const err = new Error("Redis offline");
  const tasks = { pending: vi.fn().mockRejectedValue(err), published: vi.fn() };
  const logger = { warn: vi.fn(() => controller.abort()) };
  await runDispatcher(tasks, { add: vi.fn() }, logger, controller.signal);
  expect(logger.warn).toHaveBeenCalledWith({ err }, "outbox dispatch failed; retrying");
});

it("does not report a retry when an in-flight dispatch fails during shutdown", async () => {
  const controller = new AbortController();
  const tasks = {
    pending: vi.fn(async () => {
      controller.abort();
      throw new Error("connection closed");
    }),
    published: vi.fn(),
  };
  const logger = { warn: vi.fn() };
  await runDispatcher(tasks, { add: vi.fn() }, logger, controller.signal);
  expect(logger.warn).not.toHaveBeenCalled();
  expect(tasks.pending).toHaveBeenCalledTimes(1);
});

it("reuses the job ID if publishing succeeded but acknowledgment failed", async () => {
  const tasks = {
    pending: vi.fn().mockResolvedValue([{ taskId: "task-1" }]),
    published: vi
      .fn()
      .mockRejectedValueOnce(new Error("database offline"))
      .mockResolvedValue(undefined),
  };
  const queue = { add: vi.fn().mockResolvedValue({}) };
  await expect(dispatchPending(tasks, queue)).rejects.toThrow();
  await dispatchPending(tasks, queue);
  expect(queue.add.mock.calls[0]).toEqual(queue.add.mock.calls[1]);
  expect(queue.add.mock.calls[0]?.[2]).toMatchObject({ jobId: "task-1", removeOnComplete: false });
});
