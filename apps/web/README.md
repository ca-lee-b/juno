# BYO PR Agent client

A Next.js client for `../backend`, based on the Fluid workspace artboards in Wonder’s Paca file. Uses Fluid Functionalism components, Tailwind CSS, Motion, and TanStack Query.

## Run

```sh
bun install # from the repository root
cp apps/web/.env.example apps/web/.env.local
bun run dev:web
```

Open http://localhost:3001. Run the backend API and worker using the [root README](../../README.md). The API defaults to http://localhost:3000; set `AGENT_API_URL` in `.env.local` to change it.

Choose **Connection** and enter the backend’s `API_TOKEN`. The client uses an HTTP-only, SameSite=Strict session cookie and forwards authenticated requests through Next.js. No token is stored in local storage or included in client bundles. Production cookies require HTTPS. Local scripts bind to loopback; use HTTPS before hosting remotely.

Browse and search tasks, filter by status, or create a run with the **New task** button beside **Connection**. Open an existing task by UUID from the footer. Task URLs use `?task=UUID` and can be bookmarked. Polling stops at completed and failed states. Failed requests preserve their idempotency key when retried with the same input. Starting a task invokes paid backend services.

Task listing requires the backend’s authenticated `GET /v1/tasks` endpoint; restart a production API after rebuilding it. It supports status, repository/issue search, and paginated results. Completed tasks can be reviewed and published as draft PRs. There is no cancel endpoint. Summary text is rendered as plain text, with a byte-preserving UTF-8 patch download (including empty patches). Completion does not establish that tests passed.

## Checks

Run these from `apps/web` (or run `bun run check` from the repository root):

```sh
bun run lint
bun run typecheck
bun run build
node tests/api-smoke.mjs
node tests/patch.test.mjs
node tests/request.test.mjs
```

The smoke test starts the production app on port 31391 with an isolated mock API. It checks auth, origin protection, validation, task submission and retrieval without running an agent.

Design values live in `src/app/globals.css`: neutral surfaces, variable Inter typography, and IBM Plex Mono metadata. Summary is the default task view, including artifacts, run details, and usage. Changes shows a full-width diff workspace with file navigation, expandable files, line numbers, and addition/deletion highlights. Both tabs use the same task header. Mobile layouts stack sidebars and scroll wide tables and code inside their panels.

The New task dialog uses the existing Select components to browse repositories and open issues via authenticated Next.js proxy routes. Configure `GITHUB_TOKEN` on both backend processes; no GitHub token is entered in the client. Public and private repositories share the same flow. Loading, retry, empty, and load-more states are provided.
