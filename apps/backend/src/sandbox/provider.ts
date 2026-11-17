import type { WorkerConfig } from "@/config";
import { createDaytonaProvider } from "@/sandbox/daytona";
import { createE2BProvider } from "@/sandbox/e2b";
import { createFreestyleProvider } from "@/sandbox/freestyle";

export function createSandboxProvider(config: WorkerConfig) {
  const providers = {
    daytona: createDaytonaProvider,
    freestyle: createFreestyleProvider,
    e2b: createE2BProvider,
  };
  return providers[config.SANDBOX_PROVIDER](config);
}
