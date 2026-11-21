ALTER TABLE tasks ADD COLUMN settle_requested boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN waiting_for_message boolean NOT NULL DEFAULT false;

-- A message and Settle serialize on the same task row. Retrying an accepted
-- message still succeeds after the session has closed.
CREATE OR REPLACE FUNCTION send_session_message(root uuid, key uuid, content text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE target tasks;
BEGIN
  SELECT * INTO target FROM tasks WHERE id=root OR session_id=root
    ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
  IF EXISTS (SELECT FROM session_receipts WHERE session_id=root AND message_id=key) THEN
    RETURN (SELECT run_id FROM session_receipts WHERE session_id=root AND message_id=key);
  END IF;
  IF target.id IS NULL OR target.settle_requested OR target.status NOT IN ('queued','running') THEN
    RETURN NULL;
  END IF;
  INSERT INTO task_messages(task_id,role,body) VALUES(target.id,'user',content);
  INSERT INTO session_receipts VALUES(root,key,target.id);
  RETURN target.id;
END $$;
