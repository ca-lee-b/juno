import { Daytona } from "@daytona/sdk";
import { runCodex } from "@/agent/runtime";
import type { WorkerConfig } from "@/config";
import { ExecutionError, type RepositorySandbox } from "@/execution/contracts";
import { repositoryBundle } from "@/github/bundle";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function createSandboxProvider(config: WorkerConfig) {
  const daytona = new Daytona({
    apiKey: config.DAYTONA_API_KEY,
    apiUrl: config.DAYTONA_API_URL,
    requestTimeoutMs: 30000,
  });
  return async (taskId: string): Promise<RepositorySandbox> => {
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
    const dispose = async () => {
      if (!disposed) {
        await daytona.delete(sandbox, 30, true);
        disposed = true;
      }
    };
    return {
      id: sandbox.id,
      async clone(issue) {
        if (issue.private) {
          if (!config.GITHUB_TOKEN) throw new ExecutionError("SETUP_FAILED");
          const bundle = await repositoryBundle(issue, config.GITHUB_TOKEN);
          await sandbox.fs.uploadFile(bundle, "/tmp/source.bundle");
          const cloned = await sandbox.process.executeCommand(
            `git clone /tmp/source.bundle /tmp/repository && git -C /tmp/repository checkout --detach ${quote(issue.sha)} && git -C /tmp/repository remote set-url origin ${quote(`https://github.com/${issue.owner}/${issue.repo}.git`)} && rm /tmp/source.bundle`,
            "/tmp",
            undefined,
            120,
          );
          if (cloned.exitCode !== 0) throw new ExecutionError("SETUP_FAILED");
          return;
        }
        await sandbox.git.clone(
          `https://github.com/${issue.owner}/${issue.repo}.git`,
          "/tmp/repository",
          undefined,
          issue.sha,
          undefined,
          undefined,
          false,
          1,
        );
      },
      execute: (prompt, sha) => runCodex(sandbox, config, prompt, sha, dispose),
      dispose,
    };
  };
}
