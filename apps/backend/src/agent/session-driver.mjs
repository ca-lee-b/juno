// Runs inside the provider sandbox. The worker exchanges snapshots through the
// provider's file API, keeping the Codex app server private to this process.
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const dir = "/tmp/agent-output";
const child = spawn("/tmp/codex-runtime/node_modules/.bin/codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
});
let serial = 0;
const pending = new Map();
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
function rpc(method, params) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ method, id, params });
  });
}
let active = null,
  question = null,
  usage = null,
  delivered = process.env.JUNO_LAST_USER ?? "0",
  summary = "";
const replies = [];
function snapshot() {
  writeFileSync(`${dir}/state.tmp`, JSON.stringify({ delivered, replies, idle: !active }));
  renameSync(`${dir}/state.tmp`, `${dir}/state.json`);
}
function say(text) {
  if (text) {
    replies.push(text);
    snapshot();
  }
}
function showQuestion(q) {
  say([q.question, ...(q.options ?? []).map((o) => `${o.label} — ${o.description}`)].join("\n"));
}
function fail() {
  process.exit(1);
}
child.on("exit", fail);
createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  const p = msg.params;
  if (!msg.method) {
    const call = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) call?.reject(new Error("Codex request failed"));
    else call?.resolve(msg.result);
  } else if (msg.method === "turn/started") {
    active = p.turn.id;
  } else if (msg.method === "turn/completed") {
    if (p.turn.status !== "completed") fail();
    active = null;
    snapshot();
  } else if (msg.method === "item/completed" && p.item.type === "agentMessage") {
    summary = p.item.text;
    say(summary);
  } else if (msg.method === "thread/tokenUsage/updated") {
    usage = p.tokenUsage.total;
  } else if (msg.method === "item/tool/requestUserInput") {
    question = { id: msg.id, questions: p.questions, answers: {} };
    showQuestion(question.questions[0]);
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: "Unsupported request" } });
  }
});
await rpc("initialize", {
  clientInfo: { name: "juno", version: "1" },
  capabilities: { experimentalApi: true },
});
send({ method: "initialized" });
await rpc("account/login/start", { type: "apiKey", apiKey: process.env.CODEX_API_KEY });
const { thread } = await rpc("thread/start", {
  model: process.env.JUNO_MODEL,
  cwd: process.cwd(),
  ephemeral: true,
  approvalPolicy: "never",
  sandbox: "danger-full-access",
  config: {
    model_reasoning_effort: process.env.JUNO_EFFORT,
    features: { default_mode_request_user_input: true },
  },
});
const threadId = thread.id;
async function start(text) {
  await rpc("turn/start", { threadId, input: [{ type: "text", text }] });
}
await start(readFileSync(`${dir}/prompt.txt`, "utf8"));
for (;;) {
  await delay(150);
  let inbox;
  try {
    inbox = JSON.parse(readFileSync(`${dir}/inbox.json`, "utf8"));
  } catch {
    continue;
  }
  for (const m of inbox.messages) {
    if (BigInt(m.id) <= BigInt(delivered)) continue;
    if (question) {
      const q = question.questions.shift();
      question.answers[q.id] = { answers: [m.body] };
      if (question.questions.length) showQuestion(question.questions[0]);
      else {
        send({ id: question.id, result: { answers: question.answers } });
        question = null;
      }
    } else if (active) {
      try {
        await rpc("turn/steer", {
          threadId,
          expectedTurnId: active,
          input: [{ type: "text", text: m.body }],
        });
      } catch (error) {
        if (active) throw error;
        await start(m.body);
      }
    } else {
      await start(m.body);
    }
    delivered = m.id;
    snapshot();
  }
  if (inbox.closed && !active && !question) break;
}
writeFileSync(`${dir}/summary.txt`, summary);
writeFileSync(
  `${dir}/events.jsonl`,
  usage
    ? JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: usage.inputTokens,
          cached_input_tokens: usage.cachedInputTokens,
          output_tokens: usage.outputTokens,
        },
      })
    : "",
);
child.removeListener("exit", fail);
child.kill();
