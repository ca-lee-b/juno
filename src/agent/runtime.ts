import type { WorkerConfig } from "@/config";
import { ExecutionError, MAX_PATCH_BYTES, type SandboxOutput } from "@/execution/contracts";
import { patchCommand } from "@/sandbox/patch";

interface CodexTransport {
  process: {
    executeCommand(
      command: string,
      cwd: string,
      env: Record<string, string> | undefined,
      timeout: number,
    ): Promise<{ exitCode?: number; result: string }>;
  };
  fs: {
    uploadFile(data: Buffer, path: string): Promise<unknown>;
    downloadFile(path: string): Promise<Buffer | undefined>;
  };
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const OUTPUT_DIRECTORY = "/tmp/agent-output";
const artifacts = {
  prompt: `${OUTPUT_DIRECTORY}/prompt.txt`,
  summary: `${OUTPUT_DIRECTORY}/summary.txt`,
  patch: `${OUTPUT_DIRECTORY}/changes.patch`,
  events: `${OUTPUT_DIRECTORY}/events.jsonl`,
  stderr: `${OUTPUT_DIRECTORY}/stderr.txt`,
  script: `${OUTPUT_DIRECTORY}/patch.sh`,
};
export async function runCodex(
  sandbox: CodexTransport,
  config: Pick<
    WorkerConfig,
    "OPENAI_CODEX_MODEL" | "OPENAI_CODEX_MODEL_EFFORT" | "OPENAI_API_KEY" | "AGENT_TIMEOUT_MS"
  >,
  prompt: string,
  sha: string,
  dispose: () => Promise<void>,
): Promise<SandboxOutput> {
  const setup = await sandbox.process.executeCommand(
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
    const installed = await sandbox.process.executeCommand(
      `npx --yes skills@1.8.1 add ${quote(source)} --skill ${quote(skill)} --agent codex --global --yes`,
      "/tmp",
      { DISABLE_TELEMETRY: "1" },
      120,
    );
    if (installed.exitCode !== 0) throw new ExecutionError("SETUP_FAILED", installed.exitCode);
  }
  await sandbox.fs.uploadFile(Buffer.from(prompt), artifacts.prompt);
  let run: Awaited<ReturnType<typeof sandbox.process.executeCommand>>;
  try {
    run = await sandbox.process.executeCommand(
      `timeout --kill-after=10s ${Math.ceil(config.AGENT_TIMEOUT_MS / 1000)}s /tmp/codex-runtime/node_modules/.bin/codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral --json --model ${quote(config.OPENAI_CODEX_MODEL)} -c ${quote(`model_reasoning_effort="${config.OPENAI_CODEX_MODEL_EFFORT}"`)} --output-last-message ${artifacts.summary} - < ${artifacts.prompt} > ${artifacts.events} 2> ${artifacts.stderr}`,
      "/tmp/repository",
      { CODEX_API_KEY: config.OPENAI_API_KEY },
      Math.ceil(config.AGENT_TIMEOUT_MS / 1000) + 30,
    );
  } catch {
    // A transport timeout does not prove the process stopped. Destroy its environment first.
    await dispose();
    throw new ExecutionError("EXECUTION_TIMEOUT");
  }
  if (run.exitCode !== 0) {
    if (run.exitCode === 124 || run.exitCode === 137) {
      await dispose();
      throw new ExecutionError("EXECUTION_TIMEOUT", run.exitCode);
    }
    throw new ExecutionError("EXECUTION_FAILED", run.exitCode);
  }
  try {
    await sandbox.fs.uploadFile(Buffer.from(patchCommand(sha, artifacts.patch)), artifacts.script);
    const collected = await sandbox.process.executeCommand(
      `sh ${artifacts.script} && wc -c < ${artifacts.patch}`,
      "/tmp/repository",
      undefined,
      30,
    );
    if (collected.exitCode !== 0) throw new ExecutionError("OUTPUT_FAILED", collected.exitCode);
    const size = Number(collected.result.trim());
    if (!Number.isFinite(size)) throw new ExecutionError("OUTPUT_FAILED");
    if (size > MAX_PATCH_BYTES) throw new ExecutionError("PATCH_TOO_LARGE");
    const [summary, patch, events] = await Promise.all(
      [artifacts.summary, artifacts.patch, artifacts.events].map((file) =>
        sandbox.fs.downloadFile(file),
      ),
    );
    if (!summary || !patch || !events) throw new ExecutionError("OUTPUT_FAILED");
    return {
      summary: summary.toString(),
      patch: patch.toString(),
      events: events.toString(),
    };
  } catch (error) {
    throw error instanceof ExecutionError ? error : new ExecutionError("OUTPUT_FAILED");
  }
}
