"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { spring } from "@/lib/springs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsItem } from "@/components/ui/tabs";
import { request } from "@/lib/request";
import { parsePatch } from "@/lib/patch";
import { estimateModelCost, formatModelCost } from "@/lib/model-cost";
import { IssueFields } from "@/components/issue-picker";
import { TaskList } from "@/components/task-list";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/shadcn/sidebar";
import { Separator } from "@/components/shadcn/separator";
import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
} from "@ui-sdk/react/drawer";
import { WorkspaceCommandMenu } from "@/components/workspace-command-menu";
import { DraftPrAction } from "@/components/draft-pr-action";
import { TaskSession } from "@/components/task-session";
import { TaskDiff } from "@/components/task-diff";
import { MarkdownSummary } from "@/components/markdown-summary";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { InputGroup, InputField } from "@/components/ui/input-group";
import {
  ArrowRight,
  Copy,
  Download,
  ExternalLink,
  Info,
  CircleAlert,
  Check,
  X,
} from "lucide-react";
import { z } from "zod";
import { isTaskActive, taskInputSchema, type Task, type TaskInput } from "@/lib/tasks";

function runDurationLabel(task: Task) {
  if (task.status === "queued") return "Waiting to run";
  if (task.status === "running") return "Run in progress";
  const elapsed = new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "Duration unavailable";
  const seconds = Math.floor(elapsed / 1000);
  return `Duration: ${Math.floor(seconds / 60)}m ${seconds % 60}s (including queue time)`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState("");
  return (
    <Button
      variant="ghost"
      size={message ? "compact" : "icon-compact"}
      aria-label={label}
      title={message || label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setMessage("Copied");
        } catch {
          setMessage("Could not copy");
        }
      }}
    >
      {message ? <span role="status">{message}</span> : <Copy size={14} />}
    </Button>
  );
}
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
      <DialogContent size="lg">
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
  const task = useQuery({
    queryKey: ["task", id],
    queryFn: ({ signal }) =>
      request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}`, { signal }).then(
        (r) => r.task,
      ),
    enabled: !!id && !!connection.data?.connected,
    refetchInterval: (query) =>
      query.state.data &&
      (isTaskActive(query.state.data.status) ||
        query.state.data.publication?.status === "in_progress")
        ? 2500
        : false,
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
      <Drawer
        side="right"
        preventEdgeSwipe
        open={!!id && !newTaskOpen && !connectionOpen && !lookupOpen}
        onOpenChange={(open) => {
          if (!open) navigate("");
        }}
      >
        <DrawerBackdrop className="bg-black/30" />
        <DrawerContent initialFocus="content" className="issue-drawer">
          <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
            <DrawerTitle className="text-caption font-medium text-muted-foreground">
              Issue Brief
            </DrawerTitle>
            <DrawerClose aria-label="Close issue brief" className="issue-close">
              <X size={18} aria-hidden />
            </DrawerClose>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {!connection.data?.connected ? (
              <div className="p-8 space-y-4">
                <p>Connect your server to open this task.</p>
                <Button onClick={() => setConnectionOpen(true)}>Connect API</Button>
              </div>
            ) : task.isPending ? (
              <p role="status" className="p-8">
                Loading task…
              </p>
            ) : task.error ? (
              <div role="alert" className="p-8 space-y-4">
                <p>{task.error.message}</p>
                <Button onClick={() => task.refetch()}>Try Again</Button>
              </div>
            ) : (
              task.data && <TaskView key={task.data.id} task={task.data} newTask={newTask} navigate={navigate} />
            )}
          </div>
        </DrawerContent>
      </Drawer>
      <Dialog open={newTaskOpen && !connectionOpen} onOpenChange={setNewTaskOpen}>
        <DialogContent size="lg" className="p-0">
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
                Starting a task uses your configured OpenAI and Daytona accounts and may incur
                charges.
              </p>
              {error && (
                <p role="alert" className="note text-destructive">
                  {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-border p-7">
              <Button type="button" variant="tertiary" onClick={() => setNewTaskOpen(false)}>
                Cancel
              </Button>
              {connection.data?.connected ? (
                <Button type="submit" loading={create.isPending} trailingIcon={ArrowRight}>
                  Start task
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
            <InputGroup className="w-full">
              <InputField
                index={0}
                label="API token"
                type="password"
                autoComplete="off"
                required
                value={token}
                onChange={setToken}
              />
            </InputGroup>
            {(connect.error || disconnect.error) && (
              <p role="alert" className="note">
                {connect.error?.message || disconnect.error?.message}
              </p>
            )}
            <div className="flex justify-between">
              <Button type="submit" variant="primary" loading={connect.isPending}>
                {connect.isPending ? "Connecting…" : "Connect"}
              </Button>
              {connection.data?.connected && (
                <Button
                  variant="tertiary"
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
            <InputGroup className="w-full">
              <InputField
                index={0}
                label="Task ID"
                required
                value={lookup}
                onChange={setLookup}
                placeholder="Paste the full task ID"
              />
            </InputGroup>
            {lookupError && (
              <p role="alert" className="note">
                {lookupError}
              </p>
            )}
            <Button type="submit" variant="primary" trailingIcon={ArrowRight}>
              Open task
            </Button>
          </form>
        </Modal>
      }
    </SidebarProvider>
  );
}

function TaskView({ task, newTask, navigate }: { task: Task; navigate:(id:string)=>void; newTask: (input?: TaskInput) => void }) {
  const [diffOpen, setDiffOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const [hasShownResult, setHasShownResult] = useState(Boolean(task.result));
  const active = isTaskActive(task.status);
  const title =
    task.status === "completed"
      ? "Ready for Review"
      : task.status === "failed"
        ? "Run Failed"
        : task.status === "queued"
          ? "Task Queued"
          : "Agent at Work";
  function download() {
    if (!task.result) return;
    const url = URL.createObjectURL(
      new Blob([task.result.patch], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "changes.patch";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const files = parsePatch(task.result?.patch || "");
  return (
    <div className="wrap-anywhere">
      <div className="p-5 sm:p-8">
        <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div>
            <a
              className="mb-2.5 flex flex-wrap items-center gap-2 text-body text-muted-foreground break-all"
              href={`https://github.com/${task.input.owner}/${task.input.repo}/issues/${task.input.issueNumber}`}
              target="_blank"
              rel="noreferrer"
            >
              {task.input.owner} / {task.input.repo}{" "}
              <span className="text-foreground">#{task.input.issueNumber}</span>
              <ExternalLink size={13} />
            </a>
            <h1 className="text-3xl font-semibold tracking-tight">
              Issue #{task.input.issueNumber}
            </h1>
            <p className="mt-2 text-body text-muted-foreground">{title}</p>
          </div>
          <Badge
            role="status"
            color={
              task.status === "completed" ? "green" : task.status === "failed" ? "red" : "gray"
            }
          >
            <span className="inline-grid">
              <AnimatePresence initial={false}>
                <motion.span
                  key={task.status}
                  className="col-start-1 row-start-1 inline-flex items-center gap-2 capitalize"
                  initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: reduceMotion ? 0 : -4, transition: spring.fast.exit }}
                  transition={spring.moderate}
                >
                  {task.status === "completed" && <Check size={14} aria-hidden />}
                  {task.status}
                </motion.span>
              </AnimatePresence>
            </span>
          </Badge>
        </div>
        <ol aria-label="Run progress" className="mb-8 grid grid-cols-3 gap-3">
          {["Queued", "Working", task.status === "failed" ? "Failed" : "Ready"].map(
            (phase, index) => {
              const current = task.status === "queued" ? 0 : task.status === "running" ? 1 : 2;
              return (
                <li
                  key={index}
                  aria-current={current === index ? "step" : undefined}
                  className="space-y-2"
                >
                  <div
                    className={`h-1 rounded-full ${index <= current ? (task.status === "failed" && index === 2 ? "bg-red-600" : "bg-foreground") : "bg-border"}`}
                  />
                  <span
                    className={`text-caption ${index === current ? "font-medium" : "text-muted-foreground"}`}
                  >
                    {phase}
                  </span>
                </li>
              );
            },
          )}
        </ol>
        <TaskSession key={task.id} task={task} navigate={navigate} />
        {task.result && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-3">
            <Tabs
              aria-label="Task details"
              className="gap-2"
              selectedIndex={diffOpen ? 1 : 0}
              onSelect={(index) => setDiffOpen(index === 1)}
            >
              <TabsItem index={0} label="Summary" />
              <TabsItem
                index={1}
                label={`Changes · ${files.length} ${files.length === 1 ? "file" : "files"}`}
              />
            </Tabs>
          </div>
        )}
        {diffOpen ? (
          <TaskDiff task={task} />
        ) : (
          <div className="space-y-6">
            <div className="min-w-0 space-y-6">
              {active && (
                <section className="panel">
                  <div className="panel-title">
                    Task progress
                    <span className="text-caption font-normal text-muted-foreground">
                      Updates automatically
                    </span>
                  </div>
                  <div className="space-y-7 px-8 py-10">
                    <h2 className="text-title">
                      {task.status === "queued"
                        ? "Waiting for an available worker"
                        : "Working in an isolated sandbox"}
                    </h2>
                    <p className="text-body leading-7 text-muted-foreground">
                      {task.status === "queued"
                        ? "Your task has been saved. The agent will begin when a worker picks it up."
                        : "Codex can read the repository, edit files, and run commands. Your summary and patch will appear here when the run finishes."}
                    </p>
                  </div>
                </section>
              )}
              {task.status === "failed" && (
                <section className="panel">
                  <div className="panel-title">
                    Task ended
                    <code className="text-caption">{task.errorCode || "UNKNOWN_ERROR"}</code>
                  </div>
                  <div className="space-y-6 p-8">
                    <CircleAlert size={24} />
                    <h2 className="text-title">
                      {task.errorCode === "OUTPUT_FAILED"
                        ? "The result could not be collected"
                        : "The agent could not complete this run"}
                    </h2>
                    <p className="note">
                      There is no completed result for this task. Keep the task ID and error code to
                      investigate this run.
                    </p>
                    <div className="flex flex-wrap items-center gap-5">
                      <Button
                        variant="primary"
                        trailingIcon={ArrowRight}
                        onClick={() => newTask(task.input)}
                      >
                        Create new task
                      </Button>
                      <span className="note">Use the same issue to start again.</span>
                    </div>
                    <p className="note">Creating a new task starts a separate paid run.</p>
                  </div>
                </section>
              )}
              {task.result && (
                <>
                  <motion.section
                    className="issue-summary"
                    initial={hasShownResult ? false : { opacity: 0, y: reduceMotion ? 0 : 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    onAnimationComplete={() => setHasShownResult(true)}
                    transition={spring.moderate}
                  >
                    <div className="flex items-center justify-between border-b border-line pb-3 text-caption font-medium text-muted-foreground">
                      Agent Summary
                      <CopyButton value={task.result.summary} label="Copy summary" />
                    </div>
                    <MarkdownSummary>{task.result.summary}</MarkdownSummary>
                  </motion.section>
                  <p className="note flex gap-2.5">
                    <Info size={16} className="mt-1 shrink-0" />
                    Completed means artifacts were saved. Review the patch and validation before
                    applying.
                  </p>
                </>
              )}
              {task.status === "completed" && !task.result && (
                <p className="note">This task completed without readable artifacts.</p>
              )}
            </div>
            <section className="issue-summary border-t border-line pt-4">
              <div className="flex items-center justify-between border-b border-line pb-3 text-caption font-medium text-muted-foreground">
                Run Details
              </div>
              <aside className="space-y-5 pt-4">
                  <dl className="grid grid-cols-2 gap-5">
                    {[
                      ["Created", new Date(task.createdAt).toLocaleString()],
                      ["Attempt", String(task.attempts)],
                      ["Source commit", task.sourceSha?.slice(0, 7) || "Not available yet"],
                      ["Environment", "Daytona sandbox"],
                      ...(task.model ? [["Model", task.model]] : []),
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="mb-2 text-caption text-muted-foreground">{label}</dt>
                        <dd className="break-words text-body">
                          {label === "Created" ? (
                            <Tooltip content={runDurationLabel(task)}>
                              <time
                                dateTime={task.createdAt}
                                tabIndex={0}
                                className="cursor-default"
                              >
                                {value}
                              </time>
                            </Tooltip>
                          ) : (
                            value
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="border-t border-line pt-5">
                    <div className="mb-2 flex items-center justify-between text-caption text-muted-foreground">
                      Task ID
                      <CopyButton value={task.id} label="Copy task ID" />
                    </div>
                    <p className="break-all font-mono text-micro">{task.id}</p>
                  </div>
                  {task.result && (
                    <div className="space-y-3 border-t border-line pt-5">
                      <p className="note">
                        Apply in a clean checkout of source commit {task.sourceSha || "unavailable"}
                        .
                      </p>
                      <div className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3">
                        <code className="text-caption">git apply changes.patch</code>
                        <CopyButton value="git apply changes.patch" label="Copy apply command" />
                      </div>
                    </div>
                  )}
                  {task.usage && (
                    <div className="border-t border-line pt-5">
                      <h3 className="mb-4 text-subtitle">Usage &amp; cost</h3>
                      <div className="grid grid-cols-2 gap-4">
                        {[
                          ["Input", task.usage.inputTokens],
                          ["Output", task.usage.outputTokens],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <p className="mb-2 text-caption text-muted-foreground">{label}</p>
                            <p className="font-mono text-body">{value.toLocaleString()}</p>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 space-y-3 border-t border-line pt-4">
                        <div className="flex justify-between text-caption text-muted-foreground">
                          <span>Estimated model cost</span>
                          <span className="font-mono text-micro">USD</span>
                        </div>
                        <p className="font-mono text-lg">
                          {formatModelCost(estimateModelCost(task.model, task.usage))}
                        </p>
                        <p className="text-caption text-muted-foreground">
                          Based on input and output tokens at standard rates. Excludes cache
                          discounts, sandbox costs, and earlier attempts.
                        </p>
                      </div>
                    </div>
                  )}
                  {active && (
                    <p className="note">Runs can take a few minutes. You can leave this page.</p>
                  )}
              </aside>
            </section>
          </div>
        )}
      </div>
      {task.result && (
        <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-background px-5 py-4 sm:px-8">
          <Button variant="tertiary" leadingIcon={Download} onClick={download}>
            Download Patch
          </Button>
          <DraftPrAction task={task} />
        </footer>
      )}
    </div>
  );
}
