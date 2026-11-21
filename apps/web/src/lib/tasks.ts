import { z } from "zod";

// Matches apps/backend/src/tasks/types.ts.
export const taskInputSchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .refine((value) => value !== "." && value !== ".."),
    issueNumber: z.number().int().positive(),
  })
  .strict();

export type TaskInput = z.infer<typeof taskInputSchema>;
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
  liveLost?: boolean;
  issueTitle?: string | null;
  sessionId?: string | null;
  instruction?: string | null;
  id: string;
  input: TaskInput;
  status: TaskStatus;
  attempts: number;
  sandboxId: string | null;
  sourceSha: string | null;
  publication: Publication | null;
  result: { summary: string; patch: string } | null;
  model: string | null;
  promptVersion: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  } | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export const isTaskActive = (status: TaskStatus) => status === "queued" || status === "running";

export type TaskListItem = Pick<Task, "id" | "input" | "status" | "createdAt"> & {
  changes: { additions: number; deletions: number } | null;
};
export type TaskListResponse = {
  tasks: TaskListItem[];
  counts: Partial<Record<TaskStatus, number>>;
  hasMore: boolean;
};
