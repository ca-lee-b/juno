import { CommandExitError } from "e2b";
import { beforeEach, expect, it, vi } from "vitest";
import { createE2BProvider } from "@/sandbox/e2b";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
  kill: vi.fn(),
}));
vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { create: mocks.create },
}));
const create = createE2BProvider({ E2B_API_KEY: "provider-secret" });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockResolvedValue({
    sandboxId: "sandbox-1",
    commands: { run: mocks.run },
    files: { write: mocks.write, read: mocks.read },
    kill: mocks.kill,
  });
  mocks.run.mockResolvedValue({ exitCode: 0, stdout: "output", stderr: "diagnostic" });
});
it("creates a bounded sandbox with private URLs", async () => {
  expect((await create("task-1")).id).toBe("sandbox-1");
  expect(mocks.create).toHaveBeenCalledWith({
    apiKey: "provider-secret",
    timeoutMs: 1800000,
    metadata: { project: "byo-pr-agent", taskId: "task-1" },
    allowInternetAccess: true,
    network: { allowPublicTraffic: false },
  });
});
it("passes command options and keeps stdout separate from stderr", async () => {
  const sandbox = await create("task");
  expect(
    await sandbox.executeCommand("echo hi", "/tmp/repository", { CODEX_API_KEY: "secret" }, 630),
  ).toEqual({ exitCode: 0, result: "output" });
  expect(mocks.run).toHaveBeenCalledWith("echo hi", {
    cwd: "/tmp/repository",
    envs: { CODEX_API_KEY: "secret" },
    timeoutMs: 630000,
  });
});
it("returns nonzero exits but rejects transport and timeout errors", async () => {
  const sandbox = await create("task");
  mocks.run.mockRejectedValueOnce(
    new CommandExitError({ exitCode: 7, stdout: "7\n", stderr: "failure", error: "failure" }),
  );
  expect(await sandbox.executeCommand("false", "/tmp", undefined, 1)).toEqual({
    exitCode: 7,
    result: "7\n",
  });
  for (const message of ["transport", "timed out"]) {
    mocks.run.mockRejectedValueOnce(new Error(message));
    await expect(sandbox.executeCommand("true", "/tmp", undefined, 1)).rejects.toThrow(message);
  }
});
it("transfers binary files without encoding changes", async () => {
  const sandbox = await create("task");
  const bytes = Buffer.from([0, 255, 128, 10]);
  await sandbox.uploadFile(bytes, "/tmp/file");
  expect(mocks.write).toHaveBeenCalledWith("/tmp/file", bytes);
  mocks.read.mockResolvedValue(new Uint8Array(bytes));
  expect(await sandbox.downloadFile("/tmp/file")).toEqual(bytes);
  expect(mocks.read).toHaveBeenCalledWith("/tmp/file", { format: "bytes" });
});
it("clones an exact commit with quoted arguments and reports failures", async () => {
  const sandbox = await create("task");
  await sandbox.clone("https://github.com/org/repo.git", "/tmp/it's here", "abc123");
  const command = mocks.run.mock.calls[1]?.[0];
  expect(command).toContain("fetch --depth=1 origin 'abc123'");
  expect(command).toContain("checkout --detach FETCH_HEAD");
  expect(command).toContain("'/tmp/it'\\''s here'");
  mocks.run.mockRejectedValueOnce(
    new CommandExitError({ exitCode: 128, stdout: "", stderr: "failure", error: "failure" }),
  );
  await expect(sandbox.clone("url", "/tmp/repository", "sha")).rejects.toThrow();
});
it("retries failed cleanup and skips cleanup after success", async () => {
  const sandbox = await create("task");
  mocks.kill.mockRejectedValueOnce(new Error("unavailable"));
  await expect(sandbox.dispose()).rejects.toThrow("unavailable");
  await sandbox.dispose();
  await sandbox.dispose();
  expect(mocks.kill).toHaveBeenCalledTimes(2);
});

it("installs compatible Node before returning the sandbox", async () => {
  await create("task");
  expect(mocks.run).toHaveBeenNthCalledWith(
    1,
    "npm install --prefix /tmp/e2b-node node@24.22.3 && cp /tmp/e2b-node/node_modules/node/bin/node /usr/local/bin/node",
    {
      user: "root",
      cwd: "/tmp",
      timeoutMs: 120000,
    },
  );
});
it("destroys the sandbox when Node installation fails", async () => {
  const failure = new CommandExitError({
    exitCode: 1,
    stdout: "",
    stderr: "install failed",
    error: "install failed",
  });
  mocks.run.mockRejectedValueOnce(failure);
  await expect(create("task")).rejects.toBe(failure);
  expect(mocks.kill).toHaveBeenCalledOnce();
});
