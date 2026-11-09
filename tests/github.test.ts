import { beforeEach, expect, it, vi } from "vitest";
import { createGitHubCatalog } from "@/github/catalog";
import { createIssueReader } from "@/github/issues";

const mocks = vi.hoisted(() => ({
  repositories: vi.fn(),
  issues: vi.fn(),
  repo: vi.fn(),
  issue: vi.fn(),
  commit: vi.fn(),
}));
vi.mock("octokit", () => ({
  Octokit: class {
    hook = { before: vi.fn() };
    rest = {
      repos: {
        listForAuthenticatedUser: mocks.repositories,
        get: mocks.repo,
        getCommit: mocks.commit,
      },
      issues: { listForRepo: mocks.issues, get: mocks.issue },
    };
  },
}));
beforeEach(() => vi.resetAllMocks());
it("filters PRs without losing pagination, and only exposes catalog fields", async () => {
  mocks.issues.mockResolvedValue({
    data: [
      { number: 1, title: "PR", pull_request: {} },
      { number: 2, title: "Issue", body: "private body" },
    ],
    headers: { link: '<https://api.github.com/page=2>; rel="next"' },
  });
  expect(await createGitHubCatalog("secret").issues("owner", "repo", 1)).toEqual({
    issues: [{ number: 2, title: "Issue" }],
    nextPage: 2,
  });
  mocks.repositories.mockResolvedValue({
    data: [{ owner: { login: "owner" }, name: "repo", full_name: "owner/repo", private: true }],
    headers: {},
  });
  expect(await createGitHubCatalog("secret").repositories(1)).toEqual({
    repositories: [{ owner: "owner", name: "repo", fullName: "owner/repo", private: true }],
    nextPage: null,
  });
});
it("reads private issues while retaining source pinning and PR rejection", async () => {
  mocks.repo.mockResolvedValue({ data: { private: true, size: 1, default_branch: "main" } });
  mocks.issue.mockResolvedValue({ data: { title: "Issue", body: "Details" } });
  const input = { owner: "owner", repo: "repo", issueNumber: 2 };
  const read = createIssueReader("secret");
  expect(await read(input, "a".repeat(40))).toMatchObject({ private: true, sha: "a".repeat(40) });
  expect(mocks.commit).not.toHaveBeenCalled();
  mocks.issue.mockResolvedValue({ data: { pull_request: {} } });
  await expect(read(input, null)).rejects.toThrow("Expected an issue");
});
