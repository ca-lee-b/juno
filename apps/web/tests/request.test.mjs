import assert from "node:assert/strict";
import { request } from "../src/lib/request.ts";

const originalFetch = globalThis.fetch;
try {
  const controller = new AbortController();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/tasks");
    assert.equal(init.signal, controller.signal);
    assert.equal(init.headers.get("Idempotency-Key"), "retry-key");
    assert.equal(init.headers.get("Content-Type"), "application/json");
    return Response.json({ task: { id: "example" } });
  };
  assert.deepEqual(
    await request("/api/tasks", {
      signal: controller.signal,
      headers: new Headers({ "Idempotency-Key": "retry-key" }),
    }),
    { task: { id: "example" } },
  );
  globalThis.fetch = async () => Response.json({ error: "Unauthorized" }, { status: 401 });
  await assert.rejects(request("/api/tasks"), /Unauthorized/);
  globalThis.fetch = async () => Response.json(null, { status: 502 });
  await assert.rejects(request("/api/tasks"), /Request failed \(502\)/);
  for (const status of [200, 502]) {
    globalThis.fetch = async () => new Response("not JSON", { status });
    await assert.rejects(request("/api/tasks"), /unexpected response/);
  }
  controller.abort();
  globalThis.fetch = async (_url, init) => {
    init.signal.throwIfAborted();
  };
  await assert.rejects(request("/api/tasks", { signal: controller.signal }), {
    name: "AbortError",
  });
} finally {
  globalThis.fetch = originalFetch;
}
console.log("PASS: JSON responses, headers, API errors, malformed responses, and cancellation");
