import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { WorkerConfig } from "@/config";
import { ExecutionError } from "@/execution/contracts";
import type { Sandbox } from "@/sandbox/contracts";
import type { TaskRepository } from "@/tasks/repository";

export type SessionTasks = Pick<
  TaskRepository,
  "messages" | "reply" | "liveLost" | "closeMessages"
>;

const tokens = z.number().int().nonnegative();
const usageSchema = z
  .object({ inputTokens: tokens, outputTokens: tokens, cachedInputTokens: tokens })
  .refine((u) => u.cachedInputTokens <= u.inputTokens);

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
  params: {
    turn?: { id: string; status: string };
    tokenUsage?: {
      total: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
    };
    item?: { type: string; text: string };
    questions?: Question[];
  };
};

export async function runLive(
  sandbox: Pick<Sandbox, "executeCommand" | "uploadFile">,
  config: Pick<
    WorkerConfig,
    | "ENGINE_ENDPOINT"
    | "OPENAI_API_KEY"
    | "OPENAI_CODEX_MODEL"
    | "OPENAI_CODEX_MODEL_EFFORT"
    | "AGENT_TIMEOUT_MS"
  >,
  tasks: SessionTasks,
  id: string,
  lastUser: string,
  prompt: string,
) {
  const dir = "/tmp/agent-output";
  await sandbox.uploadFile(
    await readFile(new URL("../../bin/towline", import.meta.url)),
    `${dir}/towline`,
  );
  const timeout = Math.ceil(config.AGENT_TIMEOUT_MS / 1000);
  const codex = "/tmp/codex-runtime/node_modules/.bin/codex";
  const settings = [
    `model = ${JSON.stringify(config.OPENAI_CODEX_MODEL)}`,
    `model_reasoning_effort = ${JSON.stringify(config.OPENAI_CODEX_MODEL_EFFORT)}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "[features]",
    "default_mode_request_user_input = true",
  ].join("\n");
  await sandbox.uploadFile(Buffer.from(settings), `${dir}/codex.toml`);
  const token = randomBytes(32).toString("hex");
  const key = `Bearer ${token}`;
  let socket: WebSocket | undefined;
  // Undefined until the first turn starts, null after a turn completes.
  let turn: string | null | undefined;
  let stopping = false;
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
  let started = false,
    ready = false,
    failed = false,
    sequence = 0;
  let summary = "";
  let usage: z.infer<typeof usageSchema> | null = null;
  const disconnected = () => {
    ready = false;
    socket = undefined;
    ack?.resolve("disconnected");
    ack = undefined;
    if (stopping || lost) return;
    lost = true;
    stored = stored.then(() => tasks.liveLost(id));
    void stored.catch(() => {});
  };
  waiting.set(key, (ws) => {
    if (socket) {
      ws.terminate();
      return;
    }
    socket = ws;
    ws.send(JSON.stringify({ id: "stream", op: "replay", from: sequence + 1 }));
    ws.on("error", () => ws.terminate());
    ws.on("close", disconnected);
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as {
          seq?: number;
          id?: string;
          error?: string;
          event?: Event;
        };
        if (frame.id === "stream") {
          ready = !frame.error;
          failed ||= !ready;
          return;
        }
        if (ack && frame.id === ack.id) {
          ack.resolve(frame.error);
          ack = undefined;
          return;
        }
        const e = frame.event;
        if (!ready || !e || frame.seq === undefined || frame.seq <= sequence) return;
        if (frame.seq !== sequence + 1) {
          ws.terminate();
          return;
        }
        sequence = frame.seq;
        if (e.method === "thread/tokenUsage/updated" && e.params.tokenUsage) {
          const parsed = usageSchema.safeParse(e.params.tokenUsage.total);
          if (parsed.success) usage = parsed.data;
          else failed = true;
        }
        if (e.method === "turn/started") {
          turn = e.params.turn?.id;
        }
        if (e.method === "turn/completed") {
          turn = null;
          failed ||= e.params.turn?.status !== "completed";
        }
        if (e.method === "item/completed" && e.params.item?.type === "agentMessage") {
          summary = e.params.item.text;
          log(summary);
        }
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
  const command = sandbox.executeCommand(
    `set -eu; chmod 700 ${dir}/towline; mkdir -p "$HOME/.codex"; cp ${dir}/codex.toml "$HOME/.codex/config.toml"; printf '%s' "$CODEX_API_KEY" | ${codex} login --with-api-key >/dev/null 2>&1; unset CODEX_API_KEY; exec timeout --kill-after=10s ${timeout}s ${dir}/towline -dir /tmp/repository -codex ${codex}`,
    "/tmp/repository",
    {
      TOWLINE_ENDPOINT: config.ENGINE_ENDPOINT,
      TOWLINE_TOKEN: token,
      CODEX_API_KEY: config.OPENAI_API_KEY,
    },
    timeout + 30,
  );
  let finished = false;
  const completion = command.finally(() => {
    finished = true;
    ack?.resolve("finished");
  });
  void completion.catch(() => {});
  try {
    while (!finished && !failed && !stopping) {
      if (ready && !started) {
        started = true;
        const error = await request({ op: "send", text: prompt });
        if (error && error !== "disconnected") throw new ExecutionError("EXECUTION_FAILED");
      }
      if (ready && turn !== undefined) {
        const messages = lost ? [] : (await tasks.messages(id)).filter((m) => m.role === "user");
        const next = messages.find((m) => BigInt(m.id) > BigInt(lastUser));
        if (lost && question) {
          await request({ op: "respond", requestId: question.requestId, result: { answers: {} } });
          question = undefined;
        } else if (next) {
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
          else if (!["turn is not active", "busy", "disconnected"].includes(error))
            throw new ExecutionError("EXECUTION_FAILED");
        } else if (turn === null && (lost || (await tasks.closeMessages(id, messages.length)))) {
          stopping = !(await request({ op: "prepare_shutdown" }));
        }
      }
      if (!stopping) await Promise.race([completion, delay(350)]);
    }
    if (finished) {
      const r = await completion;
      throw new ExecutionError(
        r.exitCode === 124 || r.exitCode === 137 ? "EXECUTION_TIMEOUT" : "EXECUTION_FAILED",
        r.exitCode,
      );
    }
    if (failed || !summary.trim()) throw new ExecutionError("OUTPUT_FAILED");
    await stored;
    return { summary, usage };
  } finally {
    waiting.delete(key);
    stopping = true;
    socket?.terminate();
  }
}
