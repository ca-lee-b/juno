import { expect, it, vi } from "vitest";
import { createGitHubClient } from "@/github/client";

it.each([undefined, "secret"])("applies shared policy to requests (token=%s)", async (token) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      new Response('{"login":"user"}', { headers: { "content-type": "application/json" } }),
    );
  const signal = new AbortController().signal;
  const github = createGitHubClient({ token, timeout: 15000, signal });
  await github.rest.users.getAuthenticated({ request: { fetch } });
  expect(fetch).toHaveBeenCalledOnce();
  const [url, options] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("https://api.github.com/user");
  const headers = new Headers(options?.headers);
  expect(headers.get("x-github-api-version")).toBe("2026-03-10");
  expect(headers.get("authorization")).toBe(token ? `token ${token}` : null);
  expect(options?.signal).toBe(signal);
});

it("does not retry failed GitHub requests", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    async () =>
      new Response('{"message":"Unavailable"}', {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  );
  await expect(
    createGitHubClient({ timeout: 10000 }).rest.users.getAuthenticated({ request: { fetch } }),
  ).rejects.toMatchObject({ status: 503 });
  expect(fetch).toHaveBeenCalledOnce();
});
