BEGIN;

CREATE TABLE llm_calls (
  owner_kind text NOT NULL CHECK (owner_kind IN ('construction', 'proof-session')),
  owner_id text NOT NULL,
  id text NOT NULL,
  role text NOT NULL CHECK (role IN ('topic-extractor', 'move-shortlister')),
  status text NOT NULL CHECK (status IN ('dispatching', 'completed')),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (owner_kind, owner_id, id),
  CHECK ((record #>> '{owner,kind}') IS NOT DISTINCT FROM owner_kind),
  CHECK ((record #>> '{owner,id}') IS NOT DISTINCT FROM owner_id),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'role') IS NOT DISTINCT FROM role),
  CHECK ((record ->> 'status') IS NOT DISTINCT FROM status),
  CHECK ((record #>> '{preparedCall,id}') IS NOT DISTINCT FROM id),
  CHECK ((record #>> '{preparedCall,role}') IS NOT DISTINCT FROM role),
  CHECK (status <> 'completed' OR (record #>> '{evidence,id}') IS NOT DISTINCT FROM id)
);

CREATE TABLE llm_topic_decisions (
  owner_kind text NOT NULL CHECK (owner_kind IN ('construction', 'proof-session')),
  owner_id text NOT NULL,
  id text NOT NULL,
  call_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  approved_manifest_id text,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (owner_kind, owner_id, id),
  CHECK ((decision = 'approved') = (approved_manifest_id IS NOT NULL)),
  CHECK ((record #>> '{owner,kind}') IS NOT DISTINCT FROM owner_kind),
  CHECK ((record #>> '{owner,id}') IS NOT DISTINCT FROM owner_id),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'callId') IS NOT DISTINCT FROM call_id),
  CHECK ((record ->> 'decision') IS NOT DISTINCT FROM decision),
  CHECK ((record ->> 'approvedManifestId') IS NOT DISTINCT FROM approved_manifest_id),
  FOREIGN KEY (owner_kind, owner_id, call_id)
    REFERENCES llm_calls (owner_kind, owner_id, id)
);

CREATE UNIQUE INDEX llm_topic_decisions_approved_manifest_unique
  ON llm_topic_decisions (owner_kind, owner_id, approved_manifest_id)
  WHERE approved_manifest_id IS NOT NULL;

COMMIT;
