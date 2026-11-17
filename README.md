<p align="center">
  <img src="docs/juno_logo_wordmark.svg" alt="Juno" width="70%" />
</p>

# Juno

Juno is a web app and backend service that turns GitHub issues into draft pull requests.
It uses OpenAI and a [supported sandbox provider](docs/supported-providers.md) to make code changes.
Review the changes before you create a draft pull request.

This project is an example for learning. Use it only with trusted repositories.
It uses a GitHub personal access token. The Next.js web app connects to the API through authenticated server routes.

## Setup

Install Bun 1.3.10, Node.js 24, Git, and Docker Compose.
Bun manages dependencies and scripts. Node.js runs the application.

```sh
bun install --frozen-lockfile
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local
```

Set these values in `apps/backend/.env`:

- `API_TOKEN`: a random token with at least 32 characters.
- `OPENAI_API_KEY`: a dedicated OpenAI project key, used by Codex and the writeup stage.
- `OPENAI_CODEX_MODEL` / `OPENAI_CODEX_MODEL_EFFORT`: coding model and effort (defaults: `gpt-6-astra` / `medium`).
- `OPENAI_WRITEUP_MODEL` / `OPENAI_WRITEUP_MODEL_EFFORT`: operator summary and GitHub PR model and effort (defaults: `gpt-6-luna` / `high`).

- `SANDBOX_PROVIDER` and the selected provider’s API key: see [supported sandbox providers](docs/supported-providers.md) for values, default resources, and setup notes.
- `GITHUB_TOKEN`: a fine-grained personal access token for trusted repositories.

The writeup stage uses the OpenAI Responses API with the issue context, coding report, and patch. Each stage is bounded by `AGENT_TIMEOUT_MS`. Effort accepts `minimal`, `low`, `medium`, `high`, or `xhigh`; select a value supported by your chosen model. Replace the old `OPENAI_MODEL` variable with `OPENAI_CODEX_MODEL` when upgrading. Task `model` and `usage` continue to describe the coding stage only.

Give the GitHub token **Contents: write**, **Pull requests: write**, and **Issues: read** permissions to create draft pull requests.
Use the same token for the API and worker.

Start the database and Redis. Apply the database migrations. Then start the applications.

```sh
docker compose up -d --wait
bun run db:migrate
bun run dev
```

Open http://localhost:3001 and use **Connection** to enter your backend `API_TOKEN`.
The API runs on http://localhost:3000. Set `AGENT_API_URL` in `apps/web/.env.local` to override it.

`bun run dev` starts the API, worker, and web app together. If one process exits,
the others keep running.
Postgres and Redis are managed separately by Docker Compose. To run app processes
individually, use `bun run dev:api`, `bun run dev:worker`, and `bun run dev:web`.

The development commands use readable logs with local timestamps, colored levels in terminals,
and indented context and error stacks. PID and hostname are hidden to reduce noise.
Outside `NODE_ENV=development`, logs remain structured JSON. `LOG_LEVEL` still controls verbosity.

## Workspace structure

- `apps/backend`: API, worker, database migrations, and backend tests.
- `apps/web`: Next.js interface, authenticated proxy routes, assets, and web tests.
- `docs`: shared architecture and API documentation.
- Root `package.json` and `bun.lock`: Bun workspaces and a single dependency install.

Run commands from the repository root. `build`, `lint`, `typecheck`, `test`, and
`check` cover both apps. `check` also builds the web app before its API smoke test.
`test` runs backend tests and web unit tests; the production web smoke test runs
through `check` or `bun run --cwd apps/web test:smoke` after a web build.
`format` formats the backend with Biome; the web app retains its ESLint setup.
App-specific TypeScript versions and configurations remain independent. The root
TypeScript 5 dependency supports hoisted ESLint plugins; the backend explicitly
uses its own TypeScript 7 dependency.

Build the backend container from the repository root:

```sh
docker build -f apps/backend/Dockerfile -t byo-pr-agent .
```

The image defaults to the API; use `node dist/worker/main.js` for the worker or
`node dist/db/migrate.js` for migrations. Supply the backend environment at runtime.
The web app builds separately with `bun run --cwd apps/web build` and starts with
`bun run start:web`. See [web setup](apps/web/README.md) for deployment requirements.

## Submit a task

Replace the repository owner, repository name, issue number, and API token.
Each task uses paid OpenAI and sandbox provider services.

```sh
curl http://localhost:3000/v1/tasks \
  -H 'Authorization: Bearer YOUR_API_TOKEN' \
  -H 'Idempotency-Key: my-first-task' \
  -H 'Content-Type: application/json' \
  -d '{"owner":"OWNER","repo":"REPO","issueNumber":123}'
```

## Review changes and create a draft pull request

Use the returned task ID to check the task.

```sh
curl http://localhost:3000/v1/tasks/TASK_ID \
  -H 'Authorization: Bearer YOUR_API_TOKEN'
```

When the status is `completed`, review `result.summary` and `result.patch`.
This status confirms that the changes were saved. It does not confirm that tests passed.

After review, create the draft pull request.

```sh
curl -X POST http://localhost:3000/v1/tasks/TASK_ID/draft-pr \
  -H 'Authorization: Bearer YOUR_API_TOKEN'
```

This action does not run automatically. It does not run tests or merge changes.
See the [API reference](docs/api.md) for response codes and recovery steps.

## Reset an older local database

The initial schema replaces the pre-release migrations. Existing databases require a reset.
For the local Docker Compose setup, these commands delete all task data and queued jobs.

```sh
docker compose down -v
docker compose up -d --wait
bun run db:migrate
```

## Run checks

Run lint, type checks, tests, and the build.

```sh
bun run check
```

Set `TEST_DATABASE_URL` to include the database integration tests.

```sh
TEST_DATABASE_URL=postgres://agent:agent@localhost:5432/pr_agent bun run test
```

See the [architecture](docs/architecture.md) for the code structure and system limits.

## Access and execution limits

Use this service only with trusted repositories.
Anyone with the API token can access the configured GitHub data and submit tasks.

Codex and repository commands run unattended in the selected sandbox.
They have network access and can read the OpenAI key.
GitHub, database, Redis, and sandbox provider credentials stay in the backend.

Codex CLI is pinned to version 0.166.0.
Every sandbox installs `codebase-design` (mattpocock/skills) and `code-simplifier`
(getsentry/skills) before starting Codex, with no opt-in configuration. The skills CLI
and both source revisions are pinned in `apps/backend/src/agent/runtime.ts`. Skills are installed
globally inside the sandbox, outside the repository and generated patch. If either
installation fails, the task fails setup instead of running without its built-in skills.
The default execution limit is ten minutes (`AGENT_TIMEOUT_MS=600000`).
The sandbox lifetime is thirty minutes. Existing `.env` values override the default execution limit.

After an upgrade, apply migrations and restart the API and worker.
Private submodules, Git LFS downloads, and later authenticated Git fetches in the sandbox are not supported.
