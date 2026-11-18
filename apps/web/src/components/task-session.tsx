"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/request";
import { isTaskActive, type Task } from "@/lib/tasks";

type Session = {
  turns: Pick<Task, "id" | "instruction" | "status">[];
  messages: { id: string; role: "user" | "assistant"; body: string }[];
};

export function TaskSession({ task, navigate }: { task: Task; navigate: (id: string) => void }) {
  const [body, setBody] = useState("");
  const [key, setKey] = useState<string>();
  const url = `/api/tasks/${task.id}/session`;
  const active = isTaskActive(task.status);
  const session = useQuery({
    queryKey: ["session", task.id],
    queryFn: () => request<Session>(url),
    refetchInterval: active ? 1000 : 5000,
  });
  const send = useMutation({
    mutationFn: async () => {
      const turnId = active ? undefined : (key ?? crypto.randomUUID());
      setKey(turnId);
      return request<{ id: string }>(url, {
        method: "POST",
        body: JSON.stringify({ body, turnId }),
      });
    },
    onSuccess: async ({ id }) => {
      setBody("");
      setKey(undefined);
      if (id !== task.id) navigate(id);
      else await session.refetch();
    },
  });
  const turns = session.data?.turns ?? [];
  const otherActive = turns.find((t) => t.id !== task.id && isTaskActive(t.status));
  return (
    <section className="mb-6 space-y-3" aria-label="Session">
      {turns.length > 1 && (
        <nav aria-label="Run history" className="flex flex-wrap gap-3">
          {turns.map((t, i) => (
            <Link
              className="underline"
              key={t.id}
              href={`/tasks/${t.id}`}
              onNavigate={(event) => {
                event.preventDefault();
                navigate(t.id);
              }}
              aria-current={t.id === task.id ? "page" : undefined}
            >
              Run {i + 1} · {t.status}
            </Link>
          ))}
        </nav>
      )}
      {task.instruction && (
        <p className="whitespace-pre-wrap">
          <strong>You</strong> {task.instruction}
        </p>
      )}
      {session.data?.messages.map((m) => (
        <p className="whitespace-pre-wrap" key={m.id}>
          <strong>{m.role === "user" ? "You" : "Codex"}</strong> {m.body}
        </p>
      ))}
      {(active || task.publication?.prUrl) && !otherActive && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim() && !send.isPending) send.mutate();
          }}
        >
          <label className="block" htmlFor="session-message">
            {active ? "Message Codex" : "Follow up on this PR"}
          </label>
          <textarea
            id="session-message"
            className="w-full rounded-md border border-border p-2"
            maxLength={8000}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setKey(undefined);
            }}
          />
          <Button type="submit" disabled={!body.trim() || send.isPending}>
            {active ? "Send" : "Start follow-up"}
          </Button>
          {send.error && <p role="alert">{send.error.message}</p>}
        </form>
      )}
    </section>
  );
}
