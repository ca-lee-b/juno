import { runLive, type SessionTasks } from "@/agent/live";
import type { WorkerConfig } from "@/config";
import { ExecutionError, type SandboxOutput } from "@/execution/contracts";
import type { Sandbox } from "@/sandbox/contracts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const OUTPUT_DIRECTORY = "/tmp/agent-output";
export async function runCodex(
  sandbox: Pick<Sandbox, "executeCommand" | "uploadFile" | "renew">,
  config: { SANDBOX_PROVIDER?: WorkerConfig["SANDBOX_PROVIDER"] } & Pick<
    WorkerConfig,
    | "ENGINE_ENDPOINT"
    | "GITHUB_TOKEN"
    | "DAYTONA_GITHUB_SECRET"
    | "OPENAI_CODEX_MODEL"
    | "OPENAI_CODEX_MODEL_EFFORT"
    | "OPENAI_API_KEY"
    | "AGENT_TIMEOUT_MS"
  >,
  prompt: string,
  dispose: () => Promise<void>,
  live: {
    tasks: SessionTasks;
    id: string;
  },
): Promise<SandboxOutput> {
  const setup = await sandbox.executeCommand(
    `mkdir -p ${OUTPUT_DIRECTORY} && npm install --prefix /tmp/codex-runtime @openai/codex@0.166.0 &&
      curl -fsSL --retry 2 -o gh.tar.gz https://github.com/cli/cli/releases/download/v2.86.0/gh_2.86.0_linux_amd64.tar.gz &&
      echo 'f3b08bd6a28420cc2229b0a1a687fa25f2b838d3f04b297414c1041ca68103c7  gh.tar.gz' | sha256sum -c - &&
      tar -xzf gh.tar.gz --strip-components=2 -C /tmp/codex-runtime/node_modules/.bin gh_2.86.0_linux_amd64/bin/gh`,
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
  try {
    const output = await runLive(sandbox, config, live.tasks, live.id, prompt);
    return { ...output, patch: "" };
  } catch (error) {
    if (!(error instanceof ExecutionError) || error.code === "EXECUTION_TIMEOUT") await dispose();
    throw error instanceof ExecutionError ? error : new ExecutionError("EXECUTION_FAILED");
  }
}
