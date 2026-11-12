import type { WorkerConfig } from "@/config";
import { createDaytonaProvider } from "@/sandbox/daytona";
import { createFreestyleProvider } from "@/sandbox/freestyle";

export function createSandboxProvider(config: WorkerConfig) {
  return config.SANDBOX_PROVIDER === "freestyle"
    ? createFreestyleProvider(config)
    : createDaytonaProvider(config);
}
