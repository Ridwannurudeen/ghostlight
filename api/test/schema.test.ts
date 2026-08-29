import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url))
const migration = readFileSync(migrationPath, 'utf8')

describe('initial schema contract', () => {
  it('is an explicit transaction with idempotent DDL for the future migration runner', () => {
    expect(migration.trimStart()).toMatch(/^BEGIN;/u)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/u)
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS')
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS')
    expect(migration).not.toMatch(/CREATE TYPE\s+(?!IF)/u)
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
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  it('uses database checks and relational constraints rather than fake test semantics', () => {
    expect(migration).toMatch(/CHECK \(actor_address ~ '\^0x\[0-9a-f\]\{40\}\$'\)/u)
    expect(migration).toMatch(/CHECK \(event_id ~ '\^evt_\[0-9a-f\]\{32\}\$'\)/u)
    expect(migration).toContain('octet_length(content) BETWEEN 1 AND 4096')
    expect(migration).toContain('UNIQUE (subject_id, report_id)')
    expect(migration).toContain('FOREIGN KEY (moderator_address, moderator_role)')
    expect(migration).toContain('CHECK (octet_length(bucket_hash) = 32)')
    expect(migration).toContain("CHECK ((kind = 'click'")
    expect(migration).toContain('CHECK (wake_count >= 0')
    expect(migration).toContain("CHECK (channel IN ('untrusted', 'curated', 'trusted'))")
  })

  it('stores bounded app-validated Catalyst origins without a weaker SQL URL parser', () => {
    expect(migration).toContain('CHECK (octet_length(catalyst_origin) BETWEEN 9 AND 2048)')
    expect(migration).toContain('CHECK (btrim(catalyst_origin) = catalyst_origin)')
    expect(migration).not.toContain('catalyst_origin ~')
  })
})
