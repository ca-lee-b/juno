import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { patchCommand } from "@/sandbox/patch";

it("captures edits, deletions, new and binary files despite agent commits; patch applies", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-patch-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(root, "old"), "old\n");
    writeFileSync(join(root, "deleted"), "delete\n");
    writeFileSync(join(root, ".gitignore"), "ignored\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const sha = git("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "old"), "changed\n");
    git("add", ".");
    git("commit", "-qm", "agent commit");
    rmSync(join(root, "deleted"));
    writeFileSync(join(root, "new"), "new\n");
    writeFileSync(join(root, "binary"), Buffer.from([0, 255, 42]));
    writeFileSync(join(root, "ignored"), "secret");
    const output = join(root, ".git", "result.patch");
    execFileSync("sh", ["-c", patchCommand(sha, output)], { cwd: root });
    const patch = readFileSync(output, "utf8");
    expect(patch).toContain("GIT binary patch");
    expect(patch).not.toContain("secret");
    git("reset", "--hard", sha);
    git("clean", "-fd");
    git("apply", output);
    expect(readFileSync(join(root, "old"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(root, "new"), "utf8")).toBe("new\n");
    expect(readFileSync(join(root, "binary"))).toEqual(Buffer.from([0, 255, 42]));
    git("reset", "--hard", sha);
    git("clean", "-fd");
    execFileSync("sh", ["-c", patchCommand(sha, output)], { cwd: root });
    expect(readFileSync(output, "utf8")).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
