import { readdir, readFile } from "node:fs/promises";
import type { Database } from "@/db/client";

export async function applyTestMigrations(db: Database) {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort())
    await db.query(await readFile(new URL(name, directory), "utf8"));
}
