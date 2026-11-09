import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitEnvironment } from "@/github/git-env";
import { PublicationError } from "@/tasks/types";

const exec = promisify(execFile);

// Only Git's transport receives the token; inherited Git config and repository code cannot run.
export async function prepareCommit(input: {
  remote: string;
  token: string;
  author: { name: string; email: string };
  sourceSha: string;
  baseBranch: string;
  patch: string;
  taskId: string;
  createdAt: Date;
  signal: AbortSignal;
}) {
  if (!/^[a-f0-9]{40}$/.test(input.sourceSha)) throw new PublicationError("PATCH_INVALID");
  const root = await mkdtemp(join(tmpdir(), "draft-pr-"));
  const dispose = () => rm(root, { recursive: true, force: true });
  const directory = join(root, "repo");
  const env = {
    ...gitEnvironment(input.token),
    GIT_INDEX_FILE: join(root, "index"),
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: input.author.name,
    GIT_COMMITTER_EMAIL: input.author.email,
    GIT_AUTHOR_DATE: input.createdAt.toISOString(),
    GIT_COMMITTER_DATE: input.createdAt.toISOString(),
  };
  const git = async (args: string[]) =>
    (
      await exec("git", args, {
        cwd: directory,
        env,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        signal: input.signal,
      })
    ).stdout.trim();
  try {
    await mkdir(directory);
    await git(["init", "--bare", "--template="]);
    await git(["check-ref-format", `refs/heads/${input.baseBranch}`]);
    await git(["fetch", "--no-tags", input.remote, input.sourceSha]);
    await git(["fetch", "--no-tags", input.remote, `refs/heads/${input.baseBranch}`]);
    try {
      await git(["merge-base", "--is-ancestor", input.sourceSha, "FETCH_HEAD"]);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 1)
        throw new PublicationError("BASE_DIVERGED");
      throw error;
    }
    await git(["read-tree", input.sourceSha]);
    await writeFile(join(root, "changes.patch"), input.patch);
    try {
      await git([
        "apply",
        "--cached",
        "--binary",
        "--whitespace=nowarn",
        join(root, "changes.patch"),
      ]);
    } catch {
      input.signal.throwIfAborted();
      throw new PublicationError("PATCH_INVALID");
    }
    const tree = await git(["write-tree"]);
    if (tree === (await git(["rev-parse", `${input.sourceSha}^{tree}`])))
      throw new PublicationError("PATCH_INVALID");
    const sha = await git([
      "commit-tree",
      tree,
      "-p",
      input.sourceSha,
      "-m",
      `Draft for task ${input.taskId}`,
    ]);
    return {
      sha,
      async push(branch: string) {
        await git(["check-ref-format", `refs/heads/${branch}`]);
        // An empty expected SHA makes this create-only, even if another writer wins the race.
        await git([
          "push",
          "--no-verify",
          `--force-with-lease=refs/heads/${branch}:`,
          input.remote,
          `${sha}:refs/heads/${branch}`,
        ]);
      },
      dispose,
    };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
