import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    redact: ["authorization", "token", "apiKey", "password"],
    ...(process.env.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: Boolean(process.stdout.isTTY),
              translateTime: "SYS:HH:MM:ss.l",
              ignore: "pid,hostname",
            },
          },
        }
      : {}),
  });
}
