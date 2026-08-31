import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../src/database.js'
import { RetentionRepository } from '../src/retention-repository.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeDatabase = databaseUrl === undefined ? describe.skip : describe
const schema = `ghostlight_retention_${randomUUID().replaceAll('-', '')}`
const NOW = Date.parse('2026-08-30T18:45:00.000Z')
const DAY = 24 * 60 * 60 * 1_000
const RETENTION_DAYS = 2
const CATALYST = 'https://peer.decentraland.org'
const AUTHOR = `0x${'ab'.repeat(20)}`

function eventId(value: number) {
  return `evt_${value.toString(16).padStart(32, '0')}`
}

describeDatabase('bounded retention pruning against PostgreSQL', () => {
  let admin: Client
  let inspect: Client
  let database: Database
  let retention: RetentionRepository

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required')
    admin = new Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)

    const isolatedUrl = new URL(databaseUrl)
    isolatedUrl.searchParams.set('options', `-c search_path=${schema} -c timezone=America/Los_Angeles`)
    const connectionString = isolatedUrl.toString()
    database = createDatabase(connectionString)
    inspect = new Client({ connectionString })
    await inspect.connect()
    await database.migrate()
    retention = new RetentionRepository(database, { analyticsRetentionDays: RETENTION_DAYS })
  })

  beforeEach(async () => {
    await inspect.query(
      `TRUNCATE
         moderation_audit,
         moderation_decisions,
         moderation_reports,
         shadow_hides,
         moderation_subjects,
         actor_roles,
         daily_funnel_aggregates,
         daily_click_aggregates,
         analytics_receipts,
         rate_buckets,
         scene_allowlist
       RESTART IDENTITY CASCADE`
    )
    await inspect.query('INSERT INTO scene_allowlist (scene_id, catalyst_origin) VALUES ($1, $2)', [
      'scene-a',
      CATALYST
    ])
  })

  afterAll(async () => {
    await inspect.end()
    await database.close()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  })

  it('deletes expired rate rows and receipts older than the received-at cutoff while preserving boundaries', async () => {
    const now = new Date(NOW)
    const receiptCutoff = new Date(NOW - RETENTION_DAYS * DAY)
    await inspect.query(
      `INSERT INTO rate_buckets (scope, bucket_hash, window_start, request_count, expires_at)
       VALUES
         ('analytics-wallet', $1, $2, 1, $3),
         ('analytics-wallet', $1, $4, 1, $2),
         ('analytics-wallet', $1, $5, 1, $6)`,
      [Buffer.alloc(32, 1), new Date(NOW - 1_000), new Date(NOW - 1), new Date(NOW - 2_000), now, new Date(NOW + 1_000)]
    )
    await inspect.query(
      `INSERT INTO analytics_receipts
         (event_id, kind, event_name, scene_id, campaign, source, occurred_at, received_at)
       VALUES
         ($1, 'funnel', 'wake', 'scene-a', NULL, NULL, $2, $3),
         ($4, 'funnel', 'wake', 'scene-a', NULL, NULL, $2, $5),
         ($6, 'funnel', 'wake', 'scene-a', NULL, NULL, $2, $7)`,
      [
        eventId(1),
        new Date(NOW - 3 * DAY),
        new Date(receiptCutoff.getTime() - 1),
        eventId(2),
        receiptCutoff,
        eventId(3),
        new Date(NOW)
      ]
    )

    await expect(retention.pruneExpired(NOW)).resolves.toEqual({
      rateBuckets: { deleted: 2, possiblyBacklogged: false },
      analyticsReceipts: { deleted: 1, possiblyBacklogged: false }
    })

    const rateRows = await inspect.query<{ expires_at: Date }>(
      'SELECT expires_at FROM rate_buckets ORDER BY expires_at'
    )
    const receiptRows = await inspect.query<{ event_id: string; received_at: Date }>(
      'SELECT event_id, received_at FROM analytics_receipts ORDER BY event_id'
    )
    expect(rateRows.rows).toEqual([{ expires_at: new Date(NOW + 1_000) }])
    expect(receiptRows.rows).toEqual([
      { event_id: eventId(2), received_at: receiptCutoff },
      { event_id: eventId(3), received_at: new Date(NOW) }
    ])

    await expect(retention.pruneExpired(NOW)).resolves.toEqual({
      rateBuckets: { deleted: 0, possiblyBacklogged: false },
      analyticsReceipts: { deleted: 0, possiblyBacklogged: false }
    })
  })

  it('retains the replay receipt for the earliest UTC event day still accepted at cleanup time', async () => {
    const earliestAcceptedDay = Math.floor(NOW / DAY) * DAY - (RETENTION_DAYS - 1) * DAY
    const cleanupCutoff = NOW - RETENTION_DAYS * DAY
    expect(earliestAcceptedDay).toBeGreaterThan(cleanupCutoff)
    await inspect.query(
      `INSERT INTO analytics_receipts
         (event_id, kind, event_name, scene_id, campaign, source, occurred_at, received_at)
       VALUES ($1, 'funnel', 'wake', 'scene-a', NULL, NULL, $2, $2)`,
      [eventId(1), new Date(earliestAcceptedDay)]
    )

    const result = await retention.pruneExpired(NOW)
    const receipts = await inspect.query<{ event_id: string }>('SELECT event_id FROM analytics_receipts')

    expect(result.analyticsReceipts).toEqual({ deleted: 0, possiblyBacklogged: false })
    expect(receipts.rows).toEqual([{ event_id: eventId(1) }])
  })

  it('never deletes analytics aggregates or moderation and audit history', async () => {
    await inspect.query(
      `INSERT INTO daily_funnel_aggregates (day, scene_id, wake_count)
       VALUES ('2020-01-01', 'scene-a', 1)`
    )
    await inspect.query(
      `INSERT INTO daily_click_aggregates (day, campaign, source, click_count)
       VALUES ('2020-01-01', 'season-zero', 'invite', 1)`
    )
    await inspect.query(
      `INSERT INTO moderation_subjects
         (id, scene_id, author_address, content, fingerprint, channel, created_at)
       VALUES ('subject-1', 'scene-a', $1, 'Old but retained', 'fingerprint-1', 'untrusted', $2)`,
      [AUTHOR, new Date(0)]
    )
    await inspect.query(
      `INSERT INTO moderation_audit
         (action, actor_address, actor_digest, subject_id, created_at, details)
       VALUES ('published', NULL, $1, 'subject-1', $2, $3::jsonb)`,
      [Buffer.alloc(32, 2), new Date(0), JSON.stringify({ clientCreatedAt: 0 })]
    )

    await retention.pruneExpired(NOW)

    const preserved = await inspect.query<{
      funnel: string
      click: string
      subjects: string
      audit: string
    }>(
      `SELECT
         (SELECT count(*) FROM daily_funnel_aggregates) AS funnel,
         (SELECT count(*) FROM daily_click_aggregates) AS click,
         (SELECT count(*) FROM moderation_subjects) AS subjects,
         (SELECT count(*) FROM moderation_audit) AS audit`
    )
    expect(preserved.rows).toEqual([{ funnel: '1', click: '1', subjects: '1', audit: '1' }])
  })

  it('bounds each run to ten thousand expired rows and clears the remainder on retry', async () => {
    await inspect.query(
      `INSERT INTO rate_buckets (scope, bucket_hash, window_start, request_count, expires_at)
       SELECT
         'analytics-wallet',
         $1,
         $2::timestamptz - generated.ordinal * INTERVAL '1 second',
         1,
         $2::timestamptz - generated.ordinal * INTERVAL '1 second' + INTERVAL '1 millisecond'
       FROM generate_series(1, 10001) AS generated(ordinal)`,
      [Buffer.alloc(32, 3), new Date(NOW - DAY)]
    )

    const first = await retention.pruneExpired(NOW)
    const afterFirst = await inspect.query<{ count: string }>('SELECT count(*) FROM rate_buckets')
    const second = await retention.pruneExpired(NOW)
    const afterSecond = await inspect.query<{ count: string }>('SELECT count(*) FROM rate_buckets')

    expect(first.rateBuckets).toEqual({ deleted: 10_000, possiblyBacklogged: true })
    expect(afterFirst.rows).toEqual([{ count: '1' }])
    expect(second.rateBuckets).toEqual({ deleted: 1, possiblyBacklogged: false })
    expect(afterSecond.rows).toEqual([{ count: '0' }])
  })
})
