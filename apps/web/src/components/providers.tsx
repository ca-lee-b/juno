"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { FluidRoot } from "@/components/fluid-root";
import { MotionConfig } from "motion/react";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, retry: 1 }, mutations: { retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <FluidRoot>{children}</FluidRoot>
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
