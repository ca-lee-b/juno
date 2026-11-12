import { beforeEach, expect, it, vi } from "vitest";
import { readWorkerConfig } from "@/config";
import { createDaytonaProvider } from "@/sandbox/daytona";

import { createRepositorySandboxProvider } from "@/sandbox/repository";

const createSandboxProvider = (
  config: Parameters<typeof createRepositorySandboxProvider>[0] &
    Parameters<typeof createDaytonaProvider>[0],
) => createRepositorySandboxProvider(config, createDaytonaProvider(config));

const mocks = vi.hoisted(() => ({
  bundle: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  command: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
}));
vi.mock("@/github/bundle", () => ({ repositoryBundle: mocks.bundle }));
vi.mock("@daytona/sdk", () => ({
  Daytona: class {
    create = mocks.create;
    delete = mocks.delete;
  },
}));
const config = readWorkerConfig({
  DATABASE_URL: "postgres://localhost/db",
  REDIS_URL: "redis://localhost",
  OPENAI_API_KEY: "secret",
  DAYTONA_API_KEY: "private",
  OPENAI_CODEX_MODEL: "test",
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockResolvedValue({
    id: "sandbox",
    process: { executeCommand: mocks.command },
    fs: { uploadFile: mocks.upload, downloadFile: mocks.download },
  });
  mocks.command.mockResolvedValue({ exitCode: 0, result: "0" });
  mocks.download.mockImplementation(async (path: string) =>
    Buffer.from(path.endsWith("summary.txt") ? "done" : ""),
  );
});
it("executes once and captures artifacts without placing keys in command text", async () => {
  const sandbox = await createSandboxProvider(config)("task");
  expect(await sandbox.execute("issue", "a".repeat(40))).toEqual({
    summary: "done",
    patch: "",
    events: "",
  });
  const args = mocks.command.mock.calls.find(([command]) => command.includes("codex exec"));
  expect(args).toBeDefined();
  expect(args?.[0]).not.toContain("secret");
  expect(args?.[0]).toContain("--model 'test'");
  expect(args?.[0]).toContain(`-c 'model_reasoning_effort="medium"'`);
  expect(args?.[2]).toEqual({ CODEX_API_KEY: "secret" });
});
it.each([1, 124, 137])(
  "classifies CLI exit %s and destroys timed-out environments",
  async (exitCode) => {
    mocks.command.mockImplementation(async (command: string) => ({
      exitCode: command.includes("codex exec") ? exitCode : 0,
      result: "0",
    }));
    const sandbox = await createSandboxProvider(config)("task");
    await expect(sandbox.execute("issue", "a".repeat(40))).rejects.toMatchObject({
      code: exitCode === 1 ? "EXECUTION_FAILED" : "EXECUTION_TIMEOUT",
      exitCode,
    });
    expect(mocks.delete).toHaveBeenCalledTimes(exitCode === 1 ? 0 : 1);
  },
);
it("destroys the sandbox before surfacing a transport timeout", async () => {
  mocks.command.mockImplementation(async (command: string) => {
    if (command.includes("codex exec")) throw new Error("secret headers");
    return { exitCode: 0, result: "0" };
  });
  let finishDeletion!: () => void;
  mocks.delete.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishDeletion = resolve;
      }),
  );
  const sandbox = await createSandboxProvider(config)("task");
  let settled = false;
  const execution = sandbox.execute("issue", "a".repeat(40));
  const rejection = expect(execution).rejects.toThrow("EXECUTION_TIMEOUT");
  void execution.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.waitFor(() => expect(mocks.delete).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  finishDeletion();
  await rejection;
  expect(mocks.delete).toHaveBeenCalledOnce();
  await sandbox.dispose();
  expect(mocks.delete).toHaveBeenCalledOnce();
});
it("classifies artifact download failures", async () => {
  mocks.download.mockRejectedValue(new Error("missing"));
  const sandbox = await createSandboxProvider(config)("task");
  await expect(sandbox.execute("issue", "a".repeat(40))).rejects.toThrow("OUTPUT_FAILED");
});

it("uploads a private Git bundle without exposing the GitHub token to Daytona", async () => {
  mocks.bundle.mockResolvedValue(Buffer.from("bundle"));
  const sandbox = await createSandboxProvider({ ...config, GITHUB_TOKEN: "github-secret" })("task");
  await sandbox.clone({
    owner: "owner",
    repo: "repo",
    issueNumber: 1,
    title: "issue",
    body: "",
    sha: "a".repeat(40),
    branch: "main",
    private: true,
  });
  expect(mocks.bundle).toHaveBeenCalledOnce();
  expect(mocks.upload).toHaveBeenCalledWith(Buffer.from("bundle"), "/tmp/source.bundle");
  expect(JSON.stringify(mocks.command.mock.calls)).not.toContain("github-secret");
});

it("rejects oversized patches before downloading artifacts", async () => {
  mocks.command.mockImplementation(async (command: string) => ({
    exitCode: 0,
    result: command.includes("wc -c") ? String(5 * 1024 * 1024 + 1) : "0",
  }));
  const sandbox = await createSandboxProvider(config)("task");
  await expect(sandbox.execute("issue", "a".repeat(40))).rejects.toThrow("PATCH_TOO_LARGE");
  expect(mocks.download).not.toHaveBeenCalled();
});

it("rejects missing output artifacts", async () => {
  mocks.download.mockImplementation(async (path: string) =>
    path.endsWith("summary.txt") ? undefined : Buffer.from("output"),
  );
  const sandbox = await createSandboxProvider(config)("task");
  await expect(sandbox.execute("issue", "a".repeat(40))).rejects.toThrow("OUTPUT_FAILED");
});

it("does not execute Codex when installation fails", async () => {
  mocks.command.mockResolvedValueOnce({ exitCode: 1, result: "installation failed" });
  const sandbox = await createSandboxProvider(config)("task");
  await expect(sandbox.execute("issue", "a".repeat(40))).rejects.toMatchObject({
    code: "SETUP_FAILED",
    exitCode: 1,
  });
  expect(mocks.command).toHaveBeenCalledTimes(1);
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});

it("allows cleanup to be retried after a failed deletion", async () => {
  mocks.delete.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(undefined);
  const sandbox = await createSandboxProvider(config)("task");
  await expect(sandbox.dispose()).rejects.toThrow("unavailable");
  await sandbox.dispose();
  await sandbox.dispose();
  expect(mocks.delete).toHaveBeenCalledTimes(2);
});

it("preserves Daytona isolation, lifetime, and exact-commit public cloning", async () => {
  const clone = vi.fn().mockResolvedValue(undefined);
  mocks.create.mockResolvedValueOnce({ id: "daytona-id", git: { clone } });
  const sandbox = await createDaytonaProvider(config)("task-id");
  expect(mocks.create).toHaveBeenCalledWith(
    {
      language: "typescript",
      public: false,
      ephemeral: true,
      autoStopInterval: 30,
      ttlMinutes: 30,
      labels: { project: "byo-pr-agent", taskId: "task-id" },
    },
    { timeout: 60 },
  );
  await sandbox.clone("https://github.com/owner/repo.git", "/tmp/repository", "a".repeat(40));
  expect(clone).toHaveBeenCalledWith(
    "https://github.com/owner/repo.git",
    "/tmp/repository",
    undefined,
    "a".repeat(40),
    undefined,
    undefined,
    false,
    1,
  );
});
