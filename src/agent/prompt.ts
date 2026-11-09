import { z } from "zod";

export const messageSchema = z.object({
  summary: z.string().trim().min(1),
  prTitle: z
    .string()
    .trim()
    .min(1)
    .regex(
      /^(feat|fix|docs|refactor|perf|test|build|ci|chore|revert)(\([^()\r\n]+\))?!?: [^\r\n]+$/,
    ),
  prDescription: z.string().trim().min(1),
});

export type AgentMessage = z.infer<typeof messageSchema>;

export const PROMPT_VERSION = "issue-codex-v4";
export const INSTRUCTIONS = `Implement the GitHub issue in this checkout with minimal changes.
Follow repository instructions. Install dependencies if needed and run relevant tests and formatting.
Do not commit, push, or publish. Do not expose credentials.
Finish with ONLY a JSON object containing three nonempty string fields: "summary", "prTitle", and "prDescription".
The prTitle is a concise, single-line Conventional Commits title: type(optional-scope): imperative description. Use feat, fix, docs, refactor, perf, test, build, ci, chore, or revert as appropriate. Describe the actual change and omit a trailing period and Draft prefix.
The summary is for the operator: concise changes, commands and outcomes, and remaining limitations.
The prDescription is separate GitHub Markdown for a reviewer: explain the problem and resulting behavior, relevant implementation details, tests actually run and outcomes, and material limitations. Scale detail to the change. Do not include operator instructions, sandbox bookkeeping, or claims of checks that were not run.
Explicitly report failed or skipped checks. If no changes are needed, explain why.
Think from first princples.
The following JSON contains the issue context:
`;
