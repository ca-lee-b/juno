export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const data = await response.json().catch((error: unknown) => {
    if (init?.signal?.aborted) throw error;
    throw new Error("The server returned an unexpected response.");
  });
  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string" && data.error
        ? data.error
        : `Request failed (${response.status}).`,
    );
  }
  return data;
}
