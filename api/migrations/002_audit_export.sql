BEGIN;

ALTER TABLE actor_roles
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

DO $migration$
DECLARE
  scope_constraint_definition text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
  INTO scope_constraint_definition
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'rate_buckets'::regclass
    AND constraint_row.conname = 'rate_buckets_scope_check'
    AND constraint_row.contype = 'c';

  IF scope_constraint_definition IS NULL
    OR position('moderation-audit-export' IN scope_constraint_definition) = 0
  THEN
    ALTER TABLE rate_buckets
      DROP CONSTRAINT IF EXISTS rate_buckets_scope_check;

    ALTER TABLE rate_buckets
      ADD CONSTRAINT rate_buckets_scope_check
      CHECK (scope IN ('analytics-wallet', 'analytics-guest', 'report-wallet', 'report-guest', 'publish', 'decision', 'export', 'moderation-audit-export'));
  END IF;
END;
$migration$;

COMMIT;
