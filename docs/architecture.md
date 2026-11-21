# Architecture

The monorepo contains a Next.js web app, an API, a worker, Postgres, and Redis.
It uses one shared GitHub identity for a trusted workspace.
The web app proxies requests to the API using an HTTP-only session cookie.
It does not include a GitHub App or webhook endpoint.

## Task execution

1. The API checks the API token. It stores the task and an outbox record in Postgres.
2. The dispatcher sends the task ID to BullMQ through Redis.
3. The worker reads the GitHub issue. It records the source commit and branch.
4. The worker creates the selected sandbox and loads the repository. Private repositories use a Git bundle prepared by the backend.
5. Towline starts one Codex thread in the checkout. The worker relays messages and persists Codex replies as they arrive. Git and gh handle commits, pushes, and draft PR creation inside the sandbox.
6. Between turns the worker keeps the sandbox lease alive. Follow-ups use the same Towline process. The browser can disconnect and reopen the transcript.
7. Settle closes message intake and releases the sandbox, including during active work. A queued session can be settled before allocation.

## Sandbox providers

`apps/backend/src/sandbox/contracts.ts` defines `SandboxProvider`: a task ID produces an isolated
`Sandbox` with command execution, file transfer, public Git cloning, and disposal.
Command timeouts use seconds; nonzero exits are returned, while transport failures
reject. Disposal must stop running commands, be safe after success, and allow retries
after failure. Providers must enforce a bounded lifetime if backend cleanup fails.
The shared runtime requires Linux on Linux amd64 with sh, git, Node/npm, curl, tar, and sha256sum.

`apps/backend/src/sandbox/repository.ts` wraps any provider with private repository bundle loading
and the shared Codex runtime. The worker configures GitHub CLI authentication in the sandbox. Provider
adapters do not own prompts, patch collection, or execution error classification.

The worker composes this wrapper with `createSandboxProvider(config)`.
`SANDBOX_PROVIDER` selects the provider; only the selected provider requires its API key.
See [supported sandbox providers](supported-providers.md) for configuration, default resources, and provider-specific notes.

To add a provider, implement `SandboxProvider` and wire its factory
and credential validation in the worker/config, then document it in
[supported sandbox providers](supported-providers.md). No task or agent changes are needed.
Provider selection is per worker; there is no per-task selector or automatic failover.

## Failure and cleanup

Cleanup runs after success and failure.
A cleanup failure does not restart a completed task.
If sandbox deletion fails, the worker retains the sandbox ID.
A rolling thirty-minute provider lease bounds orphaned sandboxes after worker failure.
Each open session occupies a worker slot. Provider outages, plan limits and worker loss can end a session.
Browser disconnects do not end it. The default active-turn timeout is twenty minutes.

The deployment uses a shared GitHub identity. Restrict its token to trusted repositories.
The agent receives OpenAI and GitHub access. See the [setup instructions](../README.md#setup)
for the optional Daytona secret mount and token permissions.

## Code structure

The API and worker share one backend workspace. `apps/web` owns the Next.js
interface and server proxy routes. Both apps use the root Bun lockfile.

- `apps/backend/src/api`: HTTP requests and authentication.
- `apps/backend/src/worker`: job execution.
- `apps/backend/src/queue`: queue connections and task dispatch.
- `apps/backend/src/tasks`: task state and message delivery.
- `apps/backend/src/execution`: shared execution contracts, results, failures, and limits.
- `apps/backend/src/agent`: Codex prompt/output contract, runtime commands, and Towline event handling.
- `apps/backend/src/sandbox`: provider contract, provider adapters, shared repository loading, and sandbox leases.
- `apps/backend/src/github`: shared client policy, repository access and issues.
- `apps/backend/src/db` and `apps/backend/migrations`: database access and schema changes.

## Checks

Run `bun run check` for lint, type checks, offline tests, and the build.
Set `TEST_DATABASE_URL` to include Postgres integration tests.
These tests use isolated database schemas.
Live execution tests require paid OpenAI and selected sandbox provider access.

Local TypeScript imports omit file extensions. TypeScript uses bundler resolution,
and the build uses Bun to bundle each entry point for Node.js while keeping package
dependencies external. Development and migrations use tsx.
