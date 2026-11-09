import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type pg from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { prepareCommit } from "@/github/commit";
import { createGitHubPublisher } from "@/github/publish";
import { PublicationRepository } from "@/tasks/publications";
import { createPublisher } from "@/tasks/publish";
import { type Publication, PublicationError, type Task } from "@/tasks/types";

vi.mock("@/github/commit");
vi.mock("@/github/publish");
vi.mock("@/tasks/publications");
beforeEach(() => vi.resetAllMocks());

function setup() {
  const task: Task = {
    id: randomUUID(),
    input: { owner: "owner", repo: "repo", issueNumber: 1 },
    status: "completed",
    sourceSha: "a".repeat(40),
    sourceBranch: "main",
    result: {
      summary: "Changed",
      prDescription: "Changed",
      prTitle: "fix: address the issue",
      patch: "saved binary patch",
    },
    publication: null,
    attempts: 1,
    sandboxId: null,
    model: null,
    promptVersion: null,
    usage: null,
    errorCode: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date(),
  };
  const publication: Publication = {
    status: "published",
    branch: `byo-pr-agent/${task.id}`,
    baseBranch: "main",
    commitSha: "b".repeat(40),
    branchUrl: "https://github.com/owner/repo/tree/branch",
    prNumber: 1,
    prUrl: "https://github.com/owner/repo/pull/1",
    error: null,
  };
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
    release: vi.fn(),
  });
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  const github = {
    author: vi.fn().mockResolvedValue({ name: "user", email: "1+user@users.noreply.github.com" }),
    branchSha: vi.fn().mockResolvedValue(null),
    findPull: vi.fn().mockResolvedValue(null),
    createPull: vi.fn().mockResolvedValue({ number: 1, url: publication.prUrl }),
  };
  const commit = {
    sha: "b".repeat(40),
    push: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(createGitHubPublisher).mockReturnValue(github);
  vi.mocked(prepareCommit).mockResolvedValue(commit);
  vi.mocked(PublicationRepository.prototype.complete).mockResolvedValue(publication);
  vi.mocked(PublicationRepository.prototype.fail).mockResolvedValue(undefined);
  const publish = createPublisher(pool as Pick<pg.Pool, "connect">, "test-secret");
  return {
    task,
    publication,
    pool,
    client,
    github,
    commit,
    publish,
    repository: vi.mocked(PublicationRepository.prototype),
  };
}

it("publishes once, persists before push, and reuses the saved PR even without credentials", async () => {
  const s = setup();
  expect(await s.publish(s.task)).toEqual({ httpStatus: 201, publication: s.publication });
  expect(s.repository.setCommit.mock.invocationCallOrder[0]).toBeLessThan(
    s.commit.push.mock.invocationCallOrder[0] ?? 0,
  );
  expect(s.commit.dispose).toHaveBeenCalledOnce();
  expect(s.client.release).toHaveBeenCalledExactlyOnceWith(false);
  s.task.publication = s.publication;
  expect(await createPublisher(s.pool as Pick<pg.Pool, "connect">)(s.task)).toEqual({
    httpStatus: 200,
    publication: s.publication,
  });
  expect(s.github.createPull).toHaveBeenCalledOnce();
});

it.each(["queued", "running", "failed"] as const)(
  "rejects %s without external work",
  async (status) => {
    const s = setup();
    expect(await s.publish({ ...s.task, status })).toMatchObject({ httpStatus: 409 });
    expect(s.pool.connect).not.toHaveBeenCalled();
  },
);

it("rejects empty patches, missing source and missing config", async () => {
  const s = setup();
  expect(
    await s.publish({
      ...s.task,
      result: { prTitle: "fix: test", prDescription: "Test changes", summary: "empty", patch: " " },
    }),
  ).toMatchObject({
    httpStatus: 409,
  });
  expect(await s.publish({ ...s.task, sourceSha: null })).toMatchObject({ httpStatus: 409 });
  expect(await s.publish({ ...s.task, sourceBranch: null })).toMatchObject({ httpStatus: 409 });
  if (!s.task.result) throw new Error("Missing test result");
  for (const field of ["prTitle", "prDescription"] as const) {
    expect(await s.publish({ ...s.task, result: { ...s.task.result, [field]: "" } })).toMatchObject(
      { httpStatus: 409 },
    );
  }
  expect(await createPublisher(s.pool as Pick<pg.Pool, "connect">)(s.task)).toMatchObject({
    httpStatus: 503,
  });
  expect(s.pool.connect).not.toHaveBeenCalled();
});

it("returns 202 only while another session holds the lock", async () => {
  const s = setup();
  s.client.query.mockResolvedValueOnce({ rows: [{ locked: false }] });
  expect(await s.publish(s.task)).toEqual({ httpStatus: 202, status: "in_progress" });
  expect(createGitHubPublisher).not.toHaveBeenCalled();
  expect(s.client.query).toHaveBeenCalledOnce();
  expect(s.client.release).toHaveBeenCalledExactlyOnceWith(false);
});

