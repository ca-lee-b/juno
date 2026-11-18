import { ExecutionError } from "@/execution/contracts";
import type { Sandbox } from "@/sandbox/contracts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function checkoutCommit(executeCommand: Sandbox["executeCommand"]): Sandbox["clone"] {
  return async (url, path, sha) => {
    const git = `git -C ${quote(path)}`;
    const fetch = `${git} fetch --depth=1 origin ${quote(sha)}`;
    const result = await executeCommand(
      `git init ${quote(path)} && ${git} remote add origin ${quote(url)} && ${fetch} && ${git} checkout --detach FETCH_HEAD`,
      "/tmp",
      undefined,
      120,
    );
    if (result.exitCode !== 0) throw new ExecutionError("SETUP_FAILED", result.exitCode);
  };
}
