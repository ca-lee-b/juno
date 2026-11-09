import { describe, expect, it, vi } from "vitest";
import { createExecutor, parseUsage } from "@/agent/executor";
import { readWorkerConfig } from "@/config";
import type { IssueContext } from "@/execution/contracts";
import { MAX_PATCH_BYTES } from "@/execution/contracts";

const config = readWorkerConfig({
  DATABASE_URL: "postgres://localhost/db",
  REDIS_URL: "redis://localhost",
  OPENAI_API_KEY: "secret",
  DAYTONA_API_KEY: "secret",
  OPENAI_MODEL: "test",
});
const issue: IssueContext = {
  owner: "octocat",
  repo: "hello-world",
  issueNumber: 1,
  title: "Fix the greeting",
  body: "Return the configured greeting.",
  sha: "a".repeat(40),
  branch: "main",
};
describe("Codex output", () => {
  it("reads usage and rejects malformed events", () => {
    expect(
      parseUsage('{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":2}}'),
    ).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(() => parseUsage("bad json")).toThrow("OUTPUT_FAILED");
  });
  it.each(["", "patch"])("captures output, including empty patches (%s)", async (patch) => {
    const sandbox = {
      id: "s",
      clone: vi.fn(),
      dispose: vi.fn(),
      execute: vi.fn().mockResolvedValue({
        summary: JSON.stringify({
          summary: "Done",
          prTitle: "fix: address the issue",
          prDescription: "Reviewer description",
        }),
        patch,
        events: "",
      }),
    };
    const result = await createExecutor(config)(issue, sandbox);
    expect(result.result).toEqual({
      summary: expect.stringContaining("Done"),
      prTitle: "fix: address the issue",
      prDescription: "Reviewer description",
      patch,
    });
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.stringContaining(JSON.stringify(issue)),
      issue.sha,
    );
  });
  it.each([
    { summary: "", patch: "", code: "OUTPUT_FAILED" },
    { summary: "done", patch: "x".repeat(MAX_PATCH_BYTES + 1), code: "PATCH_TOO_LARGE" },
  ])("rejects $code", async ({ summary, patch, code }) => {
    const sandbox = {
      id: "s",
      clone: vi.fn(),
      dispose: vi.fn(),
      execute: vi.fn().mockResolvedValue({ summary, patch, events: "" }),
    };
    await expect(createExecutor(config)(issue, sandbox)).rejects.toThrow(code);
  });
});

it("accumulates multiple turns and rejects invalid cache counts", () => {
  const event = JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
  });
  expect(parseUsage([event, event].join("\n"))).toEqual({
    inputTokens: 20,
    cachedInputTokens: 4,
    outputTokens: 6,
  });
  expect(() =>
    parseUsage(event.replace('"cached_input_tokens":2', '"cached_input_tokens":20')),
  ).toThrow();
});

it.each(["not conventional", "fix: first\nsecond"])(
  "rejects invalid structured output %#",
  async (prTitle) => {
    const sandbox = {
      id: "s",
      clone: vi.fn(),
      dispose: vi.fn(),
      execute: vi.fn().mockResolvedValue({
        summary: JSON.stringify({
          summary: "Done",
          prTitle,
          prDescription: "Changes",
        }),
        patch: "",
        events: "",
      }),
    };
    await expect(createExecutor(config)(issue, sandbox)).rejects.toThrow("OUTPUT_FAILED");
  },
);
