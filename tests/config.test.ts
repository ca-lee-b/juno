import { expect, it } from "vitest";
import { readWorkerConfig } from "@/config";

const env = {
  DATABASE_URL: "postgres://localhost/db",
  REDIS_URL: "redis://localhost",
  OPENAI_API_KEY: "test",
  DAYTONA_API_KEY: "test",
};
it("defaults and independently overrides model and effort settings", () => {
  expect(readWorkerConfig(env)).toMatchObject({
    OPENAI_CODEX_MODEL: "gpt-6-astra",
    OPENAI_CODEX_MODEL_EFFORT: "medium",
    OPENAI_WRITEUP_MODEL: "gpt-6-luna",
    OPENAI_WRITEUP_MODEL_EFFORT: "high",
  });
  const overrides = {
    OPENAI_CODEX_MODEL: "coding",
    OPENAI_CODEX_MODEL_EFFORT: "high",
    OPENAI_WRITEUP_MODEL: "writing",
    OPENAI_WRITEUP_MODEL_EFFORT: "low",
  };
  expect(readWorkerConfig({ ...env, ...overrides })).toMatchObject(overrides);
});
it.each(["OPENAI_CODEX_MODEL_EFFORT", "OPENAI_WRITEUP_MODEL_EFFORT"])(
  "rejects invalid %s",
  (key) => {
    expect(() => readWorkerConfig({ ...env, [key]: "invalid" })).toThrow();
  },
);
