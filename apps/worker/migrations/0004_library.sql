BEGIN;

CREATE TABLE library_addition_events (
  scope_key text NOT NULL,
  session_id text,
  id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  layer text NOT NULL CHECK (
    layer IN (
      'global', 'initial-problem', 'proof-time-background', 'derived', 'move-discovery-draft'
    )
  ),
  decision text NOT NULL CHECK (decision IN ('admitted', 'rejected')),
  artifact_id text NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (scope_key, id),
  UNIQUE (scope_key, sequence),
  UNIQUE (scope_key, id, artifact_id, layer, sequence, decision),
  CHECK (scope_key = COALESCE('session:' || session_id, 'global')),
  CHECK ((layer = 'global') = (session_id IS NULL)),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'sessionId') IS NOT DISTINCT FROM session_id),
  CHECK ((record ->> 'sequence') IS NOT DISTINCT FROM sequence::text),
  CHECK ((record ->> 'layer') IS NOT DISTINCT FROM layer),
  CHECK ((record #>> '{artifact,id}') IS NOT DISTINCT FROM artifact_id),
  CHECK ((record #>> '{artifact,layer}') IS NOT DISTINCT FROM layer),
  CHECK ((record #>> '{admission,decision}') IS NOT DISTINCT FROM decision),
  CHECK ((record -> 'classification') IS NOT DISTINCT FROM (record #> '{artifact,classification}')),
  CHECK ((record -> 'approval') IS NOT DISTINCT FROM (record #> '{artifact,approval}')),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE
);

CREATE TABLE library_artifacts (
  scope_key text NOT NULL,
  session_id text,
  id text NOT NULL,
  layer text NOT NULL CHECK (
    layer IN (
      'global', 'initial-problem', 'proof-time-background', 'derived', 'move-discovery-draft'
    )
  ),
  event_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  decision text NOT NULL CHECK (decision = 'admitted'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (scope_key, id),
  UNIQUE (scope_key, event_id),
  CHECK (scope_key = COALESCE('session:' || session_id, 'global')),
  CHECK ((layer = 'global') = (session_id IS NULL)),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'layer') IS NOT DISTINCT FROM layer),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (scope_key, event_id, id, layer, sequence, decision)
    REFERENCES library_addition_events (scope_key, id, artifact_id, layer, sequence, decision)
);

CREATE TABLE library_background_revisions (
  session_id text NOT NULL,
  id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, sequence),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'sessionId') IS NOT DISTINCT FROM session_id),
  CHECK ((record ->> 'sequence') IS NOT DISTINCT FROM sequence::text),
  CHECK ((record -> 'previous') IS DISTINCT FROM (record -> 'revised')),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE
);

CREATE TABLE library_operators (
  id text PRIMARY KEY,
  symbol text NOT NULL UNIQUE,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  CHECK ((record #>> '{operator,id}') IS NOT DISTINCT FROM id),
  CHECK ((record #>> '{operator,symbol}') IS NOT DISTINCT FROM symbol)
);

COMMIT;
