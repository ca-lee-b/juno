# BYO PR Agent

BYO PR Agent is a backend service that turns GitHub issues into draft pull requests.
It uses OpenAI and Daytona to make code changes.
Review the changes before you create a draft pull request.

This project is an example for learning. Use it only with trusted repositories.
It uses a GitHub personal access token. It does not include a web interface.

## Setup

Install Bun 1.3.10, Node.js 24, Git, and Docker Compose.
Bun manages dependencies and scripts. Node.js runs the application.

```sh
bun install --frozen-lockfile
cp .env.example .env
```

Set these values in `.env`:

- `API_TOKEN`: a random token with at least 32 characters.
- `OPENAI_API_KEY`: a dedicated OpenAI project key.
- `DAYTONA_API_KEY`: your Daytona API key.
- `GITHUB_TOKEN`: a fine-grained personal access token for trusted repositories.

Give the GitHub token **Contents: write**, **Pull requests: write**, and **Issues: read** permissions to create draft pull requests.
Use the same token for the API and worker.

Start the database and Redis. Apply the database migrations. Then start the API.

```sh
docker compose up -d --wait
bun run db:migrate
bun run dev:api
```

Start the worker in another terminal.

```sh
bun run dev:worker
```

## Submit a task

Replace the repository owner, repository name, issue number, and API token.
Each task uses paid OpenAI and Daytona services.

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

Codex and repository commands run unattended in a Daytona sandbox.
They have network access and can read the OpenAI key.
GitHub, database, Redis, and Daytona credentials stay in the backend.

Codex CLI is pinned to version 0.166.0.
The default execution limit is ten minutes (`AGENT_TIMEOUT_MS=600000`).
The sandbox lifetime is thirty minutes. Existing `.env` values override the default execution limit.

After an upgrade, apply migrations and restart the API and worker.
Private submodules, Git LFS downloads, and later authenticated Git fetches in the sandbox are not supported.
