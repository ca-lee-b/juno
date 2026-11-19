import { runCodex } from "@/agent/runtime";
import type { WorkerConfig } from "@/config";
import { ExecutionError, type RepositorySandbox } from "@/execution/contracts";
import { repositoryBundle } from "@/github/bundle";
import type { SandboxProvider } from "@/sandbox/contracts";
import type { TaskRepository } from "@/tasks/repository";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
type RepositoryConfig = Pick<
  WorkerConfig,
  | "GITHUB_TOKEN"
  | "OPENAI_API_KEY"
  | "OPENAI_CODEX_MODEL"
  | "OPENAI_CODEX_MODEL_EFFORT"
  | "AGENT_TIMEOUT_MS"
> & { SANDBOX_PROVIDER?: WorkerConfig["SANDBOX_PROVIDER"] };

export function createRepositorySandboxProvider(
  config: RepositoryConfig,
  provider: SandboxProvider,
  tasks?: TaskRepository,
) {
  return async (taskId: string): Promise<RepositorySandbox> => {
    const sandbox = await provider(taskId);
    return {
      id: sandbox.id,
      async clone(issue, patch) {
        // Fetch on the worker when available so Daytona checkout does not depend on sandbox DNS.
        if (issue.private || (config.SANDBOX_PROVIDER === "daytona" && config.GITHUB_TOKEN)) {
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
        } else
          await sandbox.clone(
            `https://github.com/${issue.owner}/${issue.repo}.git`,
            "/tmp/repository",
            issue.sha,
          );
        if (patch) {
          await sandbox.uploadFile(Buffer.from(patch), "/tmp/draft.patch");
          const applied = await sandbox.executeCommand(
            "git apply --binary /tmp/draft.patch",
            "/tmp/repository",
            undefined,
            30,
          );
          if (applied.exitCode !== 0) throw new ExecutionError("SETUP_FAILED", applied.exitCode);
        }
      },
      execute: (prompt, sha) =>
        runCodex(
          sandbox,
          config,
          prompt,
          sha,
          () => sandbox.dispose(),
          tasks ? { tasks, id: taskId } : undefined,
        ),
      dispose: () => sandbox.dispose(),
    };
  };
}
