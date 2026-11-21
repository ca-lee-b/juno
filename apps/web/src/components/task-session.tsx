"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/shadcn/input-group";
import { request } from "@/lib/request";
import { MarkdownSummary } from "@/components/markdown-summary";
import { Button } from "@/components/shadcn/button";
import { isTaskActive, type Task } from "@/lib/tasks";

export type Session = {
  turns: Pick<Task, "id" | "instruction" | "status">[];
  messages: { id: string; role: "user" | "assistant"; body: string }[];
};

export function TaskSession({
  id,
  session,
  task,
  refresh,
}: {
  id: string;
  session: Session;
  task: Task;
  refresh: () => void;
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
  const settle = useMutation({
    mutationFn: () => request(`/api/tasks/${id}/settle`, { method: "POST" }),
    onSuccess: refresh,
  });
  const settling = task.settleRequested || settle.isSuccess;
  const open = isTaskActive(task.status) && !settling;
  return (
    <section className="mb-6 space-y-3" aria-label="Session">
      {session.messages.map((m) => (
        <article key={m.id} className="min-w-0">
          <strong className="text-sm">{m.role === "user" ? "You" : "Codex"}</strong>
          {m.role === "assistant" ? (
            <MarkdownSummary>{m.body}</MarkdownSummary>
          ) : (
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
          )}
        </article>
      ))}
      {task.liveLost && task.status === "running" && <p role="status">Reconnecting to Codex…</p>}
      {task.status === "queued" && <p role="status">Waiting for a worker…</p>}
      {open && task.status === "running" && !task.waitingForMessage && !task.liveLost && (
        <p role="status">Codex is working…</p>
      )}
      {task.status === "failed" && (
        <p role="alert">
          {task.errorCode === "CLEANUP_FAILED"
            ? "Sandbox release failed. The provider lease will expire."
            : `Codex stopped (${task.errorCode}).`}{" "}
        </p>
      )}
      {settling && task.status !== "failed" && (
        <p role="status">{isTaskActive(task.status) ? "Settling session…" : "Session settled"}</p>
      )}
      {open && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim() && !send.isPending) send.mutate();
          }}
        >
          <InputGroup className="rounded-2xl bg-background shadow-sm">
            <InputGroupTextarea
              aria-label="Message Codex"
              placeholder="Message Codex…"
              className="min-h-16 max-h-48 resize-none px-4 pt-3 text-sm"
              rows={2}
              maxLength={8000}
              disabled={send.isPending}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setKey(undefined);
                send.reset();
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <InputGroupAddon align="block-end" className="justify-end px-2.5 pb-2.5">
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                className="size-8! rounded-full!"
                aria-label={send.isPending ? "Sending message" : "Send message"}
                aria-keyshortcuts="Meta+Enter Control+Enter"
                disabled={!body.trim() || send.isPending}
              >
                {send.isPending ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {send.error && <p role="alert">{send.error.message}</p>}
        </form>
      )}
      {open && (
        <Button
          variant="link"
          size="sm"
          disabled={settle.isPending}
          onClick={() => settle.mutate()}
        >
          Settle
        </Button>
      )}
      {settle.error && <p role="alert">{settle.error.message}</p>}
      {task.publication?.prUrl && <a href={task.publication.prUrl}>View pull request</a>}
    </section>
  );
}
