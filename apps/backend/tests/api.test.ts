import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "@/api/app";
import { createLogger } from "@/logger";
import type { createPublisher } from "@/tasks/publish";
import { IdempotencyConflict, type Task } from "@/tasks/types";

const token = "a-test-token-that-is-at-least-32-characters";
const input = { owner: "octocat", repo: "hello-world", issueNumber: 1 };
const task: Task = {
  id: randomUUID(),
  input,
  status: "queued",
  attempts: 0,
  sandboxId: null,
  sourceSha: null,
  sourceBranch: null,
  publication: null,
  result: null,
  model: null,
  promptVersion: null,
  usage: null,
  errorCode: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function setup(
  github?: import("@/github/catalog").GitHubCatalog,
  publish?: ReturnType<typeof createPublisher>,
) {
  const tasks = {
    create: vi.fn().mockResolvedValue({ task, created: true }),
    get: vi.fn().mockResolvedValue(task),
    list: vi.fn().mockResolvedValue({ tasks: [task], counts: { queued: 1 }, hasMore: false }),
  };
  const ready = vi.fn().mockResolvedValue(undefined);
  const app = createApp({
    github,
    tasks,
    ready,
    apiToken: token,
    logger: createLogger("silent"),
    ...(publish ? { publish } : {}),
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/v1/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "test-request-1",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { tasks, ready, app, post };
}

describe("task API", () => {
  it("requires authentication before accepting work", async () => {
    const { post, tasks } = setup();
    expect((await post(input, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect(tasks.create).not.toHaveBeenCalled();
  });
  it("authenticates and validates paginated task listing", async () => {
    const { app, tasks } = setup();
    expect((await app.request("/v1/tasks")).status).toBe(401);
    expect(tasks.list).not.toHaveBeenCalled();
    const headers = { Authorization: `Bearer ${token}` };
    const response = await app.request(
      "/v1/tasks?status=running&search=octocat&limit=10&offset=20",
      { headers },
    );
    expect(response.status).toBe(200);
    expect(tasks.list).toHaveBeenCalledWith({
      status: "running",
      search: "octocat",
      limit: 10,
      offset: 20,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    for (const query of ["limit=101", "offset=-1", "status=invalid"]) {
      expect((await app.request(`/v1/tasks?${query}`, { headers })).status).toBe(400);
    }
  });
  it("accepts validated work and returns its polling location", async () => {
    const { post } = setup();
    const response = await post(input);
    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toBe(`/v1/tasks/${task.id}`);
  });
  it("rejects missing keys, malformed JSON, and unsafe repository identifiers", async () => {
    const { post, app, tasks } = setup();
    expect((await post(input, { "Idempotency-Key": "" })).status).toBe(400);
    expect((await post({ ...input, repo: "../secret" })).status).toBe(400);
    expect(
      (
        await app.request("/v1/tasks", {
          method: "POST",
          body: "{",
          headers: {
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": "bad-json",
          },
        })
      ).status,
    ).toBe(400);
    expect(tasks.create).not.toHaveBeenCalled();
  });
  it("reports key conflicts without leaking internal errors", async () => {
    const { post, tasks } = setup();
    tasks.create.mockRejectedValueOnce(new IdempotencyConflict());
    expect((await post(input)).status).toBe(409);
    tasks.create.mockRejectedValueOnce(new Error("secret-database-url"));
    const response = await post(input);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-database-url");
  });
  it("keeps liveness independent of database readiness", async () => {
    const { app, ready } = setup();
    ready.mockRejectedValue(new Error("offline"));
    expect((await app.request("/health/live")).status).toBe(200);
    expect((await app.request("/health/ready")).status).toBe(503);
  });
  it("validates task IDs and handles missing tasks", async () => {
    const { app, tasks } = setup();
    const headers = { Authorization: `Bearer ${token}` };
    expect((await app.request("/v1/tasks/not-a-uuid", { headers })).status).toBe(400);
    tasks.get.mockResolvedValue(undefined);
    expect((await app.request(`/v1/tasks/${task.id}`, { headers })).status).toBe(404);
  });
});

describe("GitHub catalog API", () => {
  it("authenticates, validates, paginates, and hides upstream errors", async () => {
    const github = {
      repositories: vi.fn().mockResolvedValue({ repositories: [], nextPage: 2 }),
      issues: vi.fn().mockResolvedValue({ issues: [], nextPage: null }),
    };
    const { app } = setup(github);
    expect((await app.request("/v1/github/repositories")).status).toBe(401);
    expect(github.repositories).not.toHaveBeenCalled();
    const headers = { Authorization: `Bearer ${token}` };
    const response = await app.request("/v1/github/repositories?page=1", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ repositories: [], nextPage: 2 });
    expect(
      (await app.request("/v1/github/issues?owner=octocat&repo=hello-world&page=2", { headers }))
        .status,
    ).toBe(200);
    expect(github.issues).toHaveBeenCalledWith("octocat", "hello-world", 2);
    github.issues.mockClear();
    for (const query of [
      "owner=bad/name&repo=test",
      "owner=octocat",
      "repo=hello-world",
      "owner=octocat&repo=..",
      "owner=octocat&repo=../secret",
    ]) {
      expect((await app.request(`/v1/github/issues?${query}`, { headers })).status).toBe(400);
    }
    expect(github.issues).not.toHaveBeenCalled();
    expect((await app.request("/v1/github/repositories?page=0", { headers })).status).toBe(400);
    github.repositories.mockRejectedValueOnce(new Error("secret-token"));
    const failed = await app.request("/v1/github/repositories", { headers });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("secret-token");
    expect((await setup().app.request("/v1/github/repositories", { headers })).status).toBe(503);
  });
});

describe("draft PR API", () => {
  const headers = { Authorization: `Bearer ${token}` };
  const path = `/v1/tasks/${task.id}/draft-pr`;
  it("requires auth and a valid task before calling the publisher", async () => {
    const publish = vi.fn<ReturnType<typeof createPublisher>>();
    const { app, tasks } = setup(undefined, publish);
    expect((await app.request(path, { method: "POST" })).status).toBe(401);
    expect((await app.request("/v1/tasks/bad/draft-pr", { method: "POST", headers })).status).toBe(
      400,
    );
    tasks.get.mockResolvedValue(undefined);
    expect((await app.request(path, { method: "POST", headers })).status).toBe(404);
    expect(publish).not.toHaveBeenCalled();
  });
  it("returns typed progress and errors without leaking upstream data", async () => {
    const publish = vi
      .fn<ReturnType<typeof createPublisher>>()
      .mockResolvedValue({ httpStatus: 202, status: "in_progress" });
    const { app } = setup(undefined, publish);
    const response = await app.request(path, { method: "POST", headers });
    expect(response.status).toBe(202);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toEqual({ status: "in_progress" });
    publish.mockResolvedValueOnce({ httpStatus: 409, error: "TASK_NOT_PUBLISHABLE" });
    expect((await app.request(path, { method: "POST", headers })).status).toBe(409);
    publish.mockResolvedValueOnce({ httpStatus: 503, error: "GITHUB_NOT_CONFIGURED" });
    expect((await app.request(path, { method: "POST", headers })).status).toBe(503);
    publish.mockRejectedValueOnce(new Error("secret upstream token"));
    const failed = await app.request(path, { method: "POST", headers });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("secret");
  });
  it("returns the same saved URL on repeats without requiring an idempotency header", async () => {
    const publication = {
      status: "published" as const,
      branch: "branch",
      baseBranch: "main",
      commitSha: "a".repeat(40),
      branchUrl: "branch-url",
      prNumber: 1,
      prUrl: "https://github.com/owner/repo/pull/1",
      error: null,
    };
    const publish = vi
      .fn<ReturnType<typeof createPublisher>>()
      .mockResolvedValueOnce({ httpStatus: 201, publication })
      .mockResolvedValue({ httpStatus: 200, publication });
    const { app } = setup(undefined, publish);
    for (const status of [201, 200]) {
      const response = await app.request(path, { method: "POST", headers });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ publication });
    }
  });
});
