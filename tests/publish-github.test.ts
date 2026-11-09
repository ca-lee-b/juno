import { beforeEach, expect, it, vi } from "vitest";
import { createGitHubPublisher } from "@/github/publish";

const mocks = vi.hoisted(() => ({
  paginate: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  getRef: vi.fn(),
  repo: vi.fn(),
}));
vi.mock("octokit", () => ({
  Octokit: class {
    hook = { before: vi.fn() };
    paginate = mocks.paginate;
    rest = {
      repos: { get: mocks.repo },
      git: { getRef: mocks.getRef },
      pulls: { list: mocks.list, create: mocks.create },
    };
  },
}));
beforeEach(() => vi.resetAllMocks());
const github = () =>
  createGitHubPublisher(
    "secret",
    { owner: "owner", repo: "repo", issueNumber: 2 },
    new AbortController().signal,
  );

it.each(["open", "closed", "merged"])("finds the original %s PR across pages", async (state) => {
  mocks.paginate.mockResolvedValue([
    {
      number: 7,
      html_url: "https://github.com/owner/repo/pull/7",
      state,
      body: "<!-- BYO-PR-AGENT-TASK:task -->",
    },
  ]);
  expect(await github().findPull("branch", "task")).toEqual({
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
  });
  expect(mocks.paginate).toHaveBeenCalledWith(
    mocks.list,
    expect.objectContaining({ head: "owner:branch", state: "all" }),
  );
  expect(mocks.create).not.toHaveBeenCalled();
});

it("does not create another PR when the branch already has an unrecognized PR", async () => {
  mocks.paginate.mockResolvedValue([{ body: "different owner", number: 9 }]);
  await expect(github().findPull("branch", "task")).rejects.toThrow("PR_CONFLICT");
});

it("creates an explicit draft with the supplied title and task identity", async () => {
  mocks.create.mockResolvedValue({ data: { number: 1, html_url: "url" } });
  await github().createPull(
    "branch",
    "main",
    "task",
    "Reviewer description",
    "fix(auth): preserve session",
  );
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      draft: true,
      head: "branch",
      base: "main",
      title: "fix(auth): preserve session",
      body: expect.stringContaining("<!-- BYO-PR-AGENT-TASK:task -->"),
    }),
  );
});

it("treats only 404 as absent, not permissions or rate limits", async () => {
  mocks.getRef.mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }));
  expect(await github().branchSha("branch")).toBeNull();
  mocks.getRef.mockRejectedValueOnce(Object.assign(new Error("denied"), { status: 403 }));
  await expect(github().branchSha("branch")).rejects.toThrow("denied");
});
