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

export type SessionTasks = Pick<TaskRepository, "inbox" | "reply" | "liveLost" | "waiting">;

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
    requestId?: number;
  };
};

export async function runLive(
  sandbox: Pick<Sandbox, "executeCommand" | "uploadFile" | "renew">,
  config: { SANDBOX_PROVIDER?: WorkerConfig["SANDBOX_PROVIDER"] } & Pick<
    WorkerConfig,
    | "GITHUB_TOKEN"
    | "DAYTONA_GITHUB_SECRET"
    | "ENGINE_ENDPOINT"
    | "OPENAI_API_KEY"
    | "OPENAI_CODEX_MODEL"
    | "OPENAI_CODEX_MODEL_EFFORT"
    | "AGENT_TIMEOUT_MS"
  >,
  tasks: SessionTasks,
  id: string,
  prompt: string,
  leaseStart: number,
) {
  const dir = "/tmp/agent-output";
  await sandbox.uploadFile(
    await readFile(new URL("../../bin/towline", import.meta.url)),
    `${dir}/towline`,
  );
  let lastUser = "0";
  let interruptDeadline = Infinity;
  let deadline = Date.now() + config.AGENT_TIMEOUT_MS;
  const codex = "/tmp/codex-runtime/node_modules/.bin/codex";
  const settings = [
    `model = ${JSON.stringify(config.OPENAI_CODEX_MODEL)}`,
    `model_reasoning_effort = ${JSON.stringify(config.OPENAI_CODEX_MODEL_EFFORT)}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "[shell_environment_policy]",
    "ignore_default_excludes = true",
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
  let answering: { requestId: number; messageId: string } | undefined;
  let ack: { id: string; resolve: (error?: string) => void } | undefined;
  let stored = Promise.resolve();
  const save = (operation: () => Promise<void>) => {
    stored = stored.then(operation);
    void stored.catch(() => {
      failed = true;
    });
  };
  const log = (body: string) => save(() => tasks.reply(id, body));
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
      const timer = setTimeout(() => socket?.terminate(), 15000);
      ack = {
        id,
        resolve: (error) => {
          clearTimeout(timer);
          resolve(error);
        },
      };
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
    save(() => tasks.liveLost(id));
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
          if (ready && lost) {
            lost = false;
            save(() => tasks.liveLost(id, false));
          }
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
          interruptDeadline = Infinity;
          turn = e.params.turn?.id;
          deadline = Date.now() + config.AGENT_TIMEOUT_MS;
          save(() => tasks.waiting(id, false));
        }
        if (
          e.method === "serverRequest/resolved" &&
          answering &&
          e.params.requestId === answering.requestId
        ) {
          lastUser = answering.messageId;
          if (question?.requestId === answering.requestId) question = undefined;
          answering = undefined;
        }
        if (e.method === "turn/completed") {
          if (answering) lastUser = answering.messageId;
          answering = undefined;
          turn = null;
          interruptDeadline = Infinity;
          deadline = Infinity;
          question = undefined;
          if (e.params.turn?.status !== "completed")
            log("This turn ended before completion. Send a message to continue.");
          save(() => tasks.waiting(id, true));
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
          deadline = Infinity;
          show(e.params.questions[0]);
        }
      } catch {
        ws.terminate();
      }
    });
  });
  try {
    const launched = await sandbox.executeCommand(
      `set -eu
      export PATH="/tmp/codex-runtime/node_modules/.bin:$PATH"
      chmod 700 ${dir}/towline
      mkdir -p "$HOME/.codex"
      cp ${dir}/codex.toml "$HOME/.codex/config.toml"
      printf '%s' "$CODEX_API_KEY" | ${codex} login --with-api-key >/dev/null 2>&1
      unset CODEX_API_KEY
      gh auth setup-git --hostname github.com
      git config user.name Juno
      git config user.email juno@users.noreply.github.com
      nohup ${dir}/towline -dir /tmp/repository -codex ${codex} </dev/null >/dev/null 2>&1 &
      echo $! > ${dir}/towline.pid`,
      "/tmp/repository",
      {
        TOWLINE_ENDPOINT: config.ENGINE_ENDPOINT,
        TOWLINE_TOKEN: token,
        CODEX_API_KEY: config.OPENAI_API_KEY,
        ...(config.SANDBOX_PROVIDER === "daytona" && config.DAYTONA_GITHUB_SECRET
          ? {}
          : { GH_TOKEN: config.GITHUB_TOKEN }),
      },
      60,
    );
    if (launched.exitCode !== 0) throw new ExecutionError("SETUP_FAILED", launched.exitCode);
    let lastRenewed = leaseStart;
    let nextRenewal = lastRenewed + 60000;
    while (!failed) {
      const next = await tasks.inbox(id, lastUser);
      if (next.settling) break;
      if (Date.now() >= nextRenewal) {
        try {
          if (!ready) {
            const alive = await sandbox.executeCommand(
              `kill -0 "$(cat ${dir}/towline.pid)"`,
              "/tmp",
              undefined,
              10,
            );
            if (alive.exitCode !== 0) throw new ExecutionError("EXECUTION_FAILED");
          }
          await sandbox.renew();
          lastRenewed = Date.now();
          nextRenewal = lastRenewed + 60000;
        } catch (error) {
          if (error instanceof ExecutionError || Date.now() - lastRenewed >= 29 * 60000)
            throw error;
          nextRenewal = Date.now() + 10000;
        }
      }
      if (Date.now() >= interruptDeadline) throw new ExecutionError("EXECUTION_TIMEOUT");
      if (Date.now() > deadline && interruptDeadline === Infinity) {
        if (!ready || !turn) throw new ExecutionError("EXECUTION_TIMEOUT");
        interruptDeadline = Date.now() + 15000;
        const interrupted = await request({ op: "interrupt", turnId: turn });
        if (interrupted && interrupted !== "turn is not active")
          throw new ExecutionError("EXECUTION_TIMEOUT");
      }
      if (ready && !started) {
        started = true;
        const error = await request({ op: "send", text: prompt });
        if (error === "disconnected") {
          log(
            "Initial request delivery is unconfirmed. If no reply appears after reconnection, send a message to continue.",
          );
          if (turn === undefined) deadline = Infinity;
        } else if (error) throw new ExecutionError("EXECUTION_FAILED");
      } else if (ready && next.id && next.body && BigInt(next.id) > BigInt(lastUser)) {
        let error: string | undefined;
        if (question) {
          const q = question.remaining.shift();
          if (q) question.answers[q.id] = { answers: [next.body] };
          if (question.remaining[0]) show(question.remaining[0]);
          else {
            const pending = question;
            answering = { requestId: pending.requestId, messageId: next.id };
            error = await request({
              op: "respond",
              requestId: question.requestId,
              result: { answers: question.answers },
            });
            // A request ID can only be answered once. Retry that same response
            // after reconnect, even if the first acknowledgement was lost.
            if (error === "disconnected") continue;
            if (error === "unknown request ID") error = undefined;
            if (question === pending) question = undefined;
            answering = undefined;
            if (turn && !question) deadline = Date.now() + config.AGENT_TIMEOUT_MS;
          }
        } else {
          error = await request(
            turn
              ? { op: "steer", turnId: turn, text: next.body }
              : { op: "send", text: turn === undefined ? `${prompt}\n${next.body}` : next.body },
          );
        }
        if (!error) lastUser = next.id;
        else if (error === "disconnected") {
          lastUser = next.id;
          log(
            "The connection dropped during message delivery. Check the reply before sending it again.",
          );
        } else if (!["turn is not active", "busy"].includes(error))
          throw new ExecutionError("EXECUTION_FAILED");
      }
      await delay(350);
    }
    if (failed) throw new ExecutionError("OUTPUT_FAILED");
    await stored;
    return { summary, usage };
  } finally {
    waiting.delete(key);
    stopping = true;
    socket?.terminate();
  }
}
