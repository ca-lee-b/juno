"use client";

import { request } from "@/lib/request";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectContent, SelectItem } from "@/components/ui/select";

type Input = { owner: string; repo: string; issueNumber: string };
type Repository = { owner: string; name: string; fullName: string; private: boolean };
type Issue = { number: number; title: string };
export function IssueFields({
  input,
  setInput,
  connected,
}: {
  input: Input;
  setInput: (value: Input) => void;
  connected: boolean;
}) {
  const repositories = useInfiniteQuery({
    queryKey: ["github", "repositories"],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      request<{ repositories: Repository[]; nextPage: number | null }>(
        `/api/github/repositories?page=${pageParam}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextPage,
    enabled: connected,
  });
  const issues = useInfiniteQuery({
    queryKey: ["github", "issues", input.owner, input.repo],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      request<{ issues: Issue[]; nextPage: number | null }>(
        `/api/github/issues?${new URLSearchParams({ owner: input.owner, repo: input.repo, page: String(pageParam) })}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextPage,
    enabled: connected && !!input.owner && !!input.repo,
  });
  const repos = [
    ...new Map(
      repositories.data?.pages.flatMap((p) => p.repositories).map((r) => [r.fullName, r]),
    ).values(),
  ];
  const rows = [
    ...new Map(issues.data?.pages.flatMap((p) => p.issues).map((i) => [i.number, i])).values(),
  ];
  const selected = input.owner && input.repo ? `${input.owner}/${input.repo}` : "";
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p id="repository-label" className="text-caption text-muted-foreground">
          Repository
        </p>
        <Select
          value={selected}
          disabled={!connected || repositories.isPending}
          onValueChange={(value) => {
            const repository = repos.find((r) => r.fullName === value);
            if (repository)
              setInput({ owner: repository.owner, repo: repository.name, issueNumber: "" });
          }}
        >
          <SelectTrigger
            aria-labelledby="repository-label"
            className="w-full"
            placeholder={repositories.isFetching ? "Loading repositories…" : "Select a repository"}
          />
          <SelectContent>
            {repos.map((repo, index) => (
              <SelectItem
                index={index}
                key={repo.fullName}
                value={repo.fullName}
              >{`${repo.fullName}${repo.private ? " (private)" : ""}`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {connected && repositories.isSuccess && !repos.length && (
          <p role="status" className="note">
            No repositories are available to the server’s GitHub token.
          </p>
        )}
        {repositories.error && (
          <p role="alert" className="note text-destructive">
            {repositories.error.message}{" "}
            <Button type="button" variant="ghost" onClick={() => repositories.refetch()}>
              Retry
            </Button>
          </p>
        )}
        {repositories.hasNextPage && (
          <Button
            type="button"
            variant="ghost"
            loading={repositories.isFetchingNextPage}
            onClick={() => repositories.fetchNextPage()}
          >
            Load more repositories
          </Button>
        )}
      </div>
      <div className="space-y-2">
        <p id="issue-label" className="text-caption text-muted-foreground">
          Issue
        </p>
        <Select
          value={input.issueNumber}
          disabled={!connected || !selected || issues.isPending}
          onValueChange={(issueNumber) => setInput({ ...input, issueNumber })}
        >
          <SelectTrigger
            aria-labelledby="issue-label"
            className="w-full"
            placeholder={
              !selected
                ? "Select a repository first"
                : issues.isFetching
                  ? "Loading issues…"
                  : "Select an open issue"
            }
          />
          <SelectContent>
            {rows.map((issue, index) => (
              <SelectItem
                index={index}
                key={issue.number}
                value={String(issue.number)}
              >{`#${issue.number} · ${issue.title}`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {issues.isSuccess && !rows.length && (
          <p role="status" className="note">
            No open issues on this page.{issues.hasNextPage ? " Load more to continue." : ""}
          </p>
        )}
        {issues.error && (
          <p role="alert" className="note text-destructive">
            {issues.error.message}{" "}
            <Button type="button" variant="ghost" onClick={() => issues.refetch()}>
              Retry
            </Button>
          </p>
        )}
        {issues.hasNextPage && (
          <Button
            type="button"
            variant="ghost"
            loading={issues.isFetchingNextPage}
            onClick={() => issues.fetchNextPage()}
          >
            Load more issues
          </Button>
        )}
      </div>
      <p className="text-caption text-muted-foreground">
        {connected
          ? "Repositories available to this server’s GitHub token. Only run tasks on repositories you trust."
          : "Connect your API to browse repositories and issues."}
      </p>
    </div>
  );
}
