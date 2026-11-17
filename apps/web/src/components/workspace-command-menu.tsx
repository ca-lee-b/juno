"use client";

import { request } from "@/lib/request";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Clock, Hash, Plus, Search, Settings } from "lucide-react";
import { Button } from "@/components/shadcn/button";
import {
  CommandMenu,
  CommandMenuDialog,
  CommandMenuInput,
  CommandMenuList,
  CommandMenuEmpty,
  CommandMenuFooter,
  CommandMenuShortcut,
  defaultCommandMenuFilter,
  type CommandMenuItemData,
} from "@/components/ui/command-menu";
import type { TaskListResponse } from "@/lib/tasks";

export function WorkspaceCommandMenu({
  connected,
  blocked,
  newTask,
  allTasks,
  lookup,
  connection,
  navigate,
}: {
  connected: boolean;
  blocked: boolean;
  newTask: () => void;
  allTasks: () => void;
  lookup: () => void;
  connection: () => void;
  navigate: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const tasks = useQuery({
    queryKey: ["tasks", "command-menu", search],
    enabled: open && connected,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ search, limit: "20", offset: "0" });
      return request<TaskListResponse>(`/api/tasks?${params}`, { signal });
    },
  });
  const actions = useMemo<CommandMenuItemData[]>(
    () =>
      [
        {
          value: "new",
          label: "New task",
          description: "Start from a GitHub issue",
          icon: Plus,
          shortcut: "n",
          onSelect: newTask,
        },
        {
          value: "all",
          label: "View all tasks",
          icon: ArrowRight,
          shortcut: "t",
          keywords: ["home", "overview"],
          onSelect: allTasks,
        },
        {
          value: "lookup",
          label: "Open a task by ID",
          icon: Hash,
          shortcut: "o",
          onSelect: lookup,
        },
        {
          value: "connection",
          label: "Connection settings",
          icon: Settings,
          shortcut: "c",
          keywords: ["API", "connect"],
          onSelect: connection,
        },
      ].map((item) => ({ ...item, group: "Quick actions" })),
    [newTask, allTasks, lookup, connection],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        blocked ||
        open ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [role='textbox'], [role='dialog']"))
      )
        return;
      const action = actions.find((item) => item.shortcut === event.key.toLowerCase());
      if (action) {
        event.preventDefault();
        action.onSelect?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, blocked, open]);

  const waiting = query.trim() !== search || tasks.isFetching;
  const items = useMemo<CommandMenuItemData[]>(
    () => [
      ...actions,
      ...(connected && query.trim() === search ? (tasks.data?.tasks ?? []) : []).map((task) => ({
        value: `task:${task.id}`,
        label: `${task.input.owner}/${task.input.repo} #${task.input.issueNumber}`,
        description: task.status,
        icon: Clock,
        group: search ? "Tasks" : "Recent tasks",
        action: "Open task",
        onSelect: () => navigate(task.id),
      })),
    ],
    [actions, connected, query, search, tasks.data, navigate],
  );

  return (
    <>
      <Button
        variant="outline"
        className="sm:min-w-44 [&>span.relative]:w-full [&>span.relative>span]:flex-1"
        aria-label="Search tasks and actions"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setOpen(true)}
      >
        <Search />
        <span className="flex items-center gap-3 text-left">
          <span className="hidden sm:inline">Search</span>
          <CommandMenuShortcut keys="mod+k" />
        </span>
      </Button>
      <CommandMenuDialog
        open={open}
        shortcut={blocked ? null : "mod+k"}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            setSearch("");
          }
        }}
        title="Search tasks and actions"
      >
        <CommandMenu
          items={items}
          query={query}
          onQueryChange={setQuery}
          filter={(item, value) =>
            item.value.startsWith("task:") || defaultCommandMenuFilter(item, value)
          }
        >
          <CommandMenuInput placeholder="Search tasks or run an action..." />
          <CommandMenuList>
            <CommandMenuEmpty>
              {waiting && connected ? "Searching tasks…" : "No matching tasks or actions."}
            </CommandMenuEmpty>
          </CommandMenuList>
          <p role="status" className="px-4 py-2 text-caption text-muted-foreground">
            {!connected
              ? "Connect your API to search tasks."
              : tasks.isError
                ? "Could not load tasks. Close and reopen to try again."
                : waiting
                  ? "Searching tasks…"
                  : tasks.data?.hasMore
                    ? "Showing the first 20 matches. Refine your search for more."
                    : !tasks.data?.tasks.length
                      ? "No tasks found."
                      : "Search by repository, issue number, or task ID."}
          </p>
          <CommandMenuFooter />
        </CommandMenu>
      </CommandMenuDialog>
    </>
  );
}
