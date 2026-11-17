"use client";

import Link from "next/link";
import { Hash, LayoutDashboard, Plus, Settings2, Terminal } from "lucide-react";
import { Button } from "@/components/shadcn/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/shadcn/sidebar";

export function AppSidebar({
  newTask,
  lookup,
  connection,
  connected,
}: {
  newTask: () => void;
  lookup: () => void;
  connection: () => void;
  connected: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  function action(callback: () => void) {
    setOpenMobile(false);
    callback();
  }
  return (
    <Sidebar>
      <SidebarHeader className="gap-4 border-b p-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm"><Terminal className="size-4" /></span>
              <span className="text-lg font-semibold tracking-tight">Juno</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <Button className="h-8 rounded-full shadow-sm" onClick={() => action(newTask)}>
          <Plus />
          New Task
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-3 py-5">
          <SidebarGroupLabel className="mb-2 text-[11px] text-muted-foreground">Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton className="rounded-lg border border-border bg-background shadow-sm" isActive render={<Link href="/" />}>
                  <LayoutDashboard />
                  <span>Dashboard</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => action(lookup)}>
                  <Hash />
                  <span>Open Task by ID</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => action(connection)}>
              <Settings2 />
              <span>Connection</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {connected ? "Connected" : "Offline"}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
