BEGIN;

CREATE TABLE IF NOT EXISTS scene_allowlist (
  scene_id text PRIMARY KEY,
  catalyst_origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(scene_id) BETWEEN 1 AND 128),
  CHECK (btrim(scene_id) = scene_id),
  CHECK (octet_length(catalyst_origin) BETWEEN 9 AND 2048),
  CHECK (btrim(catalyst_origin) = catalyst_origin)
);

CREATE TABLE IF NOT EXISTS actor_roles (
  actor_address text NOT NULL,
  role text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (actor_address, role),
  CHECK (actor_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (role IN ('moderator', 'analyst', 'trusted-creator'))
);

CREATE TABLE IF NOT EXISTS moderation_subjects (
  id text PRIMARY KEY,
  scene_id text NOT NULL REFERENCES scene_allowlist(scene_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  author_address text NOT NULL,
  content text NOT NULL,
  fingerprint text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'published',
  touring_consent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CHECK (octet_length(id) BETWEEN 1 AND 128),
  CHECK (btrim(id) = id),
  CHECK (author_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (octet_length(content) BETWEEN 1 AND 4096),
  CHECK (btrim(content) = content),
  CHECK (octet_length(fingerprint) BETWEEN 1 AND 4096),
  CHECK (channel IN ('untrusted', 'curated', 'trusted')),
  CHECK (status IN ('published', 'quarantined', 'tombstoned')),
  CHECK ((status = 'tombstoned') = (deleted_at IS NOT NULL)),
  UNIQUE (scene_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS moderation_subjects_live_fingerprint_idx
  ON moderation_subjects (fingerprint)
  WHERE status <> 'tombstoned';
CREATE INDEX IF NOT EXISTS moderation_subjects_scene_status_idx
  ON moderation_subjects (scene_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_subjects_author_idx
  ON moderation_subjects (author_address, created_at DESC);

CREATE TABLE IF NOT EXISTS moderation_reports (
  id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES moderation_subjects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reporter_digest bytea NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CHECK (octet_length(id) BETWEEN 1 AND 128),
  CHECK (btrim(id) = id),
  CHECK (octet_length(reporter_digest) = 32),
  CHECK (reason IN ('unsafe-name', 'duplicate', 'abuse', 'copyright', 'other')),
  CHECK (status IN ('open', 'resolved', 'dismissed')),
  CHECK ((status = 'open') = (resolved_at IS NULL)),
  UNIQUE (subject_id, id),
  UNIQUE (subject_id, reporter_digest, reason)
);

CREATE INDEX IF NOT EXISTS moderation_reports_queue_idx
  ON moderation_reports (status, created_at, id);

CREATE TABLE IF NOT EXISTS moderation_decisions (
  id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES moderation_subjects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  report_id text,
  action text NOT NULL,
  reason text NOT NULL,
  moderator_address text NOT NULL,
  moderator_role text NOT NULL DEFAULT 'moderator',
  created_at timestamptz NOT NULL,
  CHECK (octet_length(id) BETWEEN 1 AND 128),
  CHECK (btrim(id) = id),
  CHECK (action IN ('quarantined', 'shadow-hidden', 'tombstoned')),
  CHECK (octet_length(reason) BETWEEN 1 AND 1024),
  CHECK (btrim(reason) = reason),
  CHECK (moderator_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (moderator_role = 'moderator'),
  UNIQUE (subject_id, report_id),
  FOREIGN KEY (subject_id, report_id) REFERENCES moderation_reports(subject_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (moderator_address, moderator_role) REFERENCES actor_roles(actor_address, role) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS moderation_decisions_subject_idx
  ON moderation_decisions (subject_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shadow_hides (
  author_address text PRIMARY KEY,
  moderator_address text NOT NULL,
  moderator_role text NOT NULL DEFAULT 'moderator',
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  lifted_at timestamptz,
  CHECK (author_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (moderator_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (moderator_role = 'moderator'),
  CHECK (octet_length(reason) BETWEEN 1 AND 1024),
  CHECK (btrim(reason) = reason),
  CHECK (lifted_at IS NULL OR lifted_at >= created_at),
  FOREIGN KEY (moderator_address, moderator_role) REFERENCES actor_roles(actor_address, role) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS moderation_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  actor_address text,
  actor_digest bytea NOT NULL,
  subject_id text REFERENCES moderation_subjects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (action IN ('published', 'publish-rejected', 'reported', 'quarantined', 'shadow-hidden', 'tombstoned')),
  CHECK (actor_address IS NULL OR actor_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (octet_length(actor_digest) = 32),
  CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS moderation_audit_subject_idx
  ON moderation_audit (subject_id, sequence);
CREATE INDEX IF NOT EXISTS moderation_audit_created_idx
  ON moderation_audit (created_at, sequence);

CREATE TABLE IF NOT EXISTS rate_buckets (
  scope text NOT NULL,
  bucket_hash bytea NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, bucket_hash, window_start),
  CHECK (scope IN ('analytics-wallet', 'analytics-guest', 'report-wallet', 'report-guest', 'publish', 'decision', 'export', 'moderation-audit-export')),
  CHECK (octet_length(bucket_hash) = 32),
  CHECK (request_count BETWEEN 0 AND 100000),
  CHECK (expires_at > window_start)
);

CREATE INDEX IF NOT EXISTS rate_buckets_expiry_idx ON rate_buckets (expires_at);

CREATE TABLE IF NOT EXISTS analytics_receipts (
  event_id text PRIMARY KEY,
  kind text NOT NULL,
  event_name text NOT NULL,
  scene_id text REFERENCES scene_allowlist(scene_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  campaign text,
  source text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_id ~ '^evt_[0-9a-f]{32}$'),
  CHECK (kind IN ('click', 'funnel')),
  CHECK (event_name IN ('click', 'wake', 'ready', 'decode', 'reveal', 'author', 'post', 'invite', 'mail')),
  CHECK (campaign IS NULL OR campaign ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  CHECK (source IS NULL OR source ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  CHECK ((kind = 'click' AND event_name = 'click' AND scene_id IS NULL AND campaign IS NOT NULL AND source IS NOT NULL) OR (kind = 'funnel' AND event_name <> 'click' AND scene_id IS NOT NULL AND campaign IS NULL AND source IS NULL))
);

CREATE INDEX IF NOT EXISTS analytics_receipts_retention_idx ON analytics_receipts (received_at);

CREATE TABLE IF NOT EXISTS daily_funnel_aggregates (
  day date NOT NULL,
  scene_id text NOT NULL REFERENCES scene_allowlist(scene_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  wake_count bigint NOT NULL DEFAULT 0,
  ready_count bigint NOT NULL DEFAULT 0,
  decode_count bigint NOT NULL DEFAULT 0,
  reveal_count bigint NOT NULL DEFAULT 0,
  author_count bigint NOT NULL DEFAULT 0,
  post_count bigint NOT NULL DEFAULT 0,
  invite_count bigint NOT NULL DEFAULT 0,
  mail_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scene_id),
  CHECK (wake_count >= 0 AND ready_count >= 0 AND decode_count >= 0 AND reveal_count >= 0 AND author_count >= 0 AND post_count >= 0 AND invite_count >= 0 AND mail_count >= 0)
);

CREATE TABLE IF NOT EXISTS daily_click_aggregates (
  day date NOT NULL,
  campaign text NOT NULL,
  source text NOT NULL,
  click_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, campaign, source),
  CHECK (campaign ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  CHECK (source ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  CHECK (click_count >= 0)
);

COMMIT;
