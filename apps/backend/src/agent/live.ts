import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import type { WorkerConfig } from "@/config";
import type { Sandbox } from "@/sandbox/contracts";
import type { TaskRepository } from "@/tasks/repository";

const waiting = new Map<string, (socket: WebSocket) => void>();
export function listenForEngines(port: number) {
  const server = new WebSocketServer({
    port,
    maxPayload: 4 << 20,
    verifyClient: ({ req }: { req: IncomingMessage }) =>
      waiting.has(req.headers.authorization ?? ""),
  });
  server.on("connection", (socket, req) => {
    const key = req.headers.authorization ?? "";
    const accept = waiting.get(key);
    waiting.delete(key);
    if (accept) accept(socket);
    else socket.terminate();
  });
  return server;
}

type Question = {
  id: string;
  question: string;
  options?: { label: string; description: string }[];
};
type Event = {
  id?: number;
  method: string;
  params: { turn?: { id: string }; item?: { type: string; text: string }; questions?: Question[] };
};

export async function runLive(
  sandbox: Pick<Sandbox, "executeCommand" | "uploadFile">,
  config: Pick<
    WorkerConfig,
    "OPENAI_API_KEY" | "OPENAI_CODEX_MODEL" | "OPENAI_CODEX_MODEL_EFFORT" | "AGENT_TIMEOUT_MS"
  >,
  tasks: TaskRepository,
  id: string,
  lastUser: string,
) {
  const dir = "/tmp/agent-output";
  await sandbox.uploadFile(
    await readFile(new URL("../../bin/engine", import.meta.url)),
    `${dir}/engine`,
  );
  const endpoint = process.env.ENGINE_ENDPOINT ?? "";
  const token = randomBytes(32).toString("hex");
  const key = `Bearer ${token}`;
  let socket: WebSocket | undefined;
  let turn: string | undefined,
    idle = false,
    stopping = false;
  let question:
    | { requestId: number; remaining: Question[]; answers: Record<string, { answers: string[] }> }
    | undefined;
  let ack: { id: string; resolve: (error?: string) => void } | undefined;
  let stored = Promise.resolve();
  const log = (body: string) => {
    stored = stored.then(() => tasks.reply(id, body));
    void stored.catch(() => socket?.terminate());
  };
  const show = (q: Question) =>
    log([q.question, ...(q.options ?? []).map((o) => `${o.label} — ${o.description}`)].join("\n"));
  let serial = 0;
  const request = (data: Record<string, unknown>) =>
    new Promise<string | undefined>((resolve) => {
      if (socket?.readyState !== WebSocket.OPEN) {
        resolve("disconnected");
        return;
      }
      const id = String(++serial);
      ack = { id, resolve };
      socket.send(JSON.stringify({ ...data, id }));
    });
  let lost = false;
  const disconnected = () => {
    ack?.resolve("disconnected");
    ack = undefined;
    if (stopping || lost) return;
    lost = true;
    stored = stored.then(() => tasks.liveLost(id));
    void stored.catch(() => {});
  };
  waiting.set(key, (ws) => {
    socket = ws;
    ws.on("error", () => ws.terminate());
    ws.on("close", disconnected);
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as { id?: string; error?: string; event?: Event };
        if (ack && frame.id === ack.id) {
          ack.resolve(frame.error);
          ack = undefined;
          return;
        }
        const e = frame.event;
        if (!e) return;
        if (e.method === "turn/started") {
          turn = e.params.turn?.id;
          idle = false;
        }
        if (e.method === "turn/completed") {
          turn = undefined;
          idle = true;
        }
        if (e.method === "item/completed" && e.params.item?.type === "agentMessage")
          log(e.params.item.text);
        if (
          e.method === "item/tool/requestUserInput" &&
          e.id !== undefined &&
          e.params.questions?.[0]
        ) {
          question = { requestId: e.id, remaining: e.params.questions, answers: {} };
          show(e.params.questions[0]);
        }
      } catch {
        ws.terminate();
      }
    });
  });
  const timeout = Math.ceil(config.AGENT_TIMEOUT_MS / 1000);
  const command = sandbox.executeCommand(
    `chmod 700 ${dir}/engine && touch ${dir}/events.jsonl && timeout --kill-after=10s ${timeout}s ${dir}/engine -dir /tmp/repository -codex /tmp/codex-runtime/node_modules/.bin/codex -output-dir ${dir}`,
    "/tmp/repository",
    {
      ENGINE_ENDPOINT: endpoint,
      ENGINE_TOKEN: token,
      CODEX_API_KEY: config.OPENAI_API_KEY,
      JUNO_MODEL: config.OPENAI_CODEX_MODEL,
      JUNO_EFFORT: config.OPENAI_CODEX_MODEL_EFFORT,
    },
    timeout + 30,
  );
  let finished = false;
  const completion = command.finally(() => {
    finished = true;
    ack?.resolve("finished");
  });
  void completion.catch(() => {});
  const deadline = setTimeout(() => {
    if (!socket) {
      waiting.delete(key);
      disconnected();
    }
  }, 15000);
  try {
    if (!endpoint) disconnected();
    while (!finished && !lost && !stopping) {
      if (socket && (turn || idle)) {
        const messages = (await tasks.messages(id)).filter((m) => m.role === "user");
        const next = messages.find((m) => BigInt(m.id) > BigInt(lastUser));
        if (next) {
          let error: string | undefined;
          if (question) {
            const q = question.remaining.shift();
            if (q) question.answers[q.id] = { answers: [next.body] };
            if (question.remaining[0]) show(question.remaining[0]);
            else {
              error = await request({
                op: "respond",
                requestId: question.requestId,
                result: { answers: question.answers },
              });
              question = undefined;
            }
          } else {
            error = await request(
              turn
                ? { op: "steer", turnId: turn, text: next.body }
                : { op: "send", text: next.body },
            );
          }
          if (!error) lastUser = next.id;
          else if (error !== "turn is not active" && error !== "busy") socket.terminate();
        } else if (idle && (await tasks.closeMessages(id, messages.length))) {
          stopping = true;
          if (await request({ op: "prepare_shutdown" })) socket.terminate();
        }
      }
      if (!stopping) await Promise.race([completion, delay(350)]);
    }
    const result = await completion;
    await stored;
    return result;
  } finally {
    clearTimeout(deadline);
    waiting.delete(key);
    stopping = true;
    socket?.terminate();
  }
}
