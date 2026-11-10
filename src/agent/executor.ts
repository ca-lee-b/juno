import { INSTRUCTIONS, PROMPT_VERSION } from "@/agent/prompt";
import { writeup } from "@/agent/writeup";
import type { WorkerConfig } from "@/config";
import {
  type Execute,
  ExecutionError,
  MAX_PATCH_BYTES,
  type TokenUsage,
} from "@/execution/contracts";

export function parseUsage(events: string) {
  let usage: TokenUsage | null = null;
  try {
    for (const line of events.split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === "thread.failed" || event.type === "turn.failed" || event.type === "error")
        throw new Error();
      if (event.type === "turn.completed" && event.usage) {
        const { input_tokens: inputTokens, output_tokens: outputTokens } = event.usage;
        if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens))
          throw new Error();
        const cachedInputTokens = event.usage.cached_input_tokens ?? 0;
        if (
          inputTokens < 0 ||
          outputTokens < 0 ||
          !Number.isSafeInteger(cachedInputTokens) ||
          cachedInputTokens < 0 ||
          cachedInputTokens > inputTokens
        )
          throw new Error();
        const previous = usage as TokenUsage | null;
        usage = {
          inputTokens: (previous?.inputTokens ?? 0) + inputTokens,
          outputTokens: (previous?.outputTokens ?? 0) + outputTokens,
          ...(event.usage.cached_input_tokens !== undefined ||
          previous?.cachedInputTokens !== undefined
            ? { cachedInputTokens: (previous?.cachedInputTokens ?? 0) + cachedInputTokens }
            : {}),
        };
      }
    }
  } catch {
    throw new ExecutionError("OUTPUT_FAILED");
  }
  return usage;
}
export function createExecutor(
  config: Pick<
    WorkerConfig,
    | "OPENAI_CODEX_MODEL"
    | "OPENAI_WRITEUP_MODEL"
    | "OPENAI_WRITEUP_MODEL_EFFORT"
    | "OPENAI_API_KEY"
    | "AGENT_TIMEOUT_MS"
  >,
): Execute {
  return async (issue, sandbox) => {
    const output = await sandbox.execute(INSTRUCTIONS + JSON.stringify(issue), issue.sha);
    if (!output.summary.trim()) throw new ExecutionError("OUTPUT_FAILED");
    if (Buffer.byteLength(output.patch) > MAX_PATCH_BYTES)
      throw new ExecutionError("PATCH_TOO_LARGE");
    const usage = parseUsage(output.events);
    const message = await writeup(config, issue, output);
    return {
      result: {
        prDescription: message.prDescription,
        prTitle: message.prTitle,
        summary: message.summary + (output.patch ? "" : "\nNo file changes were produced."),
        patch: output.patch,
      },
      model: config.OPENAI_CODEX_MODEL,
      promptVersion: PROMPT_VERSION,
      usage,
    };
  };
}
