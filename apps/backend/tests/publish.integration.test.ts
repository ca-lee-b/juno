import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "@/db/client";
import { prepareCommit } from "@/github/commit";
import { createGitHubPublisher } from "@/github/publish";
import { PublicationRepository } from "@/tasks/publications";
import { createPublisher } from "@/tasks/publish";
import { TaskRepository } from "@/tasks/repository";
import { applyTestMigrations } from "./database";

vi.mock("@/github/commit");
vi.mock("@/github/publish");
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Postgres publication lifecycle", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url ?? "postgres://unused");
  const pool = new pg.Pool({
    connectionString: url ?? "postgres://unused",
    options: `-c search_path=${schema}`,
  });
  const tasks = new TaskRepository(pool);
  const publications = new PublicationRepository(pool);
  const publish = createPublisher(pool, "test-secret");
  const pr = { number: 7, url: "https://github.com/owner/repo/pull/7" };
  const github = {
    author: vi.fn().mockResolvedValue({ name: "user", email: "1+user@users.noreply.github.com" }),
    branchSha: vi.fn(),
    findPull: vi.fn(),
    createPull: vi.fn(),
  };
  const commit = { sha: "b".repeat(40), push: vi.fn(), dispose: vi.fn() };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await applyTestMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    github.branchSha.mockResolvedValue(null);
    github.findPull.mockResolvedValue(null);
    github.createPull.mockResolvedValue(pr);
    commit.push.mockResolvedValue(undefined);
    commit.dispose.mockResolvedValue(undefined);
    vi.mocked(createGitHubPublisher).mockReturnValue(github);
    vi.mocked(prepareCommit).mockResolvedValue(commit);
  });
  async function completed() {
    const { task } = await tasks.create(
      { owner: "owner", repo: "repo", issueNumber: 1 },
      randomUUID(),
    );
    await tasks.start(task.id);
    await tasks.setSource(task.id, "a".repeat(40), "main");
    await tasks.complete(task.id, {
      result: {
        prTitle: "fix: test",
        prDescription: "Test changes",
        summary: "Reviewed",
        patch: "saved patch",
      },
      model: "test",
      promptVersion: "test",
      usage: null,
    });
    const saved = await tasks.get(task.id);
    if (!saved) throw new Error("Task missing");
    return saved;
  }

  it("serializes concurrent requests and retains one publication in task detail and list", async () => {
    const task = await completed();
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    github.createPull.mockImplementation(async () => {
      entered.resolve();
      await proceed.promise;
      return pr;
    });
    const first = publish(task);
    await entered.promise;
    try {
      expect(await publish(task)).toEqual({ httpStatus: 202, status: "in_progress" });
    } finally {
      proceed.resolve();
    }
    expect(await first).toMatchObject({ httpStatus: 201, publication: { prUrl: pr.url } });
    expect(await publish(task)).toMatchObject({ httpStatus: 200, publication: { prUrl: pr.url } });
    expect(github.createPull).toHaveBeenCalledOnce();
    expect(await tasks.get(task.id)).toMatchObject({
      status: "completed",
      result: task.result,
      publication: { prUrl: pr.url, commitSha: commit.sha },
    });
    expect(
      (await tasks.list({ search: "owner/repo", limit: 100, offset: 0 })).tasks.find(
        (item) => item.id === task.id,
      )?.publication?.prUrl,
    ).toBe(pr.url);
    expect(
      (
        await pool.query("SELECT count(*)::int AS count FROM task_publications WHERE task_id=$1", [
          task.id,
        ])
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("recovers an abandoned in-progress record and existing PR after restart", async () => {
    const task = await completed();
    await publications.start(task.id, `byo-pr-agent/${task.id}`, "main", "branch-url");
    await publications.setCommit(task.id, commit.sha);
    github.findPull.mockResolvedValue(pr);
    expect(await publish(task)).toMatchObject({
      httpStatus: 200,
      publication: { status: "published", prUrl: pr.url },
    });
    expect(prepareCommit).not.toHaveBeenCalled();
    expect(github.createPull).not.toHaveBeenCalled();
  });

  it("keeps the reviewed artifact on failure and resumes the same branch on retry", async () => {
    const task = await completed();
    github.createPull.mockRejectedValueOnce(new Error("private provider detail"));
    expect(await publish(task)).toEqual({ httpStatus: 502, error: "PUBLISH_FAILED" });
    expect(await tasks.get(task.id)).toMatchObject({
      status: "completed",
      result: task.result,
      publication: { status: "failed", error: "PUBLISH_FAILED", commitSha: commit.sha },
    });
    github.branchSha.mockResolvedValue(commit.sha);
    expect(await publish(task)).toMatchObject({ httpStatus: 201, publication: { prUrl: pr.url } });
    expect(commit.push).toHaveBeenCalledOnce();
  });

  it("preserves the source branch across publication retries", async () => {
    const task = await completed();
    await tasks.setSource(task.id, "c".repeat(40), "renamed");
    expect(await tasks.get(task.id)).toMatchObject({
      sourceSha: task.sourceSha,
      sourceBranch: "main",
    });
    vi.mocked(prepareCommit).mockRejectedValueOnce(new Error("temporary fetch error"));
    expect(await publish(task)).toMatchObject({ httpStatus: 502 });
    expect(await publish(task)).toMatchObject({ httpStatus: 201 });
    expect(await publications.get(task.id)).toMatchObject({ baseBranch: "main" });
  });
});
