import { Octokit } from "octokit";

export function createGitHubClient(options: {
  token?: string | undefined;
  timeout: number;
  signal?: AbortSignal;
}) {
  const github = new Octokit({
    ...(options.token ? { auth: options.token } : {}),
    request: { timeout: options.timeout, ...(options.signal ? { signal: options.signal } : {}) },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  github.hook.before("request", (request) => {
    request.headers["x-github-api-version"] = "2026-03-10";
  });
  return github;
}
