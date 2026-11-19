import { beforeEach, expect, it, vi } from "vitest";
import { runLive } from "@/agent/live";
import { readWorkerConfig } from "@/config";
import { createDaytonaProvider } from "@/sandbox/daytona";

import { createRepositorySandboxProvider } from "@/sandbox/repository";

vi.mock("@/agent/live", () => ({ runLive: vi.fn() }));
const tasks = {
  messages: vi.fn().mockResolvedValue([]),
  reply: vi.fn(),
  liveLost: vi.fn(),
  closeMessages: vi.fn(),
};
const createSandboxProvider = (
  config: Parameters<typeof createRepositorySandboxProvider>[0] &
    Parameters<typeof createDaytonaProvider>[0],
) => createRepositorySandboxProvider(config, createDaytonaProvider(config), tasks);

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
  ENGINE_ENDPOINT: "wss://worker.example",
  OPENAI_API_KEY: "secret",
  DAYTONA_API_KEY: "private",
  OPENAI_CODEX_MODEL: "test",
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runLive).mockResolvedValue({ summary: "done", usage: null });
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
    usage: null,
  });
  expect(runLive).toHaveBeenCalledOnce();
});
it("installs only the two built-in skills before starting Codex", async () => {
  const sandbox = await createSandboxProvider(config)("task");
  await sandbox.execute("issue", "a".repeat(40));
  const commands = mocks.command.mock.calls;
  expect(commands[0]?.[0]).toContain("npm install");
  expect(commands[1]?.[0]).toContain("--skill 'codebase-design'");
  expect(commands[2]?.[0]).toContain("--skill 'code-simplifier'");
  for (const call of commands.slice(1, 3)) {
    expect(call[0]).toContain("npx --yes skills@1.8.1 add");
    expect(call[0]).toMatch(/\/tree\/[a-f0-9]{40}'/);
    expect(call[0]).toContain("--agent codex --global --yes");
    expect(call[1]).toBe("/tmp");
    expect(call[2]).toEqual({ DISABLE_TELEMETRY: "1" });
  }
  expect(runLive).toHaveBeenCalledOnce();
});
it.each([1, 2])("does not start Codex when built-in skill %s fails", async (index) => {
  for (let i = 0; i < index; i++) {
    mocks.command.mockResolvedValueOnce({ exitCode: 0, result: "" });
  }
  mocks.command.mockResolvedValueOnce({ exitCode: 1, result: "skill install failed" });
  const sandbox = await createSandboxProvider(config)("task");
  await expect(sandbox.execute("issue", "a".repeat(40))).rejects.toMatchObject({
    code: "SETUP_FAILED",
    exitCode: 1,
  });
  expect(mocks.command).toHaveBeenCalledTimes(index + 1);
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("destroys the sandbox before surfacing a transport timeout", async () => {
  vi.mocked(runLive).mockRejectedValueOnce(new Error("transport"));
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

it.each([true, false])(
  "uploads the pinned Git bundle without exposing the token (private=%s)",
  async (privateRepo) => {
    mocks.bundle.mockResolvedValue(Buffer.from("bundle"));
    const sandbox = await createSandboxProvider({ ...config, GITHUB_TOKEN: "github-secret" })(
      "task",
    );
    await sandbox.clone({
      owner: "owner",
      repo: "repo",
      issueNumber: 1,
      title: "issue",
      body: "",
      sha: "a".repeat(40),
      branch: "main",
      private: privateRepo,
    });
    expect(mocks.bundle).toHaveBeenCalledOnce();
    expect(mocks.upload).toHaveBeenCalledWith(Buffer.from("bundle"), "/tmp/source.bundle");
    expect(JSON.stringify(mocks.command.mock.calls)).not.toContain("github-secret");
  },
);

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
    path.endsWith("changes.patch") ? undefined : Buffer.from("output"),
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
  expect(mocks.command).toHaveBeenCalledWith(
    expect.stringContaining(`fetch --depth=1 origin '${"a".repeat(40)}'`),
    "/tmp",
    undefined,
    120,
  );
  mocks.command.mockResolvedValueOnce({ exitCode: 128, result: "missing commit" });
  await expect(
    sandbox.clone("https://github.com/owner/repo.git", "/tmp/other", "b".repeat(40)),
  ).rejects.toMatchObject({ code: "SETUP_FAILED", exitCode: 128 });
});
