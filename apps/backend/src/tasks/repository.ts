import { randomUUID } from "node:crypto";
import type { Database } from "@/db/client";
import type { TaskInput } from "@/tasks/input";
import { IdempotencyConflict, type Task } from "@/tasks/types";

const columns = `id, session_id AS "sessionId", instruction, input, status, attempts, sandbox_id AS "sandboxId",
  source_sha AS "sourceSha", source_branch AS "sourceBranch", result, model, prompt_version AS "promptVersion", usage,
  error_code AS "errorCode", created_at AS "createdAt", updated_at AS "updatedAt",
  (SELECT jsonb_build_object(
    'status',p.status,'branch',p.branch,'baseBranch',p.base_branch,'commitSha',p.commit_sha,
    'branchUrl',p.branch_url,'prNumber',p.pr_number,'prUrl',p.pr_url,'error',p.error
  ) FROM task_publications p WHERE p.task_id=COALESCE(tasks.session_id,tasks.id)) AS publication`;

export class TaskRepository {
  constructor(private readonly db: Database) {}

  async create(input: TaskInput, key: string): Promise<{ task: Task; created: boolean }> {
    const normalized = {
      ...input,
      owner: input.owner.toLowerCase(),
      repo: input.repo.toLowerCase(),
    };
    const result = await this.db.query<Task>(
      `
      WITH inserted AS (
        INSERT INTO tasks (id, idempotency_key, input) VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING RETURNING *
      ), outbox AS (
        INSERT INTO task_outbox (task_id) SELECT id FROM inserted
      ) SELECT ${columns} FROM inserted AS tasks`,
      [randomUUID(), key, JSON.stringify(normalized)],
    );
    const inserted = result.rows[0];
    if (inserted) return { task: inserted, created: true };
    const existing = await this.db.query<Task>(
      `SELECT ${columns} FROM tasks WHERE idempotency_key = $1`,
      [key],
    );
    const task = existing.rows[0];
    if (!task) throw new Error("Idempotent task disappeared");
    if (
      task.input.owner !== normalized.owner ||
      task.input.repo !== normalized.repo ||
      task.input.issueNumber !== normalized.issueNumber
    )
      throw new IdempotencyConflict();
    return { task, created: false };
  }

  async get(id: string) {
    return (await this.db.query<Task>(`SELECT ${columns} FROM tasks WHERE id = $1`, [id])).rows[0];
  }

