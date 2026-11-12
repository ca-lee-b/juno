/** An isolated Linux environment with sh, git, Node/npm, and GNU timeout available.
 * Providers must enforce a bounded lifetime as a fallback if disposal fails.
 */
export interface Sandbox {
  id: string;
  /** Resolve on process exit (including nonzero); reject on transport failure. Timeout is in seconds. */
  executeCommand(
    command: string,
    cwd: string,
    env: Record<string, string> | undefined,
    timeoutSeconds: number,
  ): Promise<{ exitCode?: number; result: string }>;
  uploadFile(data: Buffer, path: string): Promise<unknown>;
  downloadFile(path: string): Promise<Buffer | undefined>;
  /** Clone a public repository at the exact commit into an absolute path. */
  clone(url: string, path: string, sha: string): Promise<void>;
  /** Destroy the environment, stopping running commands. Safe to retry after failure. */
  dispose(): Promise<void>;
}
export type SandboxProvider = (taskId: string) => Promise<Sandbox>;
