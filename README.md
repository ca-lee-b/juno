<p align="center">
  <img src="docs/juno_logo_wordmark.svg" alt="Juno" width="70%" />
</p>

# Juno

Juno is a web app and backend service that turns GitHub issues into draft pull requests.
It uses OpenAI and a [supported sandbox provider](docs/supported-providers.md) to make code changes.
Open an issue to start a Codex thread. Codex opens a draft PR and pushes requested changes to the same branch. Select **Settle** to release the sandbox.

This project is an example for learning. Use it only with trusted repositories.
It uses a GitHub personal access token. The Next.js web app connects to the API through authenticated server routes.

## Setup

Install Bun 1.3.10, Node.js 24, Go 1.23+, Git, and Docker Compose.
Bun manages dependencies and scripts. Node.js runs the application.

```sh
bun install --frozen-lockfile
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local
```

Set these values in `apps/backend/.env`:

- `API_TOKEN`: a random token with at least 32 characters.
- `OPENAI_API_KEY`: a dedicated OpenAI project key for Codex.
- `OPENAI_CODEX_MODEL` / `OPENAI_CODEX_MODEL_EFFORT`: coding model and effort (defaults: `gpt-6-astra` / `medium`).

- `SANDBOX_PROVIDER` and the selected provider’s API key: see [supported sandbox providers](docs/supported-providers.md) for values, default resources, and setup notes.
- `GITHUB_TOKEN`: a fine-grained personal access token for trusted repositories.

The worker uploads a pinned Linux amd64 Towline binary alongside Codex. Set `ENGINE_ENDPOINT` to a public WSS endpoint routed to this worker’s `ENGINE_PORT` (default 3010). For local development, tunnel that port. Each execution gets its own bearer token. The worker sends the prompt and interprets the engine’s sequenced Codex events as messages, questions, final text, and usage. The worker requires this endpoint at startup. The browser can disconnect while the worker keeps consuming events. If the engine transport drops, the stock engine can dial back and the worker can read the missing events from its journal.


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

## Continue or settle a session

Open the task in the web app to read the conversation, answer questions, and ask for changes.
The same Codex process and checkout stay available between replies, including while the browser is closed.
The agent includes the draft PR link in its reply. **Settle** ends the session, including any work in progress.
The transcript and GitHub PR remain available. The [API reference](docs/api.md) covers message delivery and settlement.

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
The worker supplies its configured GitHub token to Git and the GitHub CLI through the provider command environment. For Daytona, you can mount the same credential as a host-restricted organization secret by setting `DAYTONA_GITHUB_SECRET` to its name. Allow `api.github.com` and `github.com`. Database, Redis, and provider management credentials stay on the server.

Codex CLI is pinned to version 0.166.0.
Every sandbox installs `codebase-design` (mattpocock/skills) and `code-simplifier`
(getsentry/skills) before starting Codex, with no opt-in configuration. The skills CLI
and both source revisions are pinned in `apps/backend/src/agent/runtime.ts`. Skills are installed
globally inside the sandbox, outside the repository and generated patch. If either
installation fails, the task fails setup instead of running without its built-in skills.
The default execution limit is twenty minutes (`AGENT_TIMEOUT_MS=1200000`).
The worker renews a thirty-minute sandbox lease while the session is open. An idle thread uses one worker concurrency slot and may incur sandbox charges. Provider plan limits still apply.

After an upgrade, apply migrations and restart the API and worker.
The initial checkout omits submodule and Git LFS content.