  async list(options: {
    limit: number;
    offset: number;
    status?: string | undefined;
    search: string;
  }) {
    const search = `%${options.search}%`;
    const filter = `((input->>'owner') || '/' || (input->>'repo') || ' #' || (input->>'issueNumber')) ILIKE $1`;
    const counts = await this.db.query<{ status: Task["status"]; count: number }>(
      `SELECT status, count(*)::int AS count FROM tasks WHERE session_id IS NULL AND ${filter} GROUP BY status`,
      [search],
    );
    const result = await this.db.query<Task>(
      `SELECT ${columns} FROM tasks WHERE session_id IS NULL AND ${filter} AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [search, options.status ?? null, options.limit + 1, options.offset],
    );
    return {
      tasks: result.rows.slice(0, options.limit).map((task) => {
        const lines = task.result?.patch.split("\n") ?? [];
        return {
          id: task.id,
          input: task.input,
          status: task.status,
          createdAt: task.createdAt,
          publication: task.publication,
          changes: task.result
            ? {
                additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
                  .length,
                deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---"))
                  .length,
              }
            : null,
        };
      }),
      counts: Object.fromEntries(counts.rows.map((row) => [row.status, row.count])),
      hasMore: result.rows.length > options.limit,
    };
  }

  async context(root: string) {
    return (
      await this.db.query<{ instruction: string | null; summary: string }>(
        `SELECT instruction,left(result->>'summary',2000) AS summary FROM tasks
      WHERE (id=$1 OR session_id=$1) AND status='completed' ORDER BY created_at DESC LIMIT 10`,
        [root],
      )
    ).rows.reverse();
  }

  async turns(root: string) {
    return (
      await this.db.query<Pick<Task, "id" | "instruction" | "status" | "createdAt">>(
        'SELECT id, instruction, status, created_at AS "createdAt" FROM tasks WHERE id=$1 OR session_id=$1 ORDER BY created_at,id',
        [root],
      )
    ).rows;
  }

  async followUp(root: string, instruction: string, id: string) {
    await this.db.query(
      `WITH added AS (
      INSERT INTO tasks(id,idempotency_key,input,session_id,instruction)
      SELECT $2::uuid,'turn-' || $2::uuid::text,t.input,t.id,$3 FROM tasks t
      JOIN task_publications p ON p.task_id=t.id AND p.status='published'
      WHERE t.id=$1 AND t.session_id IS NULL ON CONFLICT DO NOTHING RETURNING id
    ) INSERT INTO task_outbox(task_id) SELECT id FROM added`,
      [root, id, instruction],
    );
    const turn = await this.get(id);
    return turn?.sessionId === root && turn.instruction === instruction ? turn : undefined;
  }

  async closeMessages(id: string, delivered: number) {
    return (
      (
        await this.db.query(
          `UPDATE tasks SET accepting_messages=false WHERE id=$1 AND
      user_message_count=$2 RETURNING id`,
          [id, delivered],
        )
      ).rows.length > 0
    );
  }

  async messages(id: string) {
    return (
      await this.db.query<{ id: string; role: "user" | "assistant"; body: string }>(
        "SELECT id,role,body FROM task_messages WHERE task_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
  }

  async message(id: string, role: "user" | "assistant", body: string) {
    return (
      (
        await this.db.query(
          `WITH active AS (UPDATE tasks SET user_message_count=user_message_count+CASE WHEN $2='user' THEN 1 ELSE 0 END WHERE id=$1 AND (accepting_messages OR $2='assistant') AND status IN ('queued','running') RETURNING id) INSERT INTO task_messages(task_id,role,body) SELECT id,$2,$3 FROM active RETURNING id`,
          [id, role, body],
        )
      ).rows.length > 0
    );
  }

  async pending() {
    return (
      await this.db.query<{ taskId: string }>(
        `SELECT task_id AS "taskId" FROM task_outbox WHERE published_at IS NULL LIMIT 100`,
      )
    ).rows;
  }

  async published(id: string) {
    await this.db.query("UPDATE task_outbox SET published_at = now() WHERE task_id = $1", [id]);
  }

  async start(id: string) {
    return (
      await this.db.query<Task>(
        `UPDATE tasks SET status = 'running', accepting_messages=(result IS NULL), attempts = attempts + 1,
      error_code = NULL, updated_at = now() WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING ${columns}`,
        [id],
      )
    ).rows[0];
  }

  async setSandbox(id: string, sandboxId: string | null) {
    await this.db.query("UPDATE tasks SET sandbox_id = $2, updated_at = now() WHERE id = $1", [
      id,
      sandboxId,
    ]);
  }

  async setSource(id: string, sha: string, branch: string) {
    await this.db.query(
      "UPDATE tasks SET source_sha = COALESCE(source_sha, $2), source_branch = COALESCE(source_branch, $3), updated_at = now() WHERE id = $1",
      [id, sha, branch],
    );
  }

  async complete(
    id: string,
    result: Pick<Task, "result" | "model" | "promptVersion" | "usage">,
    staged = false,
  ) {
    await this.db.query(
      `UPDATE tasks SET status = $6, result = $2::jsonb,
      model = $3, prompt_version = $4, usage = $5::jsonb, error_code = NULL, updated_at = now()
      WHERE id = $1 AND status = 'running'`,
      [
        id,
        JSON.stringify(result.result),
        result.model,
        result.promptVersion,
        JSON.stringify(result.usage),
        staged ? "running" : "completed",
      ],
    );
  }

  async fail(id: string, terminal: boolean, code = "EXECUTION_FAILED") {
    await this.db.query(
      `UPDATE tasks SET status = $2, error_code = $3, updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')`,
      [id, terminal ? "failed" : "queued", code],
    );
  }
}
