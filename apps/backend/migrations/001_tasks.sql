CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  sandbox_id text,
  source_sha text,
  source_branch text,
  result jsonb,
  model text,
  prompt_version text,
  usage jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- This row is inserted atomically with the task. Redis availability never
-- determines whether a request has been accepted durably.
CREATE TABLE task_outbox (
  task_id uuid PRIMARY KEY REFERENCES tasks(id),
  published_at timestamptz
);
CREATE INDEX task_outbox_pending ON task_outbox(task_id) WHERE published_at IS NULL;

CREATE TABLE task_publications (
  task_id uuid PRIMARY KEY REFERENCES tasks(id),
  branch text NOT NULL,
  base_branch text NOT NULL,
  commit_sha text,
  branch_url text,
  pr_number integer,
  pr_url text,
  status text NOT NULL CHECK (status IN ('in_progress', 'published', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
