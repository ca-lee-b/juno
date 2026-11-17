"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/request";
import type { Publication, Task } from "@/lib/tasks";

export function DraftPrAction({ task }: { task: Task }) {
  const client = useQueryClient();
  const publish = useMutation({
    mutationFn: () =>
      request<{ publication: Publication } | { status: "in_progress" }>(
        `/api/tasks/${encodeURIComponent(task.id)}/draft-pr`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      if ("publication" in result) {
        client.setQueryData<Task>(["task", task.id], (current) =>
          current ? { ...current, publication: result.publication } : current,
        );
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["task", task.id] }),
  });
  const publication =
    publish.data && "publication" in publish.data ? publish.data.publication : task.publication;
  if (publication?.prUrl) {
    return (
      <Button asChild variant="primary" trailingIcon={ExternalLink}>
        <a href={publication.prUrl} target="_blank" rel="noreferrer">
          View PR{publication.prNumber ? ` #${publication.prNumber}` : ""}
        </a>
      </Button>
    );
  }
  if (
    task.status !== "completed" ||
    !task.result?.patch.trim() ||
    !/^[a-f0-9]{40}$/.test(task.sourceSha || "")
  )
    return null;

  const inProgress =
    publication?.status === "in_progress" ||
    (publish.data && "status" in publish.data && publication?.status !== "failed");
  const error = publish.error?.message || publication?.error;
  return (
    <div className="max-w-sm space-y-2">
      <Button
        variant="primary"
        leadingIcon={GitPullRequest}
        loading={publish.isPending}
        onClick={() => publish.mutate()}
      >
        {publish.isPending
          ? "Creating draft PR…"
          : error
            ? "Retry draft PR"
            : inProgress
              ? "Check draft PR"
              : "Create draft PR"}
      </Button>
      {error ? (
        <p role="alert" className="note text-destructive">
          {error === "GITHUB_WRITE_DENIED"
            ? "GitHub denied the push. Give the backend GitHub token Contents and Pull requests write access to this repository, then retry."
            : `Could not create draft PR: ${error}`}
        </p>
      ) : inProgress ? (
        <p role="status" className="note">
          Draft PR publishing is in progress.
        </p>
      ) : null}
    </div>
  );
}
