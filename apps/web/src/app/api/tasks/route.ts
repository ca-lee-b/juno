import { backend, sameOrigin } from "@/lib/backend";
import { taskInputSchema } from "@/lib/tasks";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key))
    return Response.json({ error: "Invalid request key." }, { status: 400 });
  const input = taskInputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json(
      { error: "Enter a valid repository owner, name, and positive issue number." },
      { status: 400 },
    );
  return backend("/v1/tasks", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify(input.data),
  });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const name of ["limit", "offset", "status", "search"]) {
    const value = params.get(name);
    if (value !== null) query.set(name, value);
  }
  return backend(`/v1/tasks?${query}`);
}
