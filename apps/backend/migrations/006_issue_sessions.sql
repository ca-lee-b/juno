-- A repeated selection can bring a new idempotency key. Keep the alias so a
-- retry after settlement still returns the session originally opened.
CREATE TABLE task_request_keys (
  request_key text PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id)
);

CREATE FUNCTION open_issue_session(payload jsonb, request_key text, new_id uuid)
RETURNS TABLE(task_id uuid, created boolean) LANGUAGE plpgsql AS $$
DECLARE session uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(1, hashtext(request_key));
  SELECT k.task_id INTO session FROM task_request_keys k WHERE k.request_key=$2;
  IF session IS NULL THEN
    SELECT t.id INTO session FROM tasks t WHERE t.idempotency_key=$2;
  END IF;
  IF session IS NOT NULL THEN
    RETURN QUERY SELECT session, false;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(2, hashtext(payload::text));
  SELECT COALESCE(t.session_id,t.id) INTO session FROM tasks t
    WHERE t.input=payload AND t.status IN ('queued','running') AND NOT t.settle_requested
    ORDER BY t.created_at DESC LIMIT 1;
  IF session IS NULL THEN
    INSERT INTO tasks(id,idempotency_key,input) VALUES(new_id,$2,payload);
    INSERT INTO task_outbox(task_id) VALUES(new_id);
    session := new_id;
  END IF;
  INSERT INTO task_request_keys VALUES($2,session);
  RETURN QUERY SELECT session, session=new_id;
END $$;
