import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@/db/client";
import { TaskRepository } from "@/tasks/repository";
import { IdempotencyConflict } from "@/tasks/types";
import { applyTestMigrations } from "./database";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Postgres task persistence", () => {
  const pool = createDatabase(url ?? "postgres://unused");
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  let tasks: TaskRepository;
  let client: PoolClient;
  beforeAll(async () => {
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await applyTestMigrations(client);
    tasks = new TaskRepository(client);
  });
  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      client.release();
    }
    await pool.end();
  });

  const input = { owner: "Octocat", repo: "Hello-World", issueNumber: 1 };
  it("creates a task and outbox entry atomically, deduplicates, and rejects conflicts", async () => {
    const key = randomUUID();
    const first = await tasks.create(input, key);
    const repeated = await tasks.create({ ...input, owner: "octocat" }, key);
    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.task.id).toBe(first.task.id);
    expect(await tasks.pending()).toContainEqual({ taskId: first.task.id });
    await expect(tasks.create({ ...input, issueNumber: 2 }, key)).rejects.toBeInstanceOf(
      IdempotencyConflict,
    );
    await tasks.published(first.task.id);
    expect(await tasks.pending()).not.toContainEqual({ taskId: first.task.id });
  });
  it("preserves completed tasks on redelivery", async () => {
    const { task } = await tasks.create(input, randomUUID());
    await tasks.start(task.id);
    await tasks.setSource(task.id, "a".repeat(40), "main");
    await tasks.complete(task.id, {
      result: { prTitle: "fix: test", prDescription: "Test changes", summary: "test", patch: "" },
      model: "test",
      promptVersion: "v1",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    await tasks.fail(task.id, true);
    expect(await tasks.start(task.id)).toBeUndefined();
    expect(await tasks.get(task.id)).toMatchObject({
      status: "completed",
      attempts: 1,
      sourceSha: "a".repeat(40),
    });
  });
  it("lists persisted tasks with filters, counts and pagination", async () => {
    const search = `list-${randomUUID().slice(0, 8)}`;
    const first = await tasks.create({ owner: search, repo: "demo", issueNumber: 1 }, randomUUID());
    const second = await tasks.create(
      { owner: search, repo: "demo", issueNumber: 2 },
      randomUUID(),
    );
    await tasks.start(first.task.id);
    await tasks.complete(first.task.id, {
      result: {
        prTitle: "fix: test",
        prDescription: "Test changes",
        summary: "Done",
        patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-before\n+after",
      },
      model: "test",
      promptVersion: "v1",
      usage: null,
    });
    const page = await tasks.list({ search, limit: 1, offset: 0 });
    expect(page.tasks).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.counts).toEqual({ queued: 1, completed: 1 });
    const next = await tasks.list({ search, limit: 1, offset: 1 });
    expect(next.tasks[0]?.id).not.toBe(page.tasks[0]?.id);
    expect(next.hasMore).toBe(false);
    const completed = await tasks.list({ search, status: "completed", limit: 50, offset: 0 });
    expect(completed.tasks).toMatchObject([
      { id: first.task.id, changes: { additions: 1, deletions: 1 } },
    ]);
    expect(completed.tasks[0]).not.toHaveProperty("result");
    expect(
      (await tasks.list({ search: `${search}/demo #2`, limit: 50, offset: 0 })).tasks[0]?.id,
    ).toBe(second.task.id);
  });
  it("retries failed attempts and makes final failures terminal", async () => {
    const { task } = await tasks.create(input, randomUUID());
    await tasks.start(task.id);
    await tasks.fail(task.id, false);
    expect(await tasks.start(task.id)).toMatchObject({ status: "running", attempts: 2 });
    await tasks.fail(task.id, true);
    expect(await tasks.start(task.id)).toBeUndefined();
    expect(await tasks.get(task.id)).toMatchObject({ status: "failed" });
  });
});
