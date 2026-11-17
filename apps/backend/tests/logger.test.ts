import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

function logSample(nodeEnv: string) {
  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { createLogger } from "./src/logger.ts";
       const logger = createLogger("info");
       logger.debug("hidden debug");
       logger.info({ taskId: "task-123", token: "secret-value" }, "Task started");
       logger.error({ err: new Error("Sample failure") }, "Task failed");`,
    ],
    { env: { ...process.env, NODE_ENV: nodeEnv }, encoding: "utf8" },
  );
}

it("formats development logs with context, redaction, and error stacks", () => {
  const output = logSample("development");
  expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: Task started/);
  expect(output).toContain('taskId: "task-123"');
  expect(output).toContain("[Redacted]");
  expect(output).toContain("ERROR: Task failed");
  expect(output).toContain("Error: Sample failure");
  expect(output).toContain("at ");
  expect(output).not.toContain(String.fromCharCode(27));
  expect(output).not.toMatch(/secret-value|hidden debug|hostname|pid:/);
});

it.each(["production", ""])("keeps JSON logs outside development (%s)", (nodeEnv) => {
  const output = logSample(nodeEnv);
  const records = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    level: 30,
    msg: "Task started",
    taskId: "task-123",
    token: "[Redacted]",
  });
  expect(records[1].err.stack).toContain("Error: Sample failure");
});
