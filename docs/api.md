# API reference

Send `Authorization: Bearer YOUR_API_TOKEN` with each request.

## Tasks and draft pull requests

List tasks with authenticated `GET /v1/tasks` (`limit` 1–100, `offset`, optional `status`, and repository/issue `search`). The response includes task metadata, change counts, status counts for the search, and `hasMore`; full patches stay on individual task responses.

Poll `GET /v1/tasks/:id` with the same bearer token. A `completed` task contains `result.summary`, `result.patch`, and available usage. Completion means artifacts were captured, not that tests passed. Submitting tasks invokes paid OpenAI and Daytona services.

A completed task can be explicitly published with authenticated `POST /v1/tasks/:id/draft-pr`. It returns the saved publication on repeats; publishing never runs automatically. Draft PR creation requires server-side `GITHUB_TOKEN` with **Contents: write**, **Pull requests: write**, and **Issues: read**. The API stores the publication and exposes it on task details and lists. It does not run tests, rebase, merge, publish forks, or sync subsequent changes.

After reviewing the saved patch and summary:

```sh
curl -X POST http://localhost:3000/v1/tasks/TASK_ID/draft-pr \
  -H 'Authorization: Bearer YOUR_API_TOKEN'
```

No body or idempotency header is needed: the completed task identifies the immutable reviewed patch. Responses are `201` for publication, `200` for an existing/recovered PR, or `202` with `status: "in_progress"` and `Retry-After` when another request holds the lock. A successful response contains `publication.prUrl`, `branch`, `branchUrl`, `baseBranch`, and `commitSha`. An existing PR is returned even after it is closed or merged.

Publishing runs within the request with a five-minute deadline. On a lost response or API restart, repeat the same POST to recover; there is no background publisher. `GET /v1/tasks/:id` shows the last persisted publication state, which can remain `in_progress` after a crash until that retry.

`409` reports an ineligible/empty task, invalid patch, diverged base, or branch/PR collision. `503` means GitHub publishing is unconfigured; `502` means an upstream operation failed. Check token permissions, repository rules and access before retrying a failed operation. Failure preserves the completed task and reviewed artifact. A branch already pushed is retained for recovery. Run migrations and restart API and worker before using this endpoint.

## Saved patches

The worker saves a binary-capable patch against `sourceSha`, including non-ignored new files, before deleting the sandbox. Patches over 5 MiB fail with `PATCH_TOO_LARGE`. Apply a downloaded patch to a clean checkout of `sourceSha` with `git apply changes.patch`. Empty patches are valid. Logs report safe stage codes and exit codes; raw provider errors and command logs are not exposed.

## Repository and issue picker

Configure the same `GITHUB_TOKEN` on API and worker, then restart both. Use a fine-grained personal access token restricted to trusted repositories, with **Contents: read**, **Issues: read**, and metadata access for browsing; publishing additionally needs **Contents: write** and **Pull requests: write**. Organization repositories may require token approval. The deployment shares one GitHub identity; anyone with its API token can browse its GitHub data and submit work. GitHub tokens remain server-side. No GitHub App or webhook endpoint is required.

Use the repository and issue endpoints to build a selection interface. Both endpoints support pages. The issue endpoint excludes pull requests. The authenticated API endpoints are `GET /v1/github/repositories?page=1` and `GET /v1/github/issues?owner=OWNER&repo=REPO&page=1`. Responses contain `repositories` or `issues`, plus nullable `nextPage`. Each GitHub page contains up to 50 entries before PR filtering, so an empty issue page may still have a next page. Errors do not expose GitHub responses or credentials.

Private repositories are fetched by the worker using local Git into a temporary bare repository, exported as a bundle, and uploaded to Daytona. The sandbox checks out the pinned commit with a credential-free origin URL. Temporary backend files are removed on success or failure. Private submodules, Git LFS downloads, and subsequent authenticated fetches inside the agent are not supported. The existing repository size limit still applies; full Git history is fetched to create a standalone bundle. Results remain saved patches and summaries until the explicit publishing action is requested.
