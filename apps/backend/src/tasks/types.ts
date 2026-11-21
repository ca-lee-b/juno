import type { ExecutionResult, TokenUsage } from "@/execution/contracts";
import type { TaskInput } from "@/tasks/input";

export type TaskStatus = "queued" | "running" | "completed" | "failed";
export type Publication = {
  status: "in_progress" | "published" | "failed";
  branch: string;
  baseBranch: string;
  commitSha: string | null;
  branchUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  error: string | null;
};
export type Task = {
  settleRequested?: boolean;
  waitingForMessage?: boolean;
  issueTitle?: string | null;
  sessionId?: string | null;
  instruction?: string | null;
  id: string;
  input: TaskInput;
  status: TaskStatus;
  attempts: number;
  sandboxId: string | null;
  sourceSha: string | null;
  sourceBranch: string | null;
  publication: Publication | null;
  result: ExecutionResult["result"] | null;
  model: string | null;
  promptVersion: string | null;
  usage: TokenUsage | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class IdempotencyConflict extends Error {}
