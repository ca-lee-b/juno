import { expect, it, vi } from "vitest";
import { readWorkerConfig } from "@/config";
import { createSandboxProvider } from "@/sandbox/provider";

const mocks = vi.hoisted(() => ({ daytona: vi.fn(), freestyle: vi.fn(), e2b: vi.fn() }));
vi.mock("@/sandbox/daytona", () => ({ createDaytonaProvider: mocks.daytona }));
vi.mock("@/sandbox/freestyle", () => ({ createFreestyleProvider: mocks.freestyle }));
vi.mock("@/sandbox/e2b", () => ({ createE2BProvider: mocks.e2b }));
it.each(["daytona", "freestyle", "e2b"] as const)("selects only %s", (provider) => {
  vi.clearAllMocks();
  const config = readWorkerConfig({
    DATABASE_URL: "postgres://localhost/db",
    REDIS_URL: "redis://localhost",
    OPENAI_API_KEY: "test",
    SANDBOX_PROVIDER: provider,
    DAYTONA_API_KEY: "daytona",
    FREESTYLE_API_KEY: "freestyle",
    E2B_API_KEY: "e2b",
  });
  createSandboxProvider(config);
  expect(mocks[provider]).toHaveBeenCalledWith(config);
  for (const [name, factory] of Object.entries(mocks)) {
    if (name !== provider) expect(factory).not.toHaveBeenCalled();
  }
});
