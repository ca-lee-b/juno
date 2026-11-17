import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { Logger } from "pino";
import { z } from "zod";
import type { GitHubCatalog } from "@/github/catalog";
import { taskInputSchema } from "@/tasks/input";
import type { createPublisher } from "@/tasks/publish";
import type { TaskRepository } from "@/tasks/repository";
import { IdempotencyConflict } from "@/tasks/types";

const repositorySchema = taskInputSchema.pick({ owner: true, repo: true });

type Dependencies = {
  github?: GitHubCatalog | undefined;
  tasks: Pick<TaskRepository, "create" | "get" | "list">;
  publish?: ReturnType<typeof createPublisher>;
  apiToken: string;
  ready: () => Promise<void>;
  logger: Logger;
};

export function createApp({ tasks, apiToken, ready, logger, github, publish }: Dependencies) {
  const app = new Hono();
  app.use(requestId());
  app.use(secureHeaders());
  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    logger.info(
      {
        requestId: c.get("requestId"),
        method: c.req.method,
        status: c.res.status,
        durationMs: Math.round(performance.now() - start),
      },
      "request",
    );
  });
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", async (c) => {
    try {
      await ready();
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });
  app.use("/v1/*", bearerAuth({ token: apiToken }));
  app.use(
    "/v1/*",
    bodyLimit({ maxSize: 16384, onError: (c) => c.json({ error: "Body too large" }, 413) }),
  );
  app.get("/v1/github/:resource{repositories|issues}", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!github)
      return c.json({ error: "Configure GITHUB_TOKEN on the server to browse repositories." }, 503);
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .safeParse(c.req.query("page") ?? 1);
    if (!page.success) return c.json({ error: "Invalid page" }, 400);
    try {
      if (c.req.param("resource") === "repositories")
        return c.json(await github.repositories(page.data));
      const input = repositorySchema.safeParse({
        owner: c.req.query("owner"),
        repo: c.req.query("repo"),
      });
      if (!input.success) return c.json({ error: "Invalid repository" }, 400);
      return c.json(await github.issues(input.data.owner, input.data.repo, page.data));
    } catch {
      return c.json(
        {
          error:
            "Could not load GitHub data. Check the server token, repository access, and GitHub rate limits.",
        },
        502,
      );
    }
  });

  app.post("/v1/tasks", async (c) => {
    const key = z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .safeParse(c.req.header("Idempotency-Key"));
    if (!key.success) return c.json({ error: "A valid Idempotency-Key header is required" }, 400);
    const input = taskInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json({ error: "Invalid task", details: input.error.flatten() }, 400);
    try {
      const { task, created } = await tasks.create(input.data, key.data);
      c.header("Location", `/v1/tasks/${task.id}`);
      return c.json({ task }, created ? 202 : 200);
    } catch (error) {
      if (error instanceof IdempotencyConflict)
        return c.json({ error: "Idempotency key reused with different input" }, 409);
      throw error;
    }
  });
  app.get("/v1/tasks", async (c) => {
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
        status: z.enum(["queued", "running", "completed", "failed"]).optional(),
        search: z.string().trim().max(200).default(""),
      })
      .safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid task list filters" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(await tasks.list(parsed.data));
  });
  app.post("/v1/tasks/:id/draft-pr", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid task ID" }, 400);
    if (!publish) return c.json({ error: "GitHub publishing is unavailable" }, 503);
    const task = await tasks.get(id.data);
    if (!task) return c.json({ error: "Task not found" }, 404);
    const result = await publish(task);
    const { httpStatus, ...body } = result;
    if (httpStatus === 202) c.header("Retry-After", "2");
    return c.json(body, httpStatus);
  });
  app.get("/v1/tasks/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid task ID" }, 400);
    const task = await tasks.get(id.data);
    return task ? c.json({ task }) : c.json({ error: "Task not found" }, 404);
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    // SDK errors may contain request headers. Never serialize them into API logs.
    logger.error({ requestId: c.get("requestId") }, "request failed");
    return c.json({ error: "Internal server error", requestId: c.get("requestId") }, 500);
  });
  return app;
}
