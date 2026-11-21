import { INSTRUCTIONS, PROMPT_VERSION } from "@/agent/prompt";
import type { WorkerConfig } from "@/config";
import type { Execute } from "@/execution/contracts";

export function createExecutor(config: Pick<WorkerConfig, "OPENAI_CODEX_MODEL">): Execute {
  return async (issue, sandbox) => {
    const { summary, usage } = await sandbox.execute(INSTRUCTIONS + JSON.stringify(issue));
    return {
      result: { summary, patch: "" },
      model: config.OPENAI_CODEX_MODEL,
      promptVersion: PROMPT_VERSION,
      usage,
    };
  };
}
