import pino from "pino";

export function createLogger(level: string) {
  return pino({ level, redact: ["authorization", "token", "apiKey", "password"] });
}
