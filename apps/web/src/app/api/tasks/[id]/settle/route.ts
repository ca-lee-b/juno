import { z } from "zod";
import { backend, sameOrigin } from "@/lib/backend";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success)
    return Response.json({ error: "Enter a valid task ID." }, { status: 400 });
  return backend(`/v1/tasks/${id}/settle`, { method: "POST" });
}
