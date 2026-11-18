"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/request";
import { type Task } from "@/lib/tasks";

export type Session = {
  turns: Pick<Task, "id" | "instruction" | "status">[];
  messages: { id: string; role: "user" | "assistant"; body: string }[];
};

export function TaskSession({
  id,
  session,
  refresh,
  select,
}: {
  id: string;
  session: Session;
  refresh: () => void;
  select: (id: string) => void;
}) {
  const [body, setBody] = useState("");
  const [key, setKey] = useState<string>();
  const url = `/api/tasks/${id}/session`;
  const send = useMutation({
    mutationFn: async () => {
      const messageId = key ?? crypto.randomUUID();
      setKey(messageId);
      return request<{ id: string }>(url, {
        method: "POST",
        body: JSON.stringify({ body, messageId }),
      });
    },
    onSuccess: () => {
      setBody("");
      setKey(undefined);
      refresh();
    },
  });
  return (
    <section className="mb-6 space-y-3" aria-label="Session">
      {session.turns.length > 1 && (
        <details>
          <summary>Run history</summary>
          {session.turns.map((t, i) => (
            <Button key={t.id} onClick={() => select(t.id)}>
              Run {i + 1} · {t.status}
            </Button>
          ))}
        </details>
      )}
      {session.messages.map((m) => (
        <p className="whitespace-pre-wrap" key={m.id}>
          <strong>{m.role === "user" ? "You" : "Codex"}</strong> {m.body}
        </p>
      ))}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim() && !send.isPending) send.mutate();
        }}
      >
        <label className="block" htmlFor="session-message">
          Message Codex
        </label>
        <textarea
          id="session-message"
          className="w-full rounded-md border border-border p-2"
          maxLength={8000}
          disabled={send.isPending}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setKey(undefined);
          }}
        />
        <Button type="submit" disabled={!body.trim() || send.isPending}>
          Send
        </Button>
        {send.error && <p role="alert">{send.error.message}</p>}
      </form>
    </section>
  );
}
