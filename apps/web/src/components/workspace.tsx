"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "@/lib/request";
import { IssueFields } from "@/components/issue-picker";
import { TaskList } from "@/components/task-list";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/shadcn/sidebar";
import { Separator } from "@/components/shadcn/separator";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/shadcn/sheet";
import { WorkspaceCommandMenu } from "@/components/workspace-command-menu";
import { TaskSession, type Session } from "@/components/task-session";
import { TaskDiff } from "@/components/task-diff";
import { Button } from "@/components/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import { ArrowRight, ExternalLink, Info, X } from "lucide-react";
import { z } from "zod";
import { isTaskActive, taskInputSchema, type Task, type TaskInput } from "@/lib/tasks";

function Modal({
  open,
  title,
  close,
  children,
}: {
  open: boolean;
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function Workspace({ id: initialId = "" }: { id?: string }) {
  const [id, setId] = useState(initialId);
  const client = useQueryClient();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [taskListKey, setTaskListKey] = useState(0);
  const [lookup, setLookup] = useState("");
  const [token, setToken] = useState("");
  const [input, setInput] = useState({ owner: "", repo: "", issueNumber: "" });
  const [creationError, setCreationError] = useState("");
  const [lookupError, setLookupError] = useState("");
  const key = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(location.search);
      setId(decodeURIComponent(location.pathname.match(/^\/tasks\/([^/]+)/)?.[1] || ""));
      setNewTaskOpen(params.get("view") === "new");
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function navigate(next: string) {
    window.history.pushState(null, "", next ? `/tasks/${encodeURIComponent(next)}` : "/");
    setId(next);
    setCreationError("");
  }
  const connection = useQuery({
    queryKey: ["connection"],
    queryFn: ({ signal }) => request<{ connected: boolean }>("/api/connection", { signal }),
    refetchInterval: 30000,
  });
  const connect = useMutation({
    mutationFn: () =>
      request("/api/connection", { method: "POST", body: JSON.stringify({ token }) }),
    onSuccess: () => {
      setToken("");
      setConnectionOpen(false);
      client.invalidateQueries();
    },
  });
  const disconnect = useMutation({
    mutationFn: () => request("/api/connection", { method: "DELETE" }),
    onSuccess: () => {
      client.clear();
      setConnectionOpen(false);
    },
  });
  const session = useQuery({
    queryKey: ["session", id],
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    queryFn: () => request<Session>(`/api/tasks/${id}/session`),
    enabled: !!id && !!connection.data?.connected,
    refetchInterval: 2000,
  });
  const turns = session.data?.turns ?? [];
  const root = turns[0]?.id;
  useEffect(() => {
    if (root && root !== id) {
      window.history.replaceState(null, "", `/tasks/${root}`);
    }
  }, [id, root]);
  const current = turns.at(-1)?.id ?? id;
  const task = useQuery({
    queryKey: ["task", current],
    queryFn: ({ signal }) =>
      request<{ task: Task }>(`/api/tasks/${encodeURIComponent(current)}`, { signal }).then(
        (r) => r.task,
      ),
    enabled: !!id && (!!connection.data?.connected || !!session.data),
    refetchInterval: (query) =>
      query.state.data && isTaskActive(query.state.data.status) ? 2500 : false,
  });
  const create = useMutation({
    mutationFn: (value: TaskInput) => {
      const payload = JSON.stringify(value);
      if (key.current?.payload !== payload) key.current = { payload, key: crypto.randomUUID() };
      return request<{ task: Task }>("/api/tasks", {
        method: "POST",
        headers: { "Idempotency-Key": key.current.key },
        body: payload,
      });
    },
    onSuccess: ({ task }) => {
      key.current = null;
      client.setQueryData(["task", task.id], task);
      setNewTaskOpen(false);
      client.invalidateQueries({ queryKey: ["tasks"] });
      navigate(task.id);
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = taskInputSchema.safeParse({
      ...input,
      owner: input.owner.trim(),
      repo: input.repo.trim(),
      issueNumber: Number(input.issueNumber),
    });
    if (!parsed.success) {
      setCreationError("Select a repository and an issue.");
      return;
    }
    setCreationError("");
    create.mutate(parsed.data);
  }
  function newTask(value?: TaskInput) {
    setInput(
      value
        ? { ...value, issueNumber: String(value.issueNumber) }
        : { owner: "", repo: "", issueNumber: "" },
    );
    create.reset();
    setCreationError("");
    setNewTaskOpen(true);
  }
  const error = creationError || create.error?.message;
  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-5 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-3 focus:text-foreground"
      >
        Skip to Content
      </a>
      <AppSidebar
        connected={!!connection.data?.connected}
        newTask={() => newTask()}
        lookup={() => {
          setLookupError("");
          setLookupOpen(true);
        }}
        connection={() => setConnectionOpen(true)}
      />
      <SidebarInset className="min-w-0">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
          <div className="flex items-center gap-3">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-4" />
            <span className="text-xs text-muted-foreground">
              Workspace <span className="mx-2 text-border">/</span>{" "}
              <span className="text-foreground">Dashboard</span>
            </span>
          </div>
          <WorkspaceCommandMenu
            connected={!!connection.data?.connected}
            blocked={!!id || newTaskOpen || connectionOpen || lookupOpen}
            newTask={() => newTask()}
            allTasks={() => {
              setTaskListKey((key) => key + 1);
              navigate("");
            }}
            lookup={() => {
              setLookupError("");
              setLookupOpen(true);
            }}
            connection={() => setConnectionOpen(true)}
            navigate={navigate}
          />
        </header>
        <div id="main-content" tabIndex={-1} className="min-w-0 flex-1">
          <TaskList
            key={taskListKey}
            connected={!!connection.data?.connected}
            checking={connection.isPending}
            connect={() => setConnectionOpen(true)}
            navigate={navigate}
            newTask={() => newTask()}
          />
        </div>
      </SidebarInset>
      <Sheet
        open={!!id && !newTaskOpen && !connectionOpen && !lookupOpen}
        onOpenChange={(open) => {
          if (!open) navigate("");
        }}
      >
        <SheetContent showCloseButton={false} className="issue-drawer w-full max-w-[1280px]!">
          <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
            <SheetTitle className="text-caption font-medium text-muted-foreground">
              {task.data?.issueTitle ||
                (task.data ? `Issue #${task.data.input.issueNumber}` : "Issue session")}
            </SheetTitle>
            <SheetClose
              aria-label="Close issue brief"
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <X size={18} aria-hidden />
            </SheetClose>
          </div>
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-y-auto px-5 py-4">
            {!connection.data?.connected ? (
              <Button onClick={() => setConnectionOpen(true)}>Connect API</Button>
            ) : session.error && !session.data ? (
              <p role="alert">{session.error.message}</p>
            ) : session.data && task.data ? (
              <>
                <a
                  className="mb-5 flex items-center gap-2 text-sm text-muted-foreground"
                  href={`https://github.com/${task.data.input.owner}/${task.data.input.repo}/issues/${task.data.input.issueNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {task.data.input.owner}/{task.data.input.repo} #{task.data.input.issueNumber}
                  <ExternalLink size={14} />
                </a>
                <TaskSession
                  key={id}
                  id={id}
                  session={session.data}
                  task={task.data}
                  refresh={() => {
                    void session.refetch();
                    void task.refetch();
                  }}
                />
                {task.data.result?.patch && (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm">View changes</summary>
                    <TaskDiff key={task.data.id} task={task.data} />
                  </details>
                )}
              </>
            ) : task.error ? (
              <p role="alert">{task.error.message}</p>
            ) : (
              <p role="status">Loading conversation…</p>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <Dialog open={newTaskOpen && !connectionOpen} onOpenChange={setNewTaskOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-lg">
          <DialogHeader className="border-b border-border p-7 mb-0">
            <DialogTitle>New Task</DialogTitle>
            <DialogDescription>
              Select a repository and an open issue for the agent to work on.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit}>
            <div className="space-y-6 p-7">
              <IssueFields
                input={input}
                setInput={setInput}
                connected={!!connection.data?.connected}
              />
              <p className="note flex gap-2">
                <Info size={16} className="shrink-0" />
                The sandbox stays running until you select Settle. Open sessions may incur charges.
              </p>
              {error && (
                <p role="alert" className="note text-destructive">
                  {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-border p-7">
              <Button type="button" variant="outline" onClick={() => setNewTaskOpen(false)}>
                Cancel
              </Button>
              {connection.data?.connected ? (
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? "Starting task…" : "Start task"}
                  <ArrowRight />
                </Button>
              ) : (
                <Button type="button" onClick={() => setConnectionOpen(true)}>
                  Connect API
                </Button>
              )}
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {
        <Modal
          open={connectionOpen}
          title="API connection"
          close={() => {
            setConnectionOpen(false);
            setToken("");
            connect.reset();
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              connect.mutate();
            }}
            className="space-y-5"
          >
            <p className="note">
              Connect with your backend API token. It is stored in an HTTP-only session cookie and
              is never saved in local storage.
            </p>
            <label className="grid gap-2">
              API token
              <Input
                type="password"
                autoComplete="off"
                required
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            {(connect.error || disconnect.error) && (
              <p role="alert" className="note">
                {connect.error?.message || disconnect.error?.message}
              </p>
            )}
            <div className="flex justify-between">
              <Button type="submit" disabled={connect.isPending}>
                {connect.isPending ? "Connecting…" : "Connect"}
              </Button>
              {connection.data?.connected && (
                <Button
                  variant="outline"
                  type="button"

                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </form>
        </Modal>
      }
      {
        <Modal open={lookupOpen} title="Open a task" close={() => setLookupOpen(false)}>
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!z.uuid().safeParse(lookup.trim()).success) {
                setLookupError("Enter a valid task UUID.");
                return;
              }
              navigate(lookup.trim());
              setLookupOpen(false);
            }}
          >
            <label className="grid gap-2">
              Task ID
              <Input
                required
                value={lookup}
                onChange={(event) => setLookup(event.target.value)}
                placeholder="Paste the full task ID"
              />
            </label>
            {lookupError && (
              <p role="alert" className="note">
                {lookupError}
              </p>
            )}
            <Button type="submit">
              Open task
              <ArrowRight />
            </Button>
          </form>
        </Modal>
      }
    </SidebarProvider>
  );
}
