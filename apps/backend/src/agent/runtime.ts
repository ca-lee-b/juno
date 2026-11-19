import { runLive, type SessionTasks } from "@/agent/live";
import type { WorkerConfig } from "@/config";
import { ExecutionError, MAX_PATCH_BYTES, type SandboxOutput } from "@/execution/contracts";
import type { Sandbox } from "@/sandbox/contracts";
import { patchCommand } from "@/sandbox/patch";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const OUTPUT_DIRECTORY = "/tmp/agent-output";
const artifacts = {
  patch: `${OUTPUT_DIRECTORY}/changes.patch`,
  script: `${OUTPUT_DIRECTORY}/patch.sh`,
};
export async function runCodex(
  sandbox: Pick<Sandbox, "executeCommand" | "uploadFile" | "downloadFile">,
  config: Pick<
    WorkerConfig,
    | "ENGINE_ENDPOINT"
    | "OPENAI_CODEX_MODEL"
    | "OPENAI_CODEX_MODEL_EFFORT"
    | "OPENAI_API_KEY"
    | "AGENT_TIMEOUT_MS"
  >,
  prompt: string,
  sha: string,
  dispose: () => Promise<void>,
  live: {
    tasks: SessionTasks;
    id: string;
  },
): Promise<SandboxOutput> {
  const setup = await sandbox.executeCommand(
    `mkdir -p ${OUTPUT_DIRECTORY} && npm install --prefix /tmp/codex-runtime @openai/codex@0.166.0`,
    "/tmp",
    undefined,
    120,
  );
  if (setup.exitCode !== 0) throw new ExecutionError("SETUP_FAILED", setup.exitCode);
  // Global installs stay outside the repository and its generated patch.
  for (const [source, skill] of [
    [
      "https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d",
      "codebase-design",
    ],
    [
      "https://github.com/getsentry/skills/tree/e94f22214528d69899d09c627b3315ddc3544816",
      "code-simplifier",
    ],
  ] as const) {
    const installed = await sandbox.executeCommand(
      `npx --yes skills@1.8.1 add ${quote(source)} --skill ${quote(skill)} --agent codex --global --yes`,
      "/tmp",
      { DISABLE_TELEMETRY: "1" },
      120,
    );
    if (installed.exitCode !== 0) throw new ExecutionError("SETUP_FAILED", installed.exitCode);
  }
  const history = await live.tasks.messages(live.id);
  const lastUser = history.findLast((m) => m.role === "user")?.id ?? "0";
  if (history.length)
    prompt +=
      "\nInclude the operator’s messages already received for this run:\n" +
      JSON.stringify(history);
  let streamed: Omit<SandboxOutput, "patch">;
  try {
    streamed = await runLive(sandbox, config, live.tasks, live.id, lastUser, prompt);
  } catch (error) {
    if (!(error instanceof ExecutionError) || error.code === "EXECUTION_TIMEOUT") await dispose();
    throw error instanceof ExecutionError ? error : new ExecutionError("EXECUTION_TIMEOUT");
  }
  try {
    await sandbox.uploadFile(Buffer.from(patchCommand(sha, artifacts.patch)), artifacts.script);
    const collected = await sandbox.executeCommand(
      `sh ${artifacts.script} && wc -c < ${artifacts.patch}`,
      "/tmp/repository",
      undefined,
      30,
    );
    if (collected.exitCode !== 0) throw new ExecutionError("OUTPUT_FAILED", collected.exitCode);
    const size = Number(collected.result.trim());
    if (!Number.isFinite(size)) throw new ExecutionError("OUTPUT_FAILED");
    if (size > MAX_PATCH_BYTES) throw new ExecutionError("PATCH_TOO_LARGE");
    const patch = await sandbox.downloadFile(artifacts.patch);
    if (!patch) throw new ExecutionError("OUTPUT_FAILED");
    return { ...streamed, patch: patch.toString() };
  } catch (error) {
    throw error instanceof ExecutionError ? error : new ExecutionError("OUTPUT_FAILED");
  }
}
