DROP INDEX tasks_session_active;
CREATE INDEX tasks_session_active ON tasks(session_id) WHERE status IN ('queued','running');
ALTER TABLE tasks ADD COLUMN issue_title text;
CREATE TABLE session_receipts (
  session_id uuid REFERENCES tasks(id), message_id uuid, run_id uuid REFERENCES tasks(id),
  PRIMARY KEY(session_id,message_id)
);

-- Serialize sends and initial publication for one session. A message arriving
-- during finalization becomes the first instruction of the next queued run.
CREATE FUNCTION send_session_message(root uuid, key uuid, content text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(root::text,0));
  SELECT run_id INTO target FROM session_receipts WHERE session_id=root AND message_id=key;
  IF FOUND THEN RETURN target; END IF;
  UPDATE tasks SET user_message_count=user_message_count+1
    WHERE id=(SELECT id FROM tasks WHERE id=root OR session_id=root ORDER BY created_at DESC,id DESC LIMIT 1)
    AND accepting_messages AND status IN ('queued','running') RETURNING id INTO target;
  IF FOUND THEN
    INSERT INTO task_messages(task_id,role,body) VALUES(target,'user',content);
  ELSE
    INSERT INTO tasks(id,idempotency_key,input,session_id,instruction,created_at)
      SELECT gen_random_uuid(),'turn-' || gen_random_uuid(),input,root,content,clock_timestamp() FROM tasks WHERE id=root RETURNING id INTO target;
    INSERT INTO task_outbox(task_id) VALUES(target);
  END IF;
  INSERT INTO session_receipts VALUES(root,key,target);
  RETURN target;
END $$;
