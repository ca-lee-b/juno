import { runCodex } from "@/agent/runtime";
import type { WorkerConfig } from "@/config";
import { ExecutionError, type RepositorySandbox } from "@/execution/contracts";
import { repositoryBundle } from "@/github/bundle";
import type { SandboxProvider } from "@/sandbox/contracts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
type RepositoryConfig = Pick<
  WorkerConfig,
  | "GITHUB_TOKEN"
  | "OPENAI_API_KEY"
  | "OPENAI_CODEX_MODEL"
  | "OPENAI_CODEX_MODEL_EFFORT"
  | "AGENT_TIMEOUT_MS"
>;

export function createRepositorySandboxProvider(
  config: RepositoryConfig,
  provider: SandboxProvider,
) {
  return async (taskId: string): Promise<RepositorySandbox> => {
    const sandbox = await provider(taskId);
    return {
      id: sandbox.id,
      async clone(issue) {
        if (issue.private) {
          if (!config.GITHUB_TOKEN) throw new ExecutionError("SETUP_FAILED");
          const bundle = await repositoryBundle(issue, config.GITHUB_TOKEN);
          await sandbox.uploadFile(bundle, "/tmp/source.bundle");
          const cloned = await sandbox.executeCommand(
            `git clone /tmp/source.bundle /tmp/repository && git -C /tmp/repository checkout --detach ${quote(issue.sha)} && git -C /tmp/repository remote set-url origin ${quote(`https://github.com/${issue.owner}/${issue.repo}.git`)} && rm /tmp/source.bundle`,
            "/tmp",
            undefined,
            120,
          );
          if (cloned.exitCode !== 0) throw new ExecutionError("SETUP_FAILED");
          return;
        }
        await sandbox.clone(
          `https://github.com/${issue.owner}/${issue.repo}.git`,
          "/tmp/repository",
          issue.sha,
        );
      },
      execute: (prompt, sha) => runCodex(sandbox, config, prompt, sha, () => sandbox.dispose()),
      dispose: () => sandbox.dispose(),
    };
  };
}
