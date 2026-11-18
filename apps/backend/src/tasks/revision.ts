import { createGitHubClient } from "@/github/client";
import { prepareCommit } from "@/github/commit";
import { createGitHubPublisher } from "@/github/publish";
import type { Task } from "@/tasks/types";

export function createRevisionPublisher(token: string | undefined) {
  async function head(task: Task) {
    const publication = task.publication;
    if (!token || !publication?.prNumber || !task.sessionId) throw new Error("Missing PR");
    const { owner, repo } = task.input;
    const { data: pr } = await createGitHubClient({ token, timeout: 15000 }).rest.pulls.get({
      owner,
      repo,
      pull_number: publication.prNumber,
    });
    if (
      pr.state !== "open" ||
      pr.head.ref !== publication.branch ||
      pr.head.repo?.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      pr.head.ref === pr.base.ref ||
      pr.head.ref !== `byo-pr-agent/${task.sessionId}`
    )
      throw new Error("PR changed");
    return { branch: pr.head.ref, sha: pr.head.sha };
  }
  return {
    head,
    async comments(task: Task) {
      if (!task.publication?.prNumber) return [];
      const { owner, repo } = task.input;
      const { data } = await createGitHubClient({
        token,
        timeout: 15000,
      }).rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: task.publication.prNumber,
        sort: "updated",
        direction: "desc",
        per_page: 25,
      });
      return data
        .reverse()
        .map((c) => ({ path: c.path, line: c.line ?? null, body: c.body.slice(0, 2000) }));
    },
    async push(task: Task, sha: string, patch: string) {
      if (!patch) return;
      if (!token) throw new Error("Missing GitHub token");
      const current = await head(task);
      const signal = AbortSignal.timeout(120000);
      const author = await createGitHubPublisher(token, task.input, signal).author();
      const commit = await prepareCommit({
        remote: `https://github.com/${task.input.owner}/${task.input.repo}.git`,
        token,
        author,
        sourceSha: sha,
        baseBranch: current.branch,
        patch,
        taskId: task.id,
        createdAt: task.createdAt,
        signal,
      });
      try {
        if (current.sha === commit.sha) return;
        if (current.sha !== sha) throw new Error("PR branch advanced");
        await commit.push(current.branch, true);
      } finally {
        await commit.dispose();
      }
    },
  };
}
