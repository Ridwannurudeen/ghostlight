import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type DatabaseClient } from '../src/database.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const initialMigration = readFileSync(fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url)), 'utf8')
const upgradeMigration = readFileSync(
  fileURLToPath(new URL('../migrations/002_audit_export.sql', import.meta.url)),
  'utf8'
)
const schema = `ghostlight_test_${randomUUID().replaceAll('-', '')}`
const describeDatabase = databaseUrl === undefined ? describe.skip : describe

describeDatabase('initial schema against PostgreSQL', () => {
  const client = new Client({ connectionString: databaseUrl })

  beforeAll(async () => {
    await client.connect()
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}"`)
  })

  afterAll(async () => {
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA "${schema}" CASCADE`)
    await client.end()
  })

  it('applies the bounded server statement timeout to pooled sessions', async () => {
    if (databaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required')
    const database = createDatabase(databaseUrl)
    let connection: DatabaseClient | undefined

    try {
      connection = await database.connect()
      const result = await connection.query('SHOW statement_timeout')
      expect(result.rows).toEqual([{ statement_timeout: '4s' }])
    } finally {
      connection?.release()
      await database.close()
    }
  })

  it('executes both migrations twice and preserves existing rows while upgrading the schema', async () => {
    await client.query(initialMigration)
    await client.query(initialMigration)
    await client.query('ALTER TABLE actor_roles DROP COLUMN revoked_at')
    await client.query('ALTER TABLE rate_buckets DROP CONSTRAINT rate_buckets_scope_check')
    await client.query(
      `ALTER TABLE rate_buckets
       ADD CONSTRAINT rate_buckets_scope_check
       CHECK (scope IN ('analytics-wallet', 'analytics-guest', 'report-wallet', 'report-guest', 'publish', 'decision', 'export'))`
    )
    await client.query(
      `INSERT INTO actor_roles (actor_address, role)
       VALUES ($1, 'analyst')`,
      [`0x${'11'.repeat(20)}`]
    )
    await client.query(
      `INSERT INTO rate_buckets (scope, bucket_hash, window_start, request_count, expires_at)
       VALUES ('export', decode(repeat('cd', 32), 'hex'), now(), 1, now() + INTERVAL '1 hour')`
    )
    await client.query(upgradeMigration)
    const firstScopeConstraint = await client.query<{ oid: string }>(
      `SELECT oid::text AS oid
       FROM pg_catalog.pg_constraint
       WHERE conrelid = 'rate_buckets'::regclass
         AND conname = 'rate_buckets_scope_check'`
    )
    await client.query(upgradeMigration)
    const secondScopeConstraint = await client.query<{ oid: string }>(
      `SELECT oid::text AS oid
       FROM pg_catalog.pg_constraint
       WHERE conrelid = 'rate_buckets'::regclass
         AND conname = 'rate_buckets_scope_check'`
    )
    expect(firstScopeConstraint.rows).toHaveLength(1)
    expect(secondScopeConstraint.rows).toEqual(firstScopeConstraint.rows)
    const result = await client.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
      [schema]
    )

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'actor_roles',
      'analytics_receipts',
      'daily_click_aggregates',
      'daily_funnel_aggregates',
      'moderation_audit',
      'moderation_decisions',
      'moderation_reports',
      'moderation_subjects',
      'rate_buckets',
      'scene_allowlist',
      'shadow_hides'
    ])

    const roles = await client.query<{ actor_address: string; revoked_at: Date | null }>(
      'SELECT actor_address, revoked_at FROM actor_roles'
    )
    expect(roles.rows).toEqual([{ actor_address: `0x${'11'.repeat(20)}`, revoked_at: null }])

    const existingRates = await client.query<{ count: string }>(
      "SELECT count(*) FROM rate_buckets WHERE scope = 'export'"
    )
    expect(existingRates.rows).toEqual([{ count: '1' }])

    await client.query(
      `INSERT INTO rate_buckets (scope, bucket_hash, window_start, request_count, expires_at)
       VALUES ('moderation-audit-export', decode(repeat('ab', 32), 'hex'), now(), 1, now() + INTERVAL '1 hour')`
    )
  })
})
