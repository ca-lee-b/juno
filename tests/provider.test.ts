import { expect, it, vi } from "vitest";
import { readWorkerConfig } from "@/config";
import { createSandboxProvider } from "@/sandbox/provider";

const mocks = vi.hoisted(() => ({ daytona: vi.fn(), freestyle: vi.fn() }));
vi.mock("@/sandbox/daytona", () => ({ createDaytonaProvider: mocks.daytona }));
vi.mock("@/sandbox/freestyle", () => ({ createFreestyleProvider: mocks.freestyle }));
it.each(["daytona", "freestyle"] as const)("selects only %s", (provider) => {
  vi.clearAllMocks();
  const config = readWorkerConfig({
    DATABASE_URL: "postgres://localhost/db",
    REDIS_URL: "redis://localhost",
    OPENAI_API_KEY: "test",
    SANDBOX_PROVIDER: provider,
    DAYTONA_API_KEY: "daytona",
    FREESTYLE_API_KEY: "freestyle",
  });
  createSandboxProvider(config);
  expect(mocks[provider]).toHaveBeenCalledWith(config);
  expect(mocks[provider === "daytona" ? "freestyle" : "daytona"]).not.toHaveBeenCalled();
});
