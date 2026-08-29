import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseUrl = process.env.TEST_DATABASE_URL
const migration = readFileSync(fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url)), 'utf8')
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

  it('executes twice and creates every required relation in an isolated schema', async () => {
    await client.query(migration)
    await client.query(migration)
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
  })
})
