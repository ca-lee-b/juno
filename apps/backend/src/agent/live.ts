import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkerConfig } from "@/config";
import type { Sandbox } from "@/sandbox/contracts";
import type { TaskRepository } from "@/tasks/repository";

export async function runLive(
  sandbox: Pick<Sandbox, "executeCommand" | "uploadFile" | "downloadFile">,
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
    await readFile(new URL("./session-driver.mjs", import.meta.url)),
    `${dir}/session-driver.mjs`,
  );
  const seconds = Math.ceil(config.AGENT_TIMEOUT_MS / 1000);
  const command = sandbox.executeCommand(
    `timeout --kill-after=10s ${seconds}s node ${dir}/session-driver.mjs 2> ${dir}/stderr.txt`,
    "/tmp/repository",
    {
      CODEX_API_KEY: config.OPENAI_API_KEY,
      JUNO_LAST_USER: lastUser,
      JUNO_MODEL: config.OPENAI_CODEX_MODEL,
      JUNO_EFFORT: config.OPENAI_CODEX_MODEL_EFFORT,
    },
    seconds + 30,
  );
  let finished = false;
  const completion = command.finally(() => {
    finished = true;
  });
  void completion.catch(() => {});
  let saved = 0;
  let closed = false;
  let previous = "";
  while (!finished) {
    const messages = (await tasks.messages(id)).filter((m) => m.role === "user");
    const inbox = JSON.stringify({ messages, closed });
    if (inbox !== previous) {
      await sandbox.uploadFile(Buffer.from(inbox), `${dir}/inbox.json`);
      previous = inbox;
    }
    const file = await sandbox.executeCommand(
      `if test -f ${dir}/state.json; then cat ${dir}/state.json; fi`,
      "/tmp",
      undefined,
      15,
    );
    if (file.exitCode !== 0) throw new Error("Session unavailable");
    if (file.result.trim()) {
      const state = JSON.parse(file.result) as {
        replies: string[];
        idle: boolean;
        delivered: string;
      };
      for (const body of state.replies.slice(saved)) {
        await tasks.message(id, "assistant", body);
        saved++;
      }
      if (state.idle && !closed && (messages.at(-1)?.id ?? "0") === state.delivered)
        closed = await tasks.closeMessages(id, messages.length);
    }
    await Promise.race([completion, delay(500)]);
  }
  return completion;
}
