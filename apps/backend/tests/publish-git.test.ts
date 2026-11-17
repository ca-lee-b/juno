import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareCommit } from "@/github/commit";
import { gitEnvironment } from "@/github/git-env";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("does not inherit credentials, Git hooks or trace/config overrides", () => {
  vi.stubEnv("GIT_TRACE", "/tmp/unsafe-trace");
  vi.stubEnv("GIT_CONFIG_PARAMETERS", "unsafe config");
  vi.stubEnv("OPENAI_API_KEY", "sandbox-secret");
  const env = gitEnvironment("github-secret");
  expect(env.GIT_TRACE).toBeUndefined();
  expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(env.GIT_CONFIG_VALUE_2).toBe("/dev/null");
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "publish-test-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(root, "edit"), "before\n");
  writeFileSync(join(root, "delete"), "gone\n");
  writeFileSync(join(root, "mode"), "script\n");
  git("add", ".");
  git("commit", "-m", "base");
  const sourceSha = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "edit"), "after\n");
  rmSync(join(root, "delete"));
  writeFileSync(join(root, "binary"), Buffer.from([0, 255, 42, 0]));
  writeFileSync(join(root, "new file"), "new\n");
  chmodSync(join(root, "mode"), 0o755);
  symlinkSync("edit", join(root, "link"));
  git("add", ".");
  const patch = git("diff", "--cached", "--binary", "--full-index", sourceSha);
  const tree = git("write-tree").trim();
  return {
    root,
    git,
    tree,
    input: {
      remote: root,
      author: { name: "user", email: "1+user@users.noreply.github.com" },
      token: "never-written-secret",
      sourceSha,
      baseBranch: "main",
      patch,
      taskId: randomUUID(),
      createdAt: new Date("2026-01-01"),
      signal: new AbortController().signal,
    },
  };
}

it("pushes the exact binary patch, modes, symlinks, additions and deletions with deterministic commit", async () => {
  const { git, tree, input } = fixture();
  const first = await prepareCommit(input);
  const second = await prepareCommit(input);
  try {
    expect(first.sha).toBe(second.sha);
    await first.push("byo-pr-agent/test");
    expect(git("rev-parse", `${first.sha}^{tree}`).trim()).toBe(tree);
    expect(git("rev-parse", `${first.sha}^`).trim()).toBe(input.sourceSha);
    expect(git("show", `${first.sha}:new file`)).toBe("new\n");
    expect(git("ls-tree", first.sha)).toContain("100755 blob");
    expect(git("ls-tree", first.sha)).toContain("120000 blob");
    expect(git("log", "-1", "--format=%B", first.sha)).not.toContain(input.token);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

it("never fast-forwards a competing branch, even if it points to the source commit", async () => {
  const { git, input } = fixture();
  const commit = await prepareCommit(input);
  try {
    git("branch", "byo-pr-agent/collision", input.sourceSha);
    await expect(commit.push("byo-pr-agent/collision")).rejects.toThrow();
    expect(git("rev-parse", "byo-pr-agent/collision").trim()).toBe(input.sourceSha);
  } finally {
    await commit.dispose();
  }
});

it("allows advancing bases without rebasing, but rejects rewritten history and invalid patches", async () => {
  const { git, input } = fixture();
  git("commit", "-m", "advance base");
  const commit = await prepareCommit(input);
  await commit.dispose();
  await expect(prepareCommit({ ...input, patch: "not a patch" })).rejects.toThrow("PATCH_INVALID");
  git("checkout", "--orphan", "unrelated");
  git("commit", "-m", "new root");
  await expect(prepareCommit({ ...input, baseBranch: "unrelated" })).rejects.toThrow(
    "BASE_DIVERGED",
  );
});
