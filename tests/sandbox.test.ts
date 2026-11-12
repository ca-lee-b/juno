import { expect, it, vi } from "vitest";
import type { IssueContext } from "@/execution/contracts";
import type { Sandbox, SandboxProvider } from "@/sandbox/contracts";
import { createRepositorySandboxProvider } from "@/sandbox/repository";

const config = {
  OPENAI_API_KEY: "openai-secret",
  OPENAI_CODEX_MODEL: "test",
  OPENAI_CODEX_MODEL_EFFORT: "medium" as const,
  AGENT_TIMEOUT_MS: 1000,
};
const issue: IssueContext = {
  owner: "owner",
  repo: "repo",
  issueNumber: 1,
  title: "issue",
  body: "",
  sha: "a".repeat(40),
  branch: "main",
};
function setup() {
  const environment = {
    id: "other-provider-id",
    clone: vi.fn<Sandbox["clone"]>().mockResolvedValue(undefined),
    executeCommand: vi
      .fn<Sandbox["executeCommand"]>()
      .mockResolvedValue({ exitCode: 0, result: "0" }),
    uploadFile: vi.fn<Sandbox["uploadFile"]>().mockResolvedValue(undefined),
    downloadFile: vi
      .fn<Sandbox["downloadFile"]>()
      .mockImplementation(async (path) => Buffer.from(path.endsWith("summary.txt") ? "done" : "")),
    dispose: vi.fn<Sandbox["dispose"]>().mockResolvedValue(undefined),
  } satisfies Sandbox;
  const provider = vi.fn<SandboxProvider>().mockResolvedValue(environment);
  return { environment, provider, create: createRepositorySandboxProvider(config, provider) };
}

it("runs repository setup, Codex, artifact collection and cleanup with an independent provider", async () => {
  const { environment, provider, create } = setup();
  const sandbox = await create("task-id");
  expect(provider).toHaveBeenCalledWith("task-id");
  expect(sandbox.id).toBe(environment.id);
  await sandbox.clone(issue);
  expect(environment.clone).toHaveBeenCalledWith(
    "https://github.com/owner/repo.git",
    "/tmp/repository",
    issue.sha,
  );
  expect(await sandbox.execute("fix issue", issue.sha)).toEqual({
    summary: "done",
    patch: "",
    events: "",
  });
  expect(environment.executeCommand).toHaveBeenCalledWith(
    expect.stringContaining("codex exec"),
    "/tmp/repository",
    { CODEX_API_KEY: "openai-secret" },
    31,
  );
  await sandbox.dispose();
  expect(environment.dispose).toHaveBeenCalledOnce();
});

it("uses the injected provider to destroy an environment after a transport failure", async () => {
  const { environment, create } = setup();
  environment.executeCommand
    .mockResolvedValueOnce({ exitCode: 0, result: "" })
    .mockRejectedValueOnce(new Error("transport"));
  const sandbox = await create("task-id");
  await expect(sandbox.execute("fix issue", issue.sha)).rejects.toThrow("EXECUTION_TIMEOUT");
  expect(environment.dispose).toHaveBeenCalledOnce();
});

it("rejects private repository setup without a backend GitHub token", async () => {
  const { environment, create } = setup();
  const sandbox = await create("task-id");
  await expect(sandbox.clone({ ...issue, private: true })).rejects.toThrow("SETUP_FAILED");
  expect(environment.clone).not.toHaveBeenCalled();
  expect(environment.uploadFile).not.toHaveBeenCalled();
});
