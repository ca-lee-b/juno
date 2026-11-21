import type { TaskInput } from "@/tasks/input";

export type IssueContext = TaskInput & {
  sessionBranch?: string;
  history?: { role: string; body: string }[];
  instruction?: string;
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
  | "OUTPUT_FAILED";
export class ExecutionError extends Error {
  constructor(
    readonly code: ExecutionFailureCode,
    readonly exitCode?: number,
  ) {
    super(code);
  }
}
export type TokenUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
export type ExecutionResult = {
  result: { summary: string; patch: string; prDescription?: string; prTitle?: string };
  model: string;
  promptVersion: string;
  usage: TokenUsage | null;
};
export type SandboxOutput = { summary: string; patch: string; usage: TokenUsage | null };
export interface RepositorySandbox {
  id: string;
  clone(issue: IssueContext, patch?: string): Promise<void>;
  execute(prompt: string): Promise<SandboxOutput>;
  dispose(): Promise<void>;
}
export type Execute = (issue: IssueContext, sandbox: RepositorySandbox) => Promise<ExecutionResult>;
