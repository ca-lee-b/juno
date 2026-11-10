import { z } from "zod";
import { messageSchema, WRITEUP_INSTRUCTIONS } from "@/agent/prompt";
import type { WorkerConfig } from "@/config";
import { ExecutionError, type IssueContext, type SandboxOutput } from "@/execution/contracts";

type WriteupConfig = Pick<
  WorkerConfig,
  "OPENAI_API_KEY" | "OPENAI_WRITEUP_MODEL" | "OPENAI_WRITEUP_MODEL_EFFORT" | "AGENT_TIMEOUT_MS"
>;
const responseSchema = z.object({
  status: z.literal("completed"),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
});

export async function writeup(config: WriteupConfig, issue: IssueContext, output: SandboxOutput) {
  const signal = AbortSignal.timeout(config.AGENT_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        model: config.OPENAI_WRITEUP_MODEL,
        reasoning: { effort: config.OPENAI_WRITEUP_MODEL_EFFORT },
        store: false,
        instructions: WRITEUP_INSTRUCTIONS,
        input: JSON.stringify({ issue, report: output.summary, patch: output.patch }),
        text: {
          format: {
            type: "json_schema",
            name: "pr_writeup",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                summary: { type: "string" },
                prTitle: { type: "string" },
                prDescription: { type: "string" },
              },
              required: ["summary", "prTitle", "prDescription"],
            },
          },
        },
      }),
    });
    if (!response.ok) throw new ExecutionError("EXECUTION_FAILED");
    const data = responseSchema.parse(await response.json());
    const text = data.output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text ?? "")
      .join("");
    return messageSchema.parse(JSON.parse(text));
  } catch (error) {
    if (signal.aborted) throw new ExecutionError("EXECUTION_TIMEOUT");
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("OUTPUT_FAILED");
  }
}
