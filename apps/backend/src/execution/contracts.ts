import type { TaskInput } from "@/tasks/input";

export type IssueContext = TaskInput & {
  title: string;
  body: string;
  sha: string;
  branch: string;
  private?: boolean;
};

export type ExecutionFailureCode =
  | "SETUP_FAILED"
  | "EXECUTION_FAILED"
  | "EXECUTION_TIMEOUT"
  | "OUTPUT_FAILED"
  | "PATCH_TOO_LARGE";
export class ExecutionError extends Error {
  constructor(
    readonly code: ExecutionFailureCode,
    readonly exitCode?: number,
  ) {
    super(code);
  }
}
export const MAX_PATCH_BYTES = 5 * 1024 * 1024;
export type TokenUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
export type ExecutionResult = {
  result: { summary: string; patch: string; prDescription: string; prTitle: string };
  model: string;
  promptVersion: string;
  usage: TokenUsage | null;
};
export type SandboxOutput = { summary: string; patch: string; events: string };
export interface RepositorySandbox {
  id: string;
  clone(issue: IssueContext): Promise<void>;
  execute(prompt: string, sha: string): Promise<SandboxOutput>;
  dispose(): Promise<void>;
}
export type Execute = (issue: IssueContext, sandbox: RepositorySandbox) => Promise<ExecutionResult>;
