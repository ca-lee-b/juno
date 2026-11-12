import { beforeEach, expect, it, vi } from "vitest";
import { createFreestyleProvider } from "@/sandbox/freestyle";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  exec: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("freestyle", () => ({
  Freestyle: class {
    vms = { create: mocks.create };
  },
}));
const create = createFreestyleProvider({ FREESTYLE_API_KEY: "provider-secret" });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockResolvedValue({
    vmId: "vm-1",
    vm: {
      exec: mocks.exec,
      delete: mocks.delete,
      fs: { writeFile: mocks.write, readFile: mocks.read },
    },
  });
  mocks.exec.mockResolvedValue({ statusCode: 0, stdout: "output", stderr: "diagnostic" });
});
it("creates a bounded VM with outbound-only public access", async () => {
  expect((await create("task-1")).id).toBe("vm-1");
  expect(mocks.create).toHaveBeenCalledWith({
    snapshotId: "freestyle/ubuntu-sm",
    ttlSeconds: 1800,
    autoDeleteSeconds: 0,
    metadata: { project: "byo-pr-agent", taskId: "task-1" },
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
  });
});
it("preserves long timeouts, environment, stdout and nonzero exits", async () => {
  const sandbox = await create("task");
  mocks.exec.mockResolvedValue({ statusCode: 7, stdout: "7\n", stderr: "error" });
  expect(
    await sandbox.executeCommand("echo hi", "/tmp/it's here", { CODEX_API_KEY: "secret" }, 630),
  ).toEqual({ exitCode: 7, result: "7\n" });
  expect(mocks.exec).toHaveBeenCalledWith({
    command: "cd '/tmp/it'\\''s here' && sh -c 'echo hi'",
    env: { CODEX_API_KEY: "secret" },
    timeoutMs: 630000,
  });
});
it("rejects timeouts and transport failures", async () => {
  const sandbox = await create("task");
  mocks.exec.mockResolvedValueOnce({ statusCode: null });
  await expect(sandbox.executeCommand("sleep 9", "/tmp", undefined, 1)).rejects.toThrow(
    "timed out",
  );
  mocks.exec.mockRejectedValueOnce(new Error("transport"));
  await expect(sandbox.executeCommand("true", "/tmp", undefined, 1)).rejects.toThrow("transport");
});
it("transfers binary files without encoding changes", async () => {
  const sandbox = await create("task");
  const bytes = Buffer.from([0, 255, 128, 10]);
  await sandbox.uploadFile(bytes, "/tmp/file");
  expect(mocks.write).toHaveBeenCalledWith("/tmp/file", bytes);
  mocks.read.mockResolvedValue(new Uint8Array(bytes));
  expect(await sandbox.downloadFile("/tmp/file")).toEqual(bytes);
});
it("clones the exact commit and reports setup failures", async () => {
  const sandbox = await create("task");
  await sandbox.clone("https://github.com/org/repo.git", "/tmp/repository", "abc123");
  expect(mocks.exec.mock.calls[0]?.[0].command).toContain("fetch --depth=1 origin");
  expect(mocks.exec.mock.calls[0]?.[0].command).toContain("checkout --detach FETCH_HEAD");
  mocks.exec.mockResolvedValueOnce({ statusCode: 128 });
  await expect(sandbox.clone("url", "/tmp/repository", "sha")).rejects.toThrow();
});
it("retries failed deletion and does not delete again after success", async () => {
  const sandbox = await create("task");
  mocks.delete.mockRejectedValueOnce(new Error("unavailable"));
  await expect(sandbox.dispose()).rejects.toThrow();
  await sandbox.dispose();
  await sandbox.dispose();
  expect(mocks.delete).toHaveBeenCalledTimes(2);
});
