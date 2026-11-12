import { Daytona } from "@daytona/sdk";
import type { WorkerConfig } from "@/config";
import type { SandboxProvider } from "@/sandbox/contracts";

export function createDaytonaProvider(
  config: Pick<WorkerConfig, "DAYTONA_API_KEY" | "DAYTONA_API_URL">,
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
        autoStopInterval: 30,
        ttlMinutes: 30,
        labels: { project: "byo-pr-agent", taskId },
      },
      { timeout: 60 },
    );
    let disposed = false;
    return {
      id: sandbox.id,
      executeCommand: (command, cwd, env, timeoutSeconds) =>
        sandbox.process.executeCommand(command, cwd, env, timeoutSeconds),
      uploadFile: (data, path) => sandbox.fs.uploadFile(data, path),
      downloadFile: (path) => sandbox.fs.downloadFile(path),
      clone: (url, path, sha) =>
        sandbox.git.clone(url, path, undefined, sha, undefined, undefined, false, 1),
      async dispose() {
        if (!disposed) {
          await daytona.delete(sandbox, 30, true);
          disposed = true;
        }
      },
    };
  };
}
