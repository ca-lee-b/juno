import { expect, it, vi } from "vitest";
import { runLive } from "@/agent/live";
import type { IssueContext } from "@/execution/contracts";
import type { Sandbox, SandboxProvider } from "@/sandbox/contracts";
import { createRepositorySandboxProvider } from "@/sandbox/repository";

vi.mock("@/agent/live", () => ({ runLive: vi.fn() }));
const tasks = {
  inbox: vi.fn(),
  reply: vi.fn(),
  liveLost: vi.fn(),
  waiting: vi.fn(),
};
const config = {
  GITHUB_TOKEN: "github-test",
  ENGINE_ENDPOINT: "wss://worker.example",
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
  vi.mocked(runLive).mockResolvedValue({ summary: "done", usage: null });
  const environment = {
    id: "other-provider-id",
    renew: vi.fn(),
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
  return {
    environment,
    provider,
    create: createRepositorySandboxProvider(config, provider, tasks),
  };
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
  expect(await sandbox.execute("fix issue")).toEqual({
    summary: "done",
    patch: "",
    usage: null,
  });
  expect(runLive).toHaveBeenCalledOnce();
  await sandbox.dispose();
  expect(environment.dispose).toHaveBeenCalledOnce();
});

it("uses the injected provider to destroy an environment after a transport failure", async () => {
  const { environment, create } = setup();
  vi.mocked(runLive).mockRejectedValueOnce(new Error("transport"));
  const sandbox = await create("task-id");
  await expect(sandbox.execute("fix issue")).rejects.toThrow("EXECUTION_FAILED");
  expect(environment.dispose).toHaveBeenCalledOnce();
});
