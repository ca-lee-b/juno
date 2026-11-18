import { z } from "zod";
import { backend, sameOrigin } from "@/lib/backend";

type Context = { params: Promise<{ id: string }> };

export async function GET(_: Request, context: Context) {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success)
    return Response.json({ error: "Invalid task ID" }, { status: 400 });
  return backend(`/v1/tasks/${id}/session`);
}

export async function POST(request: Request, context: Context) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success)
    return Response.json({ error: "Invalid task ID" }, { status: 400 });
  const message = z
    .object({ body: z.string().trim().min(1).max(8000), turnId: z.uuid().optional() })
    .safeParse(await request.json().catch(() => null));
  if (!message.success) return Response.json({ error: "Invalid message" }, { status: 400 });
  return backend(`/v1/tasks/${id}/session`, { method: "POST", body: JSON.stringify(message.data) });
}
