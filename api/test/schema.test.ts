import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const initialMigrationPath = fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url))
const upgradeMigrationPath = fileURLToPath(new URL('../migrations/002_audit_export.sql', import.meta.url))
const initialMigration = readFileSync(initialMigrationPath, 'utf8')
const upgradeMigration = readFileSync(upgradeMigrationPath, 'utf8')

describe('initial schema contract', () => {
  it('is an explicit transaction with idempotent DDL for the future migration runner', () => {
    expect(initialMigration.trimStart()).toMatch(/^BEGIN;/u)
    expect(initialMigration.trimEnd()).toMatch(/COMMIT;$/u)
    expect(initialMigration).toContain('CREATE TABLE IF NOT EXISTS')
    expect(initialMigration).toContain('CREATE INDEX IF NOT EXISTS')
    expect(initialMigration).not.toMatch(/CREATE TYPE\s+(?!IF)/u)
  })

  it('defines the required moderation, rate, receipt, and aggregate relations', () => {
    for (const table of [
      'scene_allowlist',
      'actor_roles',
      'moderation_subjects',
      'moderation_reports',
      'moderation_decisions',
      'shadow_hides',
      'moderation_audit',
      'rate_buckets',
      'analytics_receipts',
      'daily_funnel_aggregates',
      'daily_click_aggregates'
    ]) {
      expect(initialMigration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  it('uses database checks and relational constraints rather than fake test semantics', () => {
    expect(initialMigration).toMatch(/CHECK \(actor_address ~ '\^0x\[0-9a-f\]\{40\}\$'\)/u)
    expect(initialMigration).toMatch(/CHECK \(event_id ~ '\^evt_\[0-9a-f\]\{32\}\$'\)/u)
    expect(initialMigration).toContain('octet_length(content) BETWEEN 1 AND 4096')
    expect(initialMigration).toContain('UNIQUE (subject_id, report_id)')
    expect(initialMigration).toContain('FOREIGN KEY (moderator_address, moderator_role)')
    expect(initialMigration).toContain('CHECK (octet_length(bucket_hash) = 32)')
    expect(initialMigration).toContain("CHECK ((kind = 'click'")
    expect(initialMigration).toContain('CHECK (wake_count >= 0')
    expect(initialMigration).toContain("CHECK (channel IN ('untrusted', 'curated', 'trusted'))")
    expect(initialMigration).toContain('revoked_at timestamptz')
    expect(initialMigration).toContain("'moderation-audit-export'")
  })

  it('stores bounded app-validated Catalyst origins without a weaker SQL URL parser', () => {
    expect(initialMigration).toContain('CHECK (octet_length(catalyst_origin) BETWEEN 9 AND 2048)')
    expect(initialMigration).toContain('CHECK (btrim(catalyst_origin) = catalyst_origin)')
    expect(initialMigration).not.toContain('catalyst_origin ~')
  })
})

describe('audit export upgrade schema contract', () => {
  it('is transaction-bounded and safely rerunnable without replacing tables', () => {
    expect(upgradeMigration.trimStart()).toMatch(/^BEGIN;/u)
    expect(upgradeMigration.trimEnd()).toMatch(/COMMIT;$/u)
    expect(upgradeMigration).toContain('ADD COLUMN IF NOT EXISTS revoked_at timestamptz')
    expect(upgradeMigration).toContain('FROM pg_catalog.pg_constraint')
    expect(upgradeMigration).toContain('pg_catalog.pg_get_constraintdef')
    expect(upgradeMigration).toContain("conrelid = 'rate_buckets'::regclass")
    expect(upgradeMigration).toContain("conname = 'rate_buckets_scope_check'")
    expect(upgradeMigration).toContain("position('moderation-audit-export' IN scope_constraint_definition) = 0")
    expect(upgradeMigration).toContain('IF scope_constraint_definition IS NULL')
    expect(upgradeMigration).toContain('END;\n$migration$;')
    expect(upgradeMigration).toContain('DROP CONSTRAINT IF EXISTS rate_buckets_scope_check')
    expect(upgradeMigration).toContain("'moderation-audit-export'")
    expect(upgradeMigration).toMatch(
      /IF scope_constraint_definition IS NULL[\s\S]+THEN[\s\S]+DROP CONSTRAINT IF EXISTS rate_buckets_scope_check[\s\S]+ADD CONSTRAINT rate_buckets_scope_check[\s\S]+END IF;/u
    )
    expect(upgradeMigration).not.toMatch(/DROP TABLE|TRUNCATE/u)
  })
})
