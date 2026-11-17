import { z } from "zod";
import { backend } from "@/lib/backend";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success)
    return Response.json({ error: "Enter a valid task ID." }, { status: 400 });
  return backend(`/v1/tasks/${id}`);
}
