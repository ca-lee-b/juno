import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { listenForEngines, runLive } from "@/agent/live";
import type { Sandbox } from "@/sandbox/contracts";

vi.mock("node:fs/promises", () => ({ readFile: async () => Buffer.from("fixture engine") }));

it("sends a follow-up on the existing connection after a completed turn and releases it on Settle", async () => {
  const server = listenForEngines(0);
  await once(server, "listening");
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const operations: string[] = [];
  let replyCount = 0;
  const tasks = {
    waiting: vi.fn(),
    liveLost: vi.fn(),
    reply: vi.fn(async () => {
      replyCount++;
    }),
    inbox: vi.fn(async (_id: string, after: string) => ({
      settling: replyCount === 2,
      id: replyCount === 1 && after === "0" ? "1" : null,
      body: "Change the heading",
    })),
  };
  const executeCommand: Sandbox["executeCommand"] = async (_command, _cwd, env) => {
    const socket = new WebSocket(endpoint, {
      headers: { authorization: `Bearer ${env?.TOWLINE_TOKEN}` },
    });
    let seq = 0;
    socket.on("message", (raw) => {
      const { id, op, text } = JSON.parse(raw.toString());
      operations.push(op);
      socket.send(JSON.stringify({ id, result: null }));
      if (op === "send") {
        for (const event of [
          { method: "turn/started", params: { turn: { id: `turn-${seq}` } } },
          { method: "item/completed", params: { item: { type: "agentMessage", text } } },
          { method: "turn/completed", params: { turn: { status: "completed" } } },
        ])
          socket.send(JSON.stringify({ seq: ++seq, event }));
      }
    });
    return { exitCode: 0, result: "" };
  };
  try {
    const output = await runLive(
      { executeCommand, uploadFile: vi.fn(), renew: vi.fn() },
      {
        ENGINE_ENDPOINT: endpoint,
        OPENAI_API_KEY: "openai",
        GITHUB_TOKEN: "github",
        OPENAI_CODEX_MODEL: "test",
        OPENAI_CODEX_MODEL_EFFORT: "medium",
        AGENT_TIMEOUT_MS: 5000,
      },
      tasks,
      "issue",
      "Initial request",
    );
    expect(operations).toEqual(["replay", "send", "send"]);
    expect(output.summary).toBe("Change the heading");
    expect(tasks.reply.mock.calls).toHaveLength(2);
  } finally {
    for (const ws of server.clients) ws.terminate();
    server.close();
  }
});
