import { Daytona } from "@daytona/sdk";
import type { WorkerConfig } from "@/config";
import { checkoutCommit } from "@/sandbox/checkout";
import type { Sandbox, SandboxProvider } from "@/sandbox/contracts";

export function createDaytonaProvider(
  config: Pick<WorkerConfig, "DAYTONA_API_KEY" | "DAYTONA_API_URL" | "DAYTONA_GITHUB_SECRET">,
): SandboxProvider {
  const daytona = new Daytona({
    apiKey: config.DAYTONA_API_KEY,
    apiUrl: config.DAYTONA_API_URL,
    requestTimeoutMs: 30000,
  });
  return async (taskId) => {
    const sandbox = await daytona.create(
      {
        language: "typescript",
        public: false,
        ephemeral: true,
        autoStopInterval: 0,
        ...(config.DAYTONA_GITHUB_SECRET
          ? { secrets: { GH_TOKEN: config.DAYTONA_GITHUB_SECRET } }
          : {}),
        ttlMinutes: 30,
        labels: { project: "byo-pr-agent", taskId },
      },
      { timeout: 60 },
    );
    const executeCommand: Sandbox["executeCommand"] = (command, cwd, env, timeoutSeconds) =>
      sandbox.process.executeCommand(command, cwd, env, timeoutSeconds);
    let disposed = false;
    return {
      id: sandbox.id,
      renew: () => sandbox.setTtl(30),
      executeCommand,
      uploadFile: (data, path) => sandbox.fs.uploadFile(data, path),
      downloadFile: (path) => sandbox.fs.downloadFile(path),
      clone: checkoutCommit(executeCommand),
      async dispose() {
        if (!disposed) {
          await daytona.delete(sandbox, 30, true);
          disposed = true;
        }
      },
    };
  };
}
