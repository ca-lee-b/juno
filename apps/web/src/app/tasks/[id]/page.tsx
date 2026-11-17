import { Workspace } from "@/components/workspace";
import { Suspense } from "react";

export default function TaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-muted-foreground">Loading task…</p>}>
      <TaskContent params={params} />
    </Suspense>
  );
}

async function TaskContent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Workspace id={id} />;
}
