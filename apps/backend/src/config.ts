import { z } from "zod";

const shared = z.object({
  GITHUB_TOKEN: z.string().optional(),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

const api = shared.extend({
  API_TOKEN: z.string().min(32),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

const effort = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

const worker = shared.extend({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_CODEX_MODEL: z.string().trim().min(1).default("gpt-6-astra"),
  OPENAI_CODEX_MODEL_EFFORT: effort.default("medium"),
  OPENAI_WRITEUP_MODEL: z.string().trim().min(1).default("gpt-6-luna"),
  OPENAI_WRITEUP_MODEL_EFFORT: effort.default("high"),
  SANDBOX_PROVIDER: z.enum(["daytona", "freestyle", "e2b"]).default("daytona"),
  DAYTONA_API_KEY: z.string().default(""),
  E2B_API_KEY: z.string().default(""),
  FREESTYLE_API_KEY: z.string().default(""),
  DAYTONA_API_URL: z.url().default("https://app.daytona.io/api"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(600000),
});

const validatedWorker = worker.superRefine((config, ctx) => {
  const key = {
    daytona: "DAYTONA_API_KEY",
    freestyle: "FREESTYLE_API_KEY",
    e2b: "E2B_API_KEY",
  } as const;
  const selectedKey = key[config.SANDBOX_PROVIDER];
  if (!config[selectedKey]?.trim())
    ctx.addIssue({
      code: "custom",
      path: [selectedKey],
      message: "Required for selected sandbox provider",
    });
});

export const readApiConfig = (env: NodeJS.ProcessEnv = process.env) => api.parse(env);
export const readWorkerConfig = (env: NodeJS.ProcessEnv = process.env) =>
  validatedWorker.parse(env);
export type WorkerConfig = z.infer<typeof worker>;
