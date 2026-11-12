import { Freestyle } from "freestyle";
import type { WorkerConfig } from "@/config";
import { ExecutionError } from "@/execution/contracts";
import type { Sandbox, SandboxProvider } from "@/sandbox/contracts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function createFreestyleProvider(
  config: Pick<WorkerConfig, "FREESTYLE_API_KEY">,
): SandboxProvider {
  const freestyle = new Freestyle({ apiKey: config.FREESTYLE_API_KEY });
  return async (taskId) => {
    const { vm, vmId } = await freestyle.vms.create({
      snapshotId: "freestyle/ubuntu-sm",
      ttlSeconds: 1800,
      autoDeleteSeconds: 0,
      metadata: { project: "byo-pr-agent", taskId },
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    });
    const executeCommand: Sandbox["executeCommand"] = async (command, cwd, env, timeoutSeconds) => {
      const result = await vm.exec({
        command: `cd ${quote(cwd)} && sh -c ${quote(command)}`,
        ...(env ? { env } : {}),
        // Current Ubuntu snapshots support native-agent execs beyond five minutes.
        timeoutMs: timeoutSeconds * 1000,
      });
      if (result.statusCode == null) throw new Error("Freestyle command timed out");
      return { exitCode: result.statusCode, result: result.stdout ?? "" };
    };
    let disposed = false;
    return {
      id: vmId,
      executeCommand,
      uploadFile: (data, path) => vm.fs.writeFile(path, data),
      downloadFile: async (path) => Buffer.from(await vm.fs.readFile(path)),
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
          await vm.delete();
          disposed = true;
        }
      },
    };
  };
}
