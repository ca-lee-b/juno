import { INSTRUCTIONS, PROMPT_VERSION } from "@/agent/prompt";
import { writeup } from "@/agent/writeup";
import type { WorkerConfig } from "@/config";
import { type Execute, ExecutionError, MAX_PATCH_BYTES } from "@/execution/contracts";

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
    const output = await sandbox.execute(
      INSTRUCTIONS +
        JSON.stringify(issue) +
        (issue.instruction
          ? "\nContinue from the current checkout. Apply this follow-up request:\n" +
            issue.instruction
          : ""),
      issue.sha,
    );
    if (!output.summary.trim()) throw new ExecutionError("OUTPUT_FAILED");
    if (Buffer.byteLength(output.patch) > MAX_PATCH_BYTES)
      throw new ExecutionError("PATCH_TOO_LARGE");
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
      usage: output.usage,
    };
  };
}
