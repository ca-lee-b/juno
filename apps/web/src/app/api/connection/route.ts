import { cookies } from "next/headers";
import { backend, sameOrigin, TOKEN_COOKIE } from "@/lib/backend";

const probe = "/v1/tasks/00000000-0000-4000-8000-000000000000";
export async function GET() {
  const result = await backend(probe);
  return Response.json(
    { connected: result.status === 404 || result.ok },
    { headers: { "Cache-Control": "no-store" } },
  );
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (typeof body?.token !== "string" || !body.token.trim() || body.token.length > 2048)
    return Response.json({ error: "Enter a valid API token." }, { status: 400 });
  const token = body.token.trim();
  const result = await backend(probe, {}, token);
  if (result.status !== 404 && !result.ok)
    return Response.json(
      {
        error:
          result.status === 401
            ? "The API token was not accepted."
            : "Could not connect to the agent API.",
      },
      { status: result.status === 401 ? 401 : 502 },
    );
  (await cookies()).set(TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  });
  return Response.json({ connected: true });
}
export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  (await cookies()).delete(TOKEN_COOKIE);
  return Response.json({ connected: false });
}
