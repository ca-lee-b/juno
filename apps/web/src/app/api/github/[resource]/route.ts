import { backend } from "@/lib/backend";

export async function GET(request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params;
  if (!["repositories", "issues"].includes(resource))
    return Response.json({ error: "Not found" }, { status: 404 });
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const name of ["owner", "repo", "page"]) {
    const value = incoming.get(name);
    if (value !== null) query.set(name, value);
  }
  return backend(`/v1/github/${resource}?${query}`);
}
