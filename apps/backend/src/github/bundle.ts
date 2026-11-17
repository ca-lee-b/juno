import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IssueContext } from "@/execution/contracts";
import { gitEnvironment } from "@/github/git-env";

const exec = promisify(execFile);

// Credentials exist only in the backend process environment, never in Git config or the bundle.
export async function repositoryBundle(issue: IssueContext, token: string): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "agent-git-"));
  try {
    const env = gitEnvironment(token);
    const git = (args: string[]) =>
      exec("git", args, { cwd: directory, env, timeout: 120000, maxBuffer: 1024 * 1024 });
    await git(["init", "--bare", "."]);
    await git([
      "fetch",
      "--no-tags",
      `https://github.com/${issue.owner}/${issue.repo}.git`,
      issue.sha,
    ]);
    await git(["update-ref", "refs/heads/source", issue.sha]);
    await git(["bundle", "create", "source.bundle", "refs/heads/source"]);
    return await readFile(join(directory, "source.bundle"));
  } catch {
    throw new Error("Could not prepare repository");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
