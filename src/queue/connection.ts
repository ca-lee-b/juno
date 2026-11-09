import { Redis } from "ioredis";

export const QUEUE_NAME = "issue-analysis";
export const JOB_ATTEMPTS = 3;

export function createRedis(url: string, role: "producer" | "worker") {
  return new Redis(url, {
    maxRetriesPerRequest: role === "worker" ? null : 1,
    enableOfflineQueue: role === "worker",
    connectTimeout: 5000,
  });
}