it("resumes a stale in-progress row with the persisted base and existing branch", async () => {
  const s = setup();
  s.repository.get.mockResolvedValue({
    ...s.publication,
    status: "in_progress",
    prUrl: null,
    prNumber: null,
    baseBranch: "original",
  });
  s.github.branchSha.mockResolvedValue(s.commit.sha);
  await s.publish(s.task);
  expect(prepareCommit).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: "original" }));
  expect(s.commit.push).not.toHaveBeenCalled();
  expect(s.github.createPull).toHaveBeenCalledWith(
    s.publication.branch,
    "original",
    s.task.id,
    "Changed",
    "fix: address the issue",
  );
});

it("propagates base divergence without pushing", async () => {
  const s = setup();
  vi.mocked(prepareCommit).mockRejectedValue(new PublicationError("BASE_DIVERGED"));
  expect(await s.publish(s.task)).toEqual({
    httpStatus: 409,
    error: "BASE_DIVERGED",
  });
  expect(s.commit.push).not.toHaveBeenCalled();
  expect(s.task.status).toBe("completed");
});

it("reconciles lost push and PR responses", async () => {
  const s = setup();
  s.commit.push.mockRejectedValue(new Error("transport token"));
  s.github.branchSha.mockResolvedValueOnce(null).mockResolvedValue(s.commit.sha);
  s.github.createPull.mockRejectedValue(new Error("ambiguous create"));
  s.github.findPull
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ number: 1, url: s.publication.prUrl });
  expect(await s.publish(s.task)).toMatchObject({ httpStatus: 201, publication: s.publication });
  expect(s.github.createPull).toHaveBeenCalledOnce();
});

it("reconciles a PR after a database save failure without another push or PR", async () => {
  const s = setup();
  s.repository.complete.mockRejectedValueOnce(new Error("database unavailable"));
  expect(await s.publish(s.task)).toEqual({ httpStatus: 502, error: "PUBLISH_FAILED" });
  s.github.findPull.mockResolvedValue({ number: 1, url: s.publication.prUrl });
  expect(await s.publish(s.task)).toEqual({ httpStatus: 200, publication: s.publication });
  expect(s.github.createPull).toHaveBeenCalledOnce();
  expect(s.commit.push).toHaveBeenCalledOnce();
});

it("fails safely on conflicting branches and unreconciled GitHub errors", async () => {
  const s = setup();
  s.github.branchSha.mockResolvedValue("c".repeat(40));
  expect(await s.publish(s.task)).toEqual({ httpStatus: 409, error: "BRANCH_CONFLICT" });
  expect(s.commit.push).not.toHaveBeenCalled();
  expect(s.github.createPull).not.toHaveBeenCalled();
  s.github.branchSha.mockResolvedValue(s.commit.sha);
  s.github.createPull.mockRejectedValue(
    Object.assign(new Error("secret 422 response"), { status: 422 }),
  );
  expect(await s.publish(s.task)).toEqual({ httpStatus: 502, error: "PUBLISH_FAILED" });
  expect(s.task.result?.patch).toBe("saved binary patch");
});

it("does not turn cleanup failure into publication failure, and releases a broken lock connection once", async () => {
  const s = setup();
  s.commit.dispose.mockRejectedValue(new Error("cleanup"));
  s.client.query
    .mockResolvedValueOnce({ rows: [{ locked: true }] })
    .mockRejectedValueOnce(new Error("unlock failed"));
  expect(await s.publish(s.task)).toMatchObject({ httpStatus: 201 });
  expect(s.client.release).toHaveBeenCalledExactlyOnceWith(true);
});

it("aborts remote writes after losing the lock connection", async () => {
  const s = setup();
  s.github.branchSha.mockImplementation(async () => {
    s.client.emit("error", new Error("connection lost"));
    return null;
  });
  expect(await s.publish(s.task)).toMatchObject({ httpStatus: 502 });
  expect(s.commit.push).not.toHaveBeenCalled();
  expect(s.github.createPull).not.toHaveBeenCalled();
  expect(s.client.release).toHaveBeenCalledExactlyOnceWith(true);
});

it("discards a connection when the lock-acquisition response is lost", async () => {
  const s = setup();
  s.client.query.mockRejectedValueOnce(new Error("ambiguous lock reply"));
  expect(await s.publish(s.task)).toMatchObject({ httpStatus: 502 });
  expect(s.client.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(createGitHubPublisher).not.toHaveBeenCalled();
});

it("reports Git write permission failures without exposing subprocess details", async () => {
  const s = setup();
  s.commit.push.mockRejectedValue(
    Object.assign(new Error("private command details"), {
      stderr: "remote: Permission denied.\nfatal: The requested URL returned error: 403",
    }),
  );
  expect(await s.publish(s.task)).toEqual({ httpStatus: 403, error: "GITHUB_WRITE_DENIED" });
  expect(s.repository.fail).toHaveBeenCalledWith(s.task.id, "GITHUB_WRITE_DENIED");
  expect(s.github.createPull).not.toHaveBeenCalled();
  expect(s.commit.dispose).toHaveBeenCalledOnce();
});
