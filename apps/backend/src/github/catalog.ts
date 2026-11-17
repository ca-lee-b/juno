import { createGitHubClient } from "@/github/client";

export function createGitHubCatalog(token: string) {
  const github = createGitHubClient({ token, timeout: 10000 });
  const hasNext = (link?: string) => !!link?.includes('rel="next"');
  return {
    async repositories(page: number) {
      const response = await github.rest.repos.listForAuthenticatedUser({
        per_page: 50,
        page,
        sort: "updated",
        direction: "desc",
      });
      return {
        repositories: response.data.map((r) => ({
          owner: r.owner.login,
          name: r.name,
          fullName: r.full_name,
          private: r.private,
        })),
        nextPage: hasNext(response.headers.link) ? page + 1 : null,
      };
    },
    async issues(owner: string, repo: string, page: number) {
      const response = await github.rest.issues.listForRepo({
        owner,
        repo,
        state: "open",
        per_page: 50,
        page,
        sort: "updated",
        direction: "desc",
      });
      return {
        issues: response.data
          .filter((i) => !i.pull_request)
          .map((i) => ({ number: i.number, title: i.title })),
        nextPage: hasNext(response.headers.link) ? page + 1 : null,
      };
    },
  };
}
export type GitHubCatalog = ReturnType<typeof createGitHubCatalog>;
