import type { IssueContext } from "@/execution/contracts";
import { createGitHubClient } from "@/github/client";
import type { TaskInput } from "@/tasks/input";
import type { Publication } from "@/tasks/types";

export function createIssueReader(token?: string) {
  const github = createGitHubClient({ token, timeout: 15000 });
  return async (
    input: TaskInput,
    existingSha: string | null,
    publication?: Publication | null,
  ): Promise<IssueContext> => {
    const params = {
      owner: input.owner,
      repo: input.repo,
    };
    const { data: repo } = await github.rest.repos.get(params);
    if (repo.size > 100000) throw new Error("Repository exceeds the scaffold's 100 MB size limit");
    const { data: issue } = await github.rest.issues.get({
      ...params,
      issue_number: input.issueNumber,
    });
    if (issue.pull_request) throw new Error("Expected an issue, received a pull request");
    let base = repo.default_branch;
    if (publication?.prNumber) {
      const { data: pull } = await github.rest.pulls.get({
        ...params,
        pull_number: publication.prNumber,
      });
      if (
        pull.state !== "open" ||
        pull.head.ref !== publication.branch ||
        pull.head.repo?.full_name.toLowerCase() !== `${input.owner}/${input.repo}`.toLowerCase()
      )
        throw new Error("Session pull request has changed");
      existingSha = pull.head.sha;
      base = pull.base.ref;
    }
    const sha =
      existingSha ??
      (await github.rest.repos.getCommit({ ...params, ref: repo.default_branch })).data.sha;
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid source commit");
    return {
      ...input,
      private: repo.private,
      branch: base,
      title: issue.title,
      body: (issue.body ?? "").slice(0, 20000),
      sha,
    };
  };
}
