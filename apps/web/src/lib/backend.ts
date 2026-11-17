import { cookies } from "next/headers";

export const TOKEN_COOKIE = "byo-api-token";
export async function backend(
  path: string,
  init: RequestInit = {},
  token?: string,
  timeoutMs = 15000,
) {
  const credential = token ?? (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!credential)
    return Response.json({ error: "Connect your API to continue." }, { status: 401 });
  try {
    const response = await fetch(
      new URL(path, process.env.AGENT_API_URL || "http://localhost:3000"),
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...init.headers,
          Authorization: `Bearer ${credential}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      },
    );
    return new Response(await response.text(), {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Could not reach the agent API. Check the server connection and try again." },
      { status: 502 },
    );
  }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) && parsed.host === request.headers.get("host")
    );
  } catch {
    return false;
  }
}
