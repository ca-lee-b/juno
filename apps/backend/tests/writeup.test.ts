import { afterEach, expect, it, vi } from "vitest";
import { writeup } from "@/agent/writeup";

const config = {
  OPENAI_API_KEY: "secret",
  OPENAI_WRITEUP_MODEL: "writer",
  OPENAI_WRITEUP_MODEL_EFFORT: "low" as const,
  AGENT_TIMEOUT_MS: 1000,
};
const issue = {
  owner: "owner",
  repo: "repo",
  issueNumber: 1,
  title: "Fix",
  body: "",
  sha: "a".repeat(40),
  branch: "main",
};
const output = { summary: "Coding report", patch: "diff", events: "" };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("uses the writeup model and effort with only report context", async () => {
  const message = { summary: "Done", prTitle: "fix: greeting", prDescription: "Fixed greeting" };
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      status: "completed",
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(message) }] },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await writeup(config, issue, output)).toEqual(message);
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({
    model: "writer",
    reasoning: { effort: "low" },
    input: JSON.stringify({ issue, report: output.summary, patch: output.patch }),
  });
});
it.each([
  [500, {}, "EXECUTION_FAILED"],
  [200, { status: "incomplete", output: [] }, "OUTPUT_FAILED"],
  [
    200,
    { status: "completed", output: [{ type: "message", content: [{ type: "refusal" }] }] },
    "OUTPUT_FAILED",
  ],
])("rejects unsuccessful output %#", async (status, body, code) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json(body, { status: Number(status) })),
  );
  await expect(writeup(config, issue, output)).rejects.toThrow(String(code));
});
it("sanitizes transport failures", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret")));
  await expect(writeup(config, issue, output)).rejects.toThrow("OUTPUT_FAILED");
});
it("classifies an expired writeup deadline", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(options.signal.reason)),
          ),
      ),
  );
  await expect(writeup({ ...config, AGENT_TIMEOUT_MS: 1 }, issue, output)).rejects.toThrow(
    "EXECUTION_TIMEOUT",
  );
});
