# API reference

Send `Authorization: Bearer YOUR_API_TOKEN` with each request.

## Tasks and draft pull requests

List tasks with authenticated `GET /v1/tasks` (`limit` 1–100, `offset`, optional `status`, and repository/issue `search`). The response includes task metadata, change counts, status counts for the search, and `hasMore`; full patches stay on individual task responses.

Read the issue conversation with `GET /v1/tasks/:id/session`. Send
`{ "messageId": "<uuid>", "body": "<text>" }` to `POST /v1/tasks/:id/session`.
Reuse the same message ID on retry. The worker sends idle follow-ups, steering messages,
and answers to pending questions to the same Codex process. Git and gh are available
inside the checkout. Codex commits and opens or updates the draft PR as part of the conversation.

`POST /v1/tasks/:id/settle` returns 202, closes the composer, and requests sandbox deletion.
Settle is idempotent. Later messages receive 409. You can read the transcript after settlement.
`GET /v1/tasks/:id` exposes the lifecycle, including `waitingForMessage`, `settleRequested`,
and the provider sandbox ID while allocated. A running session can be idle between messages.
Historical sessions retain their saved patches and publication metadata.

## Repository and issue picker

Configure the same `GITHUB_TOKEN` on API and worker, then restart both. Use a fine-grained personal access token restricted to trusted repositories, with **Contents: read**, **Issues: read**, and metadata access for browsing; publishing additionally needs **Contents: write** and **Pull requests: write**. Organization repositories may require token approval. The deployment shares one GitHub identity; anyone with its API token can browse its GitHub data and submit work. The worker supplies the configured GitHub credential to the agent. No GitHub App or webhook endpoint is required.

Use the repository and issue endpoints to build a selection interface. Both endpoints support pages. The issue endpoint excludes pull requests. The authenticated API endpoints are `GET /v1/github/repositories?page=1` and `GET /v1/github/issues?owner=OWNER&repo=REPO&page=1`. Responses contain `repositories` or `issues`, plus nullable `nextPage`. Each GitHub page contains up to 50 entries before PR filtering, so an empty issue page may still have a next page. Errors do not expose GitHub responses or credentials.

Private repositories are fetched by the worker using local Git into a temporary bare repository, exported as a bundle, and uploaded to the selected sandbox. The sandbox checks out the pinned commit with a credential-free origin URL. Temporary backend files are removed on success or failure.
