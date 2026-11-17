import type { Database } from "@/db/client";
import type { Publication, PublishedPull } from "@/tasks/types";

const columns = `status, branch, base_branch AS "baseBranch", commit_sha AS "commitSha",
  branch_url AS "branchUrl", pr_number AS "prNumber", pr_url AS "prUrl", error`;

export class PublicationRepository {
  constructor(private readonly db: Database) {}

  async get(taskId: string) {
    return (
      await this.db.query<Publication>(
        `SELECT ${columns} FROM task_publications WHERE task_id=$1`,
        [taskId],
      )
    ).rows[0];
  }

  async start(taskId: string, branch: string, base: string, branchUrl: string) {
    await this.db.query(
      `INSERT INTO task_publications(task_id,branch,base_branch,branch_url,status)
       VALUES($1,$2,$3,$4,'in_progress') ON CONFLICT(task_id)
       DO UPDATE SET status='in_progress',error=NULL,updated_at=now()`,
      [taskId, branch, base, branchUrl],
    );
  }

  async setCommit(taskId: string, sha: string) {
    await this.db.query(
      "UPDATE task_publications SET commit_sha=$2,updated_at=now() WHERE task_id=$1",
      [taskId, sha],
    );
  }

  async complete(taskId: string, pr: PublishedPull) {
    const result = await this.db.query<Publication>(
      `UPDATE task_publications SET status='published',pr_number=$2,pr_url=$3,error=NULL,updated_at=now()
       WHERE task_id=$1 RETURNING ${columns}`,
      [taskId, pr.number, pr.url],
    );
    const publication = result.rows[0];
    if (!publication) throw new Error("Publication disappeared");
    return publication;
  }

  async fail(taskId: string, code: string) {
    await this.db.query(
      "UPDATE task_publications SET status='failed',error=$2,updated_at=now() WHERE task_id=$1 AND pr_url IS NULL",
      [taskId, code],
    );
  }
}
