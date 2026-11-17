import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";

// Isolated fixture API: never invokes the real worker or paid providers.
const id = "11111111-1111-4111-8111-111111111111";
const input = { owner: "example", repo: "project", issueNumber: 42 };
let submissions = 0;
let publishStatus = 201;
let publications = 0;
const mock = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.headers.authorization !== "Bearer fixture-token") {
    res.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  if (req.url.startsWith("/v1/github/")) {
    const url = new URL(req.url, "http://fixture");
    assert.equal(url.searchParams.get("page"), "2");
    if (url.pathname.endsWith("issues")) {
      assert.equal(url.searchParams.get("owner"), "example");
      assert.equal(url.searchParams.get("repo"), "project");
      res.end(JSON.stringify({ issues: [{ number: 42, title: "Example issue" }], nextPage: null }));
    } else
      res.end(
        JSON.stringify({
          repositories: [
            { owner: "example", name: "project", fullName: "example/project", private: true },
          ],
          nextPage: null,
        }),
      );
  } else if (req.url === `/v1/tasks/${id}/draft-pr` && req.method === "POST") {
    publications++;
    res
      .writeHead(publishStatus)
      .end(
        JSON.stringify(
          publishStatus === 202
            ? { status: "in_progress" }
            : publishStatus === 409
              ? { error: "BASE_DIVERGED" }
              : {
                  publication: {
                    status: "published",
                    prNumber: 7,
                    prUrl: "https://github.com/example/project/pull/7",
                  },
                },
        ),
      );
  } else if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), input);
    assert.equal(req.headers["idempotency-key"], "fixture-key");
    submissions++;
    res.writeHead(202).end(JSON.stringify({ task: { id, input, status: "queued" } }));
  } else if (req.url.startsWith("/v1/tasks?")) {
    const url = new URL(req.url, "http://fixture");
    assert.equal(url.searchParams.get("status"), "completed");
    assert.equal(url.searchParams.get("search"), "example");
    res.end(
      JSON.stringify({
        tasks: [
          {
            id,
            input,
            status: "completed",
            createdAt: new Date().toISOString(),
            changes: { additions: 1, deletions: 0 },
          },
        ],
        counts: { completed: 1 },
        hasMore: false,
      }),
    );
  } else if (req.url.endsWith(id)) {
    res.end(
      JSON.stringify({
        task: { id, input, status: "completed", result: { summary: "Done", patch: "" } },
      }),
    );
  } else res.writeHead(404).end(JSON.stringify({ error: "Task not found" }));
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const port = 31391;
const origin = `http://127.0.0.1:${port}`;
const app = spawn(
  process.execPath,
  [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    env: { ...process.env, AGENT_API_URL: `http://127.0.0.1:${mock.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 20000);
    app.stdout.on("data", (data) => {
      if (data.toString().includes("Ready")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    app.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited ${code}`));
    });
  });
  const call = (path, options = {}) => fetch(origin + path, options);
  assert.equal((await call("/")).status, 200);
  assert.equal((await call(`/api/tasks/${id}`)).status, 401);
  assert.equal((await call("/api/tasks")).status, 401);
  assert.equal((await call("/api/github/repositories")).status, 401);
  assert.equal(
    (
      await call("/api/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" },
        body: JSON.stringify({ token: "fixture-token" }),
      })
    ).status,
    403,
  );
  const connected = await call("/api/connection", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token: "fixture-token" }),
  });
  assert.equal(connected.status, 200);
  const cookieHeader = connected.headers.get("set-cookie");
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=strict/i);
  const headers = {
    Cookie: cookieHeader.split(";")[0],
    Origin: origin,
    "Content-Type": "application/json",
    "Idempotency-Key": "fixture-key",
  };
  assert.equal(
    (
      await call("/api/tasks", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, issueNumber: -1 }),
      })
    ).status,
    400,
  );
  const repositories = await call("/api/github/repositories?page=2", { headers });
  assert.equal(repositories.status, 200);
  assert.equal(repositories.headers.get("cache-control"), "no-store");
  assert.equal((await repositories.json()).repositories[0].private, true);
  const issues = await call("/api/github/issues?owner=example&repo=project&page=2", { headers });
  assert.equal((await issues.json()).issues[0].number, 42);
  assert.equal((await call("/api/github/unknown", { headers })).status, 404);
  assert.equal(submissions, 0);
  assert.equal(
    (await call("/api/tasks", { method: "POST", headers, body: JSON.stringify(input) })).status,
    202,
  );
  assert.equal(submissions, 1);
  const list = await call("/api/tasks?status=completed&search=example&limit=50&offset=0", {
    headers,
  });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).tasks[0].id, id);
  const task = await (await call(`/api/tasks/${id}`, { headers })).json();
  assert.equal(task.task.result.patch, "");
  assert.equal((await call("/api/tasks/not-a-uuid", { headers })).status, 400);
  const draftPath = `/api/tasks/${id}/draft-pr`;
  assert.equal(
    (await call(draftPath, { method: "POST", headers: { Origin: origin } })).status,
    401,
  );
  assert.equal(
    (
      await call(draftPath, {
        method: "POST",
        headers: { ...headers, Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/tasks/not-a-uuid/draft-pr", { method: "POST", headers })).status,
    400,
  );
  assert.equal(publications, 0);
  for (const status of [201, 200, 202, 409]) {
    publishStatus = status;
    const response = await call(draftPath, { method: "POST", headers });
    assert.equal(response.status, status);
    const body = await response.json();
    if (status === 202) assert.equal(body.status, "in_progress");
    else if (status === 409) assert.equal(body.error, "BASE_DIVERGED");
    else assert.equal(body.publication.prNumber, 7);
  }
  assert.equal(publications, 4);
  assert.equal((await call("/api/connection", { method: "DELETE", headers })).status, 200);
  console.log(
    "PASS: page, authentication, origin protection, input validation, task creation, result retrieval, empty patch, draft PR publishing and errors, disconnect",
  );
} finally {
  app.kill("SIGTERM");
  await new Promise((resolve) => mock.close(resolve));
}
