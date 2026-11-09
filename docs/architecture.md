# Architecture

The service has an API, a worker, Postgres, and Redis.
It uses one shared GitHub identity for a trusted workspace.
It does not include a web interface, GitHub App, or webhook endpoint.

## Task execution

1. The API checks the API token. It stores the task and an outbox record in Postgres.
2. The dispatcher sends the task ID to BullMQ through Redis.
3. The worker reads the GitHub issue. It records the source commit and branch.
4. The worker creates a Daytona sandbox and loads the repository. Private repositories use a Git bundle prepared by the backend.
5. Codex edits files and runs commands in the sandbox.
6. The worker collects a binary Git patch against the source commit. It saves the patch, summary, model, prompt version, and available usage in one database operation.
7. The worker deletes the sandbox.

Tasks move from `queued` to `running`, then to `completed`.
A retry returns the task to `queued`. A final failure sets it to `failed`.

The `completed` status confirms that results were saved.
It does not confirm that tests passed. Read the summary for command results.

## Failure and cleanup

Cleanup runs after success and failure.
A cleanup failure does not restart a completed task.
If sandbox deletion fails, the worker retains the sandbox ID.
The sandbox also has a thirty-minute lifetime.

The default execution limit is ten minutes.
A transport timeout triggers sandbox deletion before a retry.
Failure codes identify setup, execution, timeout, result collection, and patch size errors.

## Draft pull requests

The API creates a draft pull request only when it receives an authenticated request to `POST /v1/tasks/:id/draft-pr`.
The request has a five-minute limit. There is no separate publication queue.
A Postgres advisory lock permits one publication attempt per task at a time.

The backend applies the saved patch to the index of a temporary bare Git repository.
It creates one commit with `sourceSha` as its parent.
This step does not run repository code.
The target branch must still contain `sourceSha`.

The service saves the branch, base, and commit before it writes to GitHub.
The push can create a branch, but it cannot overwrite one.
On a retry, the service checks for a matching branch and pull request before it creates anything.
It returns a saved pull request even if that pull request is closed or merged.

If the database connection is lost, the service stops remote work.
After an interrupted request, repeat the same POST to resume publication.
A failure preserves the completed task and saved patch.
Cleanup cannot invalidate a saved publication.

Publication supports the source repository only.
It does not rebase, merge, or update the reviewed commit when the base branch advances.
See the [API reference](api.md) for response codes and recovery steps.

## Credentials and access

The API token grants access to the shared GitHub identity.
There is no separate user or reviewer identity.
The service does not enforce a review approval step.

Only the dedicated OpenAI key enters the sandbox.
Repository code can read this key and access the network.
Use trusted repositories only.
GitHub, Postgres, Redis, and Daytona credentials stay in the backend.
See the [setup instructions](../README.md#setup) for GitHub token permissions.

## Code structure

- `src/api`: HTTP requests and authentication.
- `src/worker`: job execution.
- `src/queue`: queue connections and task dispatch.
- `src/tasks`: task state and publication control.
- `src/execution`: shared execution contracts, results, failures, and limits.
- `src/agent`: Codex prompt/output contract, runtime commands, and artifact collection.
- `src/sandbox`: Daytona lifecycle, repository loading, and patch-generation script.
- `src/github`: shared client policy, repository access, issues, and publication.
- `src/db` and `migrations`: database access and schema changes.

## Checks

Run `bun run check` for lint, type checks, offline tests, and the build.
Set `TEST_DATABASE_URL` to include Postgres integration tests.
These tests use isolated database schemas.
Live execution tests require paid OpenAI and Daytona access.

Local TypeScript imports omit file extensions. TypeScript uses bundler resolution,
and the build uses Bun to bundle each entry point for Node.js while keeping package
dependencies external. Development and migrations use tsx.
