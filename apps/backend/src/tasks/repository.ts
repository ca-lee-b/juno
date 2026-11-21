import { randomUUID } from "node:crypto";
import type { Database } from "@/db/client";
import type { TaskInput } from "@/tasks/input";
import { IdempotencyConflict, type Task } from "@/tasks/types";

const columns = `id, settle_requested AS "settleRequested", waiting_for_message AS "waitingForMessage", live_lost AS "liveLost", issue_title AS "issueTitle", session_id AS "sessionId", instruction, input, status, attempts, sandbox_id AS "sandboxId",
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
    const { rows } = await this.db.query<{ task_id: string; created: boolean }>(
      "SELECT * FROM open_issue_session($1::jsonb,$2,$3)",
      [JSON.stringify(normalized), key, randomUUID()],
    );
    const opened = rows[0];
    const task = opened && (await this.get(opened.task_id));
    if (!task || !opened) throw new Error("Session disappeared");
    if (
      task.input.owner !== normalized.owner ||
      task.input.repo !== normalized.repo ||
      task.input.issueNumber !== normalized.issueNumber
    )
      throw new IdempotencyConflict();
    return { task, created: opened.created };
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
          changes: task.result?.patch
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

  async conversation(root: string, before?: string) {
    return (
      await this.db.query<{ id: string; role: string; body: string }>(
        `
      WITH runs AS (SELECT * FROM tasks WHERE (id=$1 OR session_id=$1)
        AND ($2::uuid IS NULL OR created_at < (SELECT created_at FROM tasks WHERE id=$2)))
      SELECT id,role,body FROM (
        SELECT t.id::text,'user' AS role,instruction AS body,created_at FROM runs t WHERE instruction IS NOT NULL
        UNION ALL SELECT 'msg-'||m.id,m.role,m.body,m.created_at FROM task_messages m JOIN runs t ON t.id=m.task_id
        UNION ALL SELECT 'summary-'||id,'assistant',result->>'summary',updated_at FROM runs
          WHERE NULLIF(result->>'summary','') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_messages m WHERE m.task_id=runs.id AND m.role='assistant')
      ) transcript ORDER BY created_at,id`,
        [root, before ?? null],
      )
    ).rows;
  }

  async latestDraft(root: string) {
    return (
      await this.db.query<Task>(
        `SELECT ${columns} FROM tasks WHERE (id=$1 OR session_id=$1)
      AND status='completed' ORDER BY created_at DESC,id DESC LIMIT 1`,
        [root],
      )
    ).rows[0];
  }

  async turns(root: string) {
    return (
      await this.db.query<Pick<Task, "id" | "instruction" | "status" | "createdAt">>(
        'SELECT id, instruction, status, created_at AS "createdAt" FROM tasks WHERE id=$1 OR session_id=$1 ORDER BY created_at,id',
        [root],
      )
    ).rows;
  }

  async send(root: string, body: string, key: string) {
    const sent = (
      await this.db.query<{ id: string | null }>("SELECT send_session_message($1,$2,$3) AS id", [
        root,
        key,
        body,
      ])
    ).rows[0];
    return sent?.id ? { id: sent.id } : undefined;
  }

  async settle(root: string) {
    await this.db.query(
      `UPDATE tasks SET settle_requested=true,
      status=CASE WHEN status='queued' THEN 'completed' ELSE status END
      WHERE id=$1 OR session_id=$1`,
      [root],
    );
  }

  async inbox(id: string, after: string) {
    const result = await this.db.query<{
      settling: boolean;
      id: string | null;
      body: string | null;
    }>(
      `
      SELECT (t.settle_requested OR t.status <> 'running') AS settling, m.id, m.body FROM tasks t
      LEFT JOIN LATERAL (SELECT id, body FROM task_messages WHERE task_id=t.id AND role='user'
        AND id > $2 ORDER BY id LIMIT 1) m ON true WHERE t.id=$1`,
      [id, after],
    );
    if (!result.rows[0]) throw new Error("Session unavailable");
    return result.rows[0];
  }

  async waiting(id: string, waiting: boolean) {
    await this.db.query("UPDATE tasks SET waiting_for_message=$2 WHERE id=$1", [id, waiting]);
  }

  async messages(id: string) {
    return (
      await this.db.query<{ id: string; role: "user" | "assistant"; body: string }>(
        "SELECT id,role,body FROM task_messages WHERE task_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
  }

  async liveLost(id: string, lost = true) {
    await this.db.query("UPDATE tasks SET live_lost=$2 WHERE id=$1", [id, lost]);
  }

  async reply(id: string, body: string) {
    await this.db.query("INSERT INTO task_messages(task_id,role,body) VALUES($1,'assistant',$2)", [
      id,
      body,
    ]);
  }

  async pending() {
    return (
      await this.db.query<{ taskId: string }>(
        `SELECT task_id AS "taskId" FROM task_outbox o JOIN tasks t ON t.id=o.task_id WHERE published_at IS NULL AND NOT EXISTS (SELECT 1 FROM tasks earlier WHERE (earlier.id=t.session_id OR earlier.session_id=t.session_id) AND earlier.created_at<t.created_at AND earlier.status IN ('queued','running')) LIMIT 100`,
      )
    ).rows;
  }

  async published(id: string) {
    await this.db.query("UPDATE task_outbox SET published_at = now() WHERE task_id = $1", [id]);
  }

  async start(id: string) {
    return (
      await this.db.query<Task>(
        `UPDATE tasks SET status = 'running', live_lost=false, accepting_messages=(result IS NULL), attempts = attempts + 1,
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

  async setSource(id: string, sha: string, branch: string, title?: string) {
    await this.db.query(
      "UPDATE tasks SET issue_title=COALESCE(issue_title,$4), source_sha = $2, source_branch = $3, updated_at = now() WHERE id = $1",
      [id, sha, branch, title ?? null],
    );
  }

  async complete(id: string, result: Pick<Task, "result" | "model" | "promptVersion" | "usage">) {
    await this.db.query(
      `UPDATE tasks SET status = 'completed', result = $2::jsonb,
      model = $3, prompt_version = $4, usage = $5::jsonb, error_code = NULL, updated_at = now()
      WHERE id = $1 AND status = 'running'`,
      [
        id,
        JSON.stringify(result.result),
        result.model,
        result.promptVersion,
        JSON.stringify(result.usage),
      ],
    );
  }

  async fail(id: string, terminal: boolean, code = "EXECUTION_FAILED") {
    await this.db.query(
      `UPDATE tasks SET status = CASE WHEN settle_requested AND $3 <> 'CLEANUP_FAILED' THEN 'completed' ELSE $2 END, error_code = CASE WHEN settle_requested AND $3 <> 'CLEANUP_FAILED' THEN NULL ELSE $3 END, updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')`,
      [id, terminal ? "failed" : "queued", code],
    );
  }
}
