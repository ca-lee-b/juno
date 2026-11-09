import type pg from "pg";
import { z } from "zod";
import { prepareCommit } from "@/github/commit";
import { createGitHubPublisher } from "@/github/publish";
import { taskInputSchema } from "@/tasks/input";
import { PublicationRepository } from "@/tasks/publications";
import { type Publication, PublicationError, type Task } from "@/tasks/types";

export type PublishResult =
  | { httpStatus: 200 | 201; publication: Publication }
  | { httpStatus: 202; status: "in_progress" }
  | { httpStatus: 403 | 409 | 502 | 503; error: string };

export function createPublisher(pool: Pick<pg.Pool, "connect">, token?: string) {
  return async (task: Task): Promise<PublishResult> => {
    if (task.publication?.prUrl) return { httpStatus: 200, publication: task.publication };
    if (
      task.status !== "completed" ||
      !task.result?.patch.trim() ||
      !task.sourceSha ||
      !task.sourceBranch ||
      !task.result.prTitle?.trim() ||
      !task.result.prDescription?.trim() ||
      !/^[a-f0-9]{40}$/.test(task.sourceSha) ||
      !z.uuid().safeParse(task.id).success ||
      !taskInputSchema.safeParse(task.input).success
    )
      return { httpStatus: 409, error: "TASK_NOT_PUBLISHABLE" };
    if (!token) return { httpStatus: 503, error: "GITHUB_NOT_CONFIGURED" };

    const client = await pool.connect();
    const publications = new PublicationRepository(client);
    const disconnected = new AbortController();
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(300000)]);
    let broken = false;
    let locked = false;
    const onError = () => {
      broken = true;
      disconnected.abort();
    };
    client.on("error", onError);
    try {
      try {
        locked =
          (
            await client.query<{ locked: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
              [task.id],
            )
          ).rows[0]?.locked === true;
      } catch (error) {
        // A lost reply can hide an acquired session lock; never return that connection to the pool.
        broken = true;
        throw error;
      }
      if (!locked) return { httpStatus: 202, status: "in_progress" };
      const old = await publications.get(task.id);
      if (old?.prUrl) return { httpStatus: 200, publication: old };
      // Owning the lock, not a persisted status, determines whether an attempt is active.
      const github = createGitHubPublisher(token, task.input, signal);
      const branch = old?.branch ?? `byo-pr-agent/${task.id}`;
      const base = old?.baseBranch ?? task.sourceBranch;
      const remote = `https://github.com/${task.input.owner}/${task.input.repo}`;
      await publications.start(task.id, branch, base, `${remote}/tree/${branch}`);
      const existing = await github.findPull(branch, task.id);
      if (existing)
        return { httpStatus: 200, publication: await publications.complete(task.id, existing) };

      const commit = await prepareCommit({
        remote: `${remote}.git`,
        token,
        author: await github.author(),
        sourceSha: task.sourceSha,
        baseBranch: base,
        patch: task.result.patch,
        taskId: task.id,
        createdAt: task.createdAt,
        signal,
      });
      try {
        if (old?.commitSha && old.commitSha !== commit.sha)
          throw new PublicationError("BRANCH_CONFLICT");
        await publications.setCommit(task.id, commit.sha);
        await pushBranch(github, commit, branch, signal);
        const pr = await createPull(github, branch, base, task.id, task.result, signal);
        return { httpStatus: 201, publication: await publications.complete(task.id, pr) };
      } finally {
        // A cleanup failure must not turn a saved publication into a failed request.
        await commit.dispose().catch(() => {});
      }
    } catch (error) {
      const gitPermissionDenied =
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        /The requested URL returned error: 403/.test(error.stderr);
      const code = gitPermissionDenied
        ? "GITHUB_WRITE_DENIED"
        : error instanceof PublicationError
          ? error.code
          : "PUBLISH_FAILED";
      if (locked && !broken) await publications.fail(task.id, code).catch(() => {});
      return {
        httpStatus: gitPermissionDenied ? 403 : error instanceof PublicationError ? 409 : 502,
        error: code,
      };
    } finally {
      if (locked && !broken) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [task.id]);
        } catch {
          broken = true;
        }
      }
      client.removeListener("error", onError);
      client.release(broken);
    }
  };
}

async function pushBranch(
  github: ReturnType<typeof createGitHubPublisher>,
  commit: Awaited<ReturnType<typeof prepareCommit>>,
  branch: string,
  signal: AbortSignal,
) {
  const remoteSha = await github.branchSha(branch);
  if (remoteSha && remoteSha !== commit.sha) throw new PublicationError("BRANCH_CONFLICT");
  if (remoteSha) return;
  signal.throwIfAborted();
  try {
    await commit.push(branch);
  } catch (error) {
    signal.throwIfAborted();
    const recovered = await github.branchSha(branch);
    if (recovered !== commit.sha) {
      if (recovered) throw new PublicationError("BRANCH_CONFLICT");
      throw error;
    }
  }
}

async function createPull(
  github: ReturnType<typeof createGitHubPublisher>,
  branch: string,
  base: string,
  taskId: string,
  result: NonNullable<Task["result"]>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const existing = await github.findPull(branch, taskId);
  if (existing) return existing;
  try {
    return await github.createPull(branch, base, taskId, result.prDescription, result.prTitle);
  } catch (error) {
    signal.throwIfAborted();
    const recovered = await github.findPull(branch, taskId);
    if (!recovered) throw error;
    return recovered;
  }
}
