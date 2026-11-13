import { CommandExitError, Sandbox as E2BSandbox } from "e2b";
import type { WorkerConfig } from "@/config";
import { ExecutionError } from "@/execution/contracts";
import type { Sandbox, SandboxProvider } from "@/sandbox/contracts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function createE2BProvider(config: Pick<WorkerConfig, "E2B_API_KEY">): SandboxProvider {
  return async (taskId) => {
    const sandbox = await E2BSandbox.create({
      apiKey: config.E2B_API_KEY,
      timeoutMs: 1800000,
      metadata: { project: "byo-pr-agent", taskId },
      allowInternetAccess: true,
      network: { allowPublicTraffic: false },
    });
    try {
      // The base image ships Node 20, but the required skills CLI needs Node >=22.20.
      // Install globally so subsequent commands and their child processes use Node 24.
      await sandbox.commands.run(
        "npm install --prefix /tmp/e2b-node node@24.22.3 && cp /tmp/e2b-node/node_modules/node/bin/node /usr/local/bin/node",
        {
          user: "root",
          cwd: "/tmp",
          timeoutMs: 120000,
        },
      );
    } catch (error) {
      await sandbox.kill();
      throw error;
    }
    const executeCommand: Sandbox["executeCommand"] = async (command, cwd, env, timeoutSeconds) => {
      try {
        const result = await sandbox.commands.run(command, {
          cwd,
          ...(env ? { envs: env } : {}),
          timeoutMs: timeoutSeconds * 1000,
        });
        return { exitCode: result.exitCode, result: result.stdout };
      } catch (error) {
        // E2B rejects ordinary nonzero exits; our contract returns them to the runtime.
        if (error instanceof CommandExitError) {
          return { exitCode: error.exitCode, result: error.stdout };
        }
        throw error;
      }
    };
    let disposed = false;
    return {
      id: sandbox.sandboxId,
      executeCommand,
      uploadFile: (data, path) => sandbox.files.write(path, data),
      downloadFile: async (path) =>
        Buffer.from(await sandbox.files.read(path, { format: "bytes" })),
      async clone(url, path, sha) {
        const result = await executeCommand(
          `git init ${quote(path)} && git -C ${quote(path)} remote add origin ${quote(url)} && git -C ${quote(path)} fetch --depth=1 origin ${quote(sha)} && git -C ${quote(path)} checkout --detach FETCH_HEAD`,
          "/tmp",
          undefined,
          120,
        );
        if (result.exitCode !== 0) throw new ExecutionError("SETUP_FAILED", result.exitCode);
      },
      async dispose() {
        if (!disposed) {
          await sandbox.kill();
          disposed = true;
        }
      },
    };
  };
}
