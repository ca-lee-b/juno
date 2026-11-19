import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutor } from "@/agent/executor";
import { readWorkerConfig } from "@/config";
import type { IssueContext } from "@/execution/contracts";
import { MAX_PATCH_BYTES } from "@/execution/contracts";

const config = readWorkerConfig({
  DATABASE_URL: "postgres://localhost/db",
  REDIS_URL: "redis://localhost",
  ENGINE_ENDPOINT: "wss://worker.example",
  OPENAI_API_KEY: "secret",
  DAYTONA_API_KEY: "secret",
  OPENAI_CODEX_MODEL: "test",
});
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () =>
    Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                summary: "Done",
                prTitle: "fix: address the issue",
                prDescription: "Reviewer description",
              }),
            },
          ],
        },
      ],
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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
        usage: { inputTokens: 8, cachedInputTokens: 2, outputTokens: 3 },
      }),
    };
    const result = await createExecutor(config)(issue, sandbox);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(request.body)).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "high" },
      store: false,
      input: JSON.stringify({
        issue,
        report: (await sandbox.execute.mock.results[0]?.value)?.summary,
        patch,
      }),
    });
    expect(result.usage).toEqual({ inputTokens: 8, cachedInputTokens: 2, outputTokens: 3 });
    expect(result.model).toBe("test");
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
      execute: vi.fn().mockResolvedValue({ summary, patch, usage: null }),
    };
    await expect(createExecutor(config)(issue, sandbox)).rejects.toThrow(code);
  });
});

it.each(["not conventional", "fix: first\nsecond"])(
  "rejects invalid structured output %#",
  async (prTitle) => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ summary: "Done", prTitle, prDescription: "Changes" }),
              },
            ],
          },
        ],
      }),
    );
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
        usage: null,
      }),
    };
    await expect(createExecutor(config)(issue, sandbox)).rejects.toThrow("OUTPUT_FAILED");
  },
);
