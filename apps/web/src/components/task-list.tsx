"use client";

import { request } from "@/lib/request";
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus, Search, Terminal } from "lucide-react";
import { Button } from "@/components/shadcn/button";
import { Badge } from "@/components/shadcn/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/shadcn/tabs";
import { Input } from "@/components/shadcn/input";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/shadcn/table";
import type { TaskListResponse, TaskStatus } from "@/lib/tasks";

const filters = [undefined, "running", "completed", "failed", "queued"] as const;
const labels = ["All Tasks", "Running", "Completed", "Failed", "Queued"];
const pageSize = 50;

function createdLabel(date: string) {
  const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(date).toLocaleDateString();
}

export function TaskList({
  connected,
  checking,
  connect,
  navigate,
  newTask,
}: {
  connected: boolean;
  checking: boolean;
  connect: () => void;
  navigate: (id: string) => void;
  newTask: () => void;
}) {
  const [filter, setFilter] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const status: TaskStatus | undefined = filters[filter];
  const list = useQuery({
    queryKey: ["tasks", status, query, offset],
    enabled: connected,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(offset),
        search: query,
      });
      if (status) params.set("status", status);
      return request<TaskListResponse>(`/api/tasks?${params}`, { signal });
    },
    refetchInterval: 5000,
  });
  const counts = list.data?.counts ?? {};
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const filteredTotal = status ? (counts[status] ?? 0) : total;
  // Previous query data keeps the table mounted during a fetch, but rows
  // from another status must never appear under the newly selected filter.
  const tasks = (list.data?.tasks ?? []).filter((task) => !status || task.status === status);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>
          <span className="rounded-full border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
            {connected && list.data ? total.toLocaleString() : "—"} total
          </span>
        </div>
        <Button size="sm" className="rounded-full shadow-sm" onClick={newTask}>
          <Plus />
          New Task
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-5 pb-5 text-xs text-muted-foreground" aria-label="Task overview">
        {[
          { label: "In progress", value: (counts.running ?? 0) + (counts.queued ?? 0), color: "bg-primary" },
          { label: "Completed", value: counts.completed ?? 0, color: "bg-success" },
          { label: "Failed", value: counts.failed ?? 0, color: "bg-destructive" },
        ].map((stat) => (
          <span key={stat.label} className="inline-flex items-center gap-2">
            <span aria-hidden className={`size-1.5 rounded-full ${stat.color}`} />
            {stat.label}
            <span className="font-medium text-foreground tabular-nums">{connected && list.data ? stat.value.toLocaleString() : "—"}</span>
          </span>
        ))}
      </div>
      <section aria-label="Workspace tasks" className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
          <Tabs
            value={String(filter)}
            onValueChange={(value) => {
              setFilter(Number(value));
              setOffset(0);
            }}
            className="min-w-0 max-w-full overflow-x-auto"
          >
            <TabsList aria-label="Task status" variant="line">
              {filters.map((status, index) => (
                <TabsTrigger key={index} value={String(index)}>
                  {labels[index]}
                  <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                    {status ? (counts[status] ?? 0) : total}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="relative w-full sm:w-56">
            <Search
              aria-hidden
              className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search tasks or repository"
              placeholder="Search tasks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 rounded-full bg-muted/30 pl-8 text-xs"
            />
          </div>
        </div>
        {checking ? (
          <p role="status" className="p-8 text-muted-foreground">
            Checking connection…
          </p>
        ) : !connected ? (
          <div className="flex min-h-72 flex-col items-center justify-center gap-4 p-6 text-center">
            <Terminal className="size-8 text-muted-foreground" />
            <h2 className="text-base font-medium">Connect Your Server</h2>
            <p className="text-sm text-muted-foreground">
              Connect to start tasks from GitHub issues.
            </p>
            <Button onClick={connect}>
              Connect API
              <ArrowRight />
            </Button>
          </div>
        ) : list.isPending ? (
          <p role="status" className="p-8 text-muted-foreground">
            Loading tasks…
          </p>
        ) : list.error ? (
          <div role="alert" className="space-y-3 p-6">
            <h2 className="font-medium">Could Not Load Tasks</h2>
            <p className="text-muted-foreground">{list.error.message}</p>
            <Button variant="outline" onClick={() => list.refetch()}>
              Try Again
            </Button>
          </div>
        ) : (
          <>
            <Table className="min-w-[640px]">
              <TableHeader className="bg-muted/35 [&_th]:h-9 [&_th]:text-xs [&_th]:font-normal [&_th]:text-muted-foreground">
                <TableRow>
                  <TableHead className="pl-4 sm:pl-6">Issue / Repository</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Changes</TableHead>
                  <TableHead>
                    <span className="sr-only">Open task</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody aria-busy={list.isFetching}>
                {tasks.map((task) => (
                  <TableRow
                    key={task.id}
                    className="cursor-pointer"
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("a")) navigate(task.id);
                    }}
                  >
                    <TableCell className="w-1/2 whitespace-normal py-3 pl-4 sm:pl-6">
                      <a
                        href={`/tasks/${encodeURIComponent(task.id)}`}
                        className="flex items-center gap-3 wrap-anywhere outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={(event) => {
                          if (
                            !event.metaKey &&
                            !event.ctrlKey &&
                            !event.shiftKey &&
                            !event.altKey &&
                            event.button === 0
                          ) {
                            event.preventDefault();
                            navigate(task.id);
                          }
                        }}
                      >
                        <span className="shrink-0 rounded-md border bg-muted/40 px-2 py-1 text-xs font-medium">Issue #{task.input.issueNumber}</span>
                        <span className="block text-muted-foreground">
                          {task.input.owner}/{task.input.repo}
                        </span>
                      </a>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={task.status === "failed" ? "destructive" : "secondary"}
                        className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs font-normal capitalize"
                      >
                        {task.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <time
                        dateTime={task.createdAt}
                        title={new Date(task.createdAt).toLocaleString()}
                      >
                        {createdLabel(task.createdAt)}
                      </time>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      {task.changes && (
                        <>
                          <span className="text-green-700">
                            +{task.changes.additions.toLocaleString()}
                          </span>
                          <span className="ml-3 text-red-700">
                            −{task.changes.deletions.toLocaleString()}
                          </span>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="pr-4 sm:pr-6">
                      <ArrowRight aria-hidden className="size-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!tasks.length && (
              <div className="flex min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
                <h2 className="font-medium">
                  {list.isPlaceholderData
                    ? "Loading Tasks…"
                    : query || status
                      ? "No Matching Tasks"
                      : "No Tasks Yet"}
                </h2>
                {!list.isPlaceholderData &&
                  (query || status ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearch("");
                        setQuery("");
                        setFilter(0);
                        setOffset(0);
                      }}
                    >
                      Clear Filters
                    </Button>
                  ) : (
                    <Button onClick={newTask}>
                      <Plus />
                      New Task
                    </Button>
                  ))}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground sm:px-6">
              <span>
                {filteredTotal.toLocaleString()} task{filteredTotal === 1 ? "" : "s"}
                {filteredTotal > pageSize
                  ? ` · ${offset + 1}–${Math.min(offset + pageSize, filteredTotal)}`
                  : ""}
              </span>
              {(offset > 0 || list.data?.hasMore) && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={offset === 0 || list.isPlaceholderData}
                    onClick={() => setOffset(Math.max(0, offset - pageSize))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!list.data?.hasMore || list.isPlaceholderData}
                    onClick={() => setOffset(offset + pageSize)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
