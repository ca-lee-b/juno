import { serve } from "@hono/node-server";
import { createApp } from "@/api/app";
import { readApiConfig } from "@/config";
import { createDatabase } from "@/db/client";
import { createGitHubCatalog } from "@/github/catalog";
import { createLogger } from "@/logger";
import { createPublisher } from "@/tasks/publish";
import { TaskRepository } from "@/tasks/repository";

const config = readApiConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDatabase(config.DATABASE_URL);
db.on("error", () => logger.error("database connection failed"));
const app = createApp({
  tasks: new TaskRepository(db),
  publish: createPublisher(db, config.GITHUB_TOKEN),
  github: config.GITHUB_TOKEN ? createGitHubCatalog(config.GITHUB_TOKEN) : undefined,
  apiToken: config.API_TOKEN,
  logger,
  ready: async () => {
    await db.query("SELECT id FROM tasks LIMIT 0");
  },
});
const server = serve({ fetch: app.fetch, port: config.PORT }, () =>
  logger.info({ port: config.PORT }, "API listening"),
);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    server.close(() => {
      void db.end().finally(() => clearTimeout(deadline));
    });
  });
}
