ALTER TABLE tasks ADD COLUMN session_id uuid REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN instruction text;
CREATE INDEX tasks_session ON tasks(session_id, created_at);
CREATE UNIQUE INDEX tasks_session_active ON tasks(session_id) WHERE status IN ('queued','running');

CREATE TABLE task_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_messages_turn ON task_messages(task_id,id);
ALTER TABLE tasks ADD COLUMN accepting_messages boolean NOT NULL DEFAULT true;
ALTER TABLE tasks ADD COLUMN user_message_count integer NOT NULL DEFAULT 0;
