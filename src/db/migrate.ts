import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@/db/client";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const pool = createDatabase(url);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(726314)");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
  const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
  for (const name of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const applied = await client.query("SELECT name FROM schema_migrations WHERE name = $1", [
      name,
    ]);
    if (applied.rows.length) continue;
    await client.query(await readFile(`${directory}/${name}`, "utf8"));
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    console.info(`Applied ${name}`);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
