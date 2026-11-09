import { createGitHubClient } from "@/github/client";
import type { TaskInput } from "@/tasks/input";
import { PublicationError, type PublishedPull } from "@/tasks/types";

export function createGitHubPublisher(token: string, input: TaskInput, signal: AbortSignal) {
  const github = createGitHubClient({ token, timeout: 15000, signal });
  const params = {
    owner: input.owner,
    repo: input.repo,
  };
  return {
    async author() {
      const { data } = await github.rest.users.getAuthenticated();
      return { name: data.login, email: `${data.id}+${data.login}@users.noreply.github.com` };
    },
    async branchSha(branch: string) {
      try {
        return (await github.rest.git.getRef({ ...params, ref: `heads/${branch}` })).data.object
          .sha;
      } catch (error) {
        if (error instanceof Error && "status" in error && error.status === 404) return null;
        throw error;
      }
    },
    async findPull(branch: string, taskId: string): Promise<PublishedPull | null> {
      const pulls = await github.paginate(github.rest.pulls.list, {
        ...params,
        state: "all",
        head: `${input.owner}:${branch}`,
        per_page: 100,
      });
      const matching = pulls.find((pr) =>
        pr.body?.includes(`<!-- BYO-PR-AGENT-TASK:${taskId} -->`),
      );
      if (matching) return { number: matching.number, url: matching.html_url };
      if (pulls.length) throw new PublicationError("PR_CONFLICT");
      return null;
    },
    async createPull(
      branch: string,
      base: string,
      taskId: string,
      description: string,
      title: string,
    ): Promise<PublishedPull> {
      const { data } = await github.rest.pulls.create({
        ...params,
        head: branch,
        base,
        draft: true,
        title,
        body: `Related to #${input.issueNumber}.\n\n${description}\n\n<!-- BYO-PR-AGENT-TASK:${taskId} -->`,
      });
      return { number: data.number, url: data.html_url };
    },
  };
}
