import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AnalyticsRepository,
  type AnalyticsRateIdentity,
  type FunnelAnalyticsEvent
} from '../src/analytics-repository.js'
import { FUNNEL_EVENTS, type FunnelEvent } from '../src/contracts.js'
import { createDatabase, type Database } from '../src/database.js'
import { RetentionRepository } from '../src/retention-repository.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeDatabase = databaseUrl === undefined ? describe.skip : describe
const schema = `ghostlight_analytics_${randomUUID().replaceAll('-', '')}`
const CATALYST = 'https://peer.decentraland.org'
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1_000

function event(value: number, name: FunnelEvent = 'wake', occurredAt = NOW): FunnelAnalyticsEvent {
  return Object.freeze({
    eventId: `evt_${value.toString(16).padStart(32, '0')}`,
    event: name,
    occurredAt,
    kind: 'funnel'
  })
}

function rate(value: number): AnalyticsRateIdentity {
  return Object.freeze({ scope: 'analytics-wallet', bucketHash: Buffer.alloc(32, value) })
}

describeDatabase('transactional funnel analytics against PostgreSQL', () => {
  let admin: Client
  let inspect: Client
  let database: Database
  let concurrentDatabase: Database

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required')
    admin = new Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)

    const isolatedUrl = new URL(databaseUrl)
    isolatedUrl.searchParams.set('options', `-c search_path=${schema} -c timezone=America/Los_Angeles`)
    const connectionString = isolatedUrl.toString()
    database = createDatabase(connectionString)
    concurrentDatabase = createDatabase(connectionString)
    inspect = new Client({ connectionString })
    await inspect.connect()

    await Promise.all([database.migrate(), concurrentDatabase.migrate()])
  })

  beforeEach(async () => {
    await inspect.query(
      'TRUNCATE daily_funnel_aggregates, daily_click_aggregates, analytics_receipts, rate_buckets CASCADE'
    )
    await inspect.query('DELETE FROM scene_allowlist')
    await database.seedSceneAllowlist(['scene-a'], CATALYST)
  })

  afterAll(async () => {
    await inspect.end()
    await Promise.all([database.close(), concurrentDatabase.close()])
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  })

  function repository(options: { limit?: number; retentionDays?: number; allowedSceneIds?: readonly string[] } = {}) {
    const limit = options.limit ?? 100
    return new AnalyticsRepository(database, {
      allowedSceneIds: options.allowedSceneIds ?? ['scene-a'],
      trustedCatalystUrl: CATALYST,
      retentionDays: options.retentionDays ?? 31,
      analyticsWalletPerMinute: limit,
      analyticsGuestPerMinute: limit
    })
  }

  it('runs the initial migration safely under concurrent startup', async () => {
    const result = await inspect.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name IN ('analytics_receipts', 'daily_funnel_aggregates', 'rate_buckets', 'scene_allowlist')
       ORDER BY table_name`,
      [schema]
    )

    expect(result.rows.map(({ table_name }) => table_name)).toEqual([
      'analytics_receipts',
      'daily_funnel_aggregates',
      'rate_buckets',
      'scene_allowlist'
    ])
  })

  it('seeds current scenes without deleting historical allowlist rows', async () => {
    await inspect.query('INSERT INTO scene_allowlist (scene_id, catalyst_origin) VALUES ($1, $2)', [
      'historical-scene',
      'https://old.example'
    ])

    await database.seedSceneAllowlist(['scene-a'], 'https://new.example')

    const result = await inspect.query<{ scene_id: string; catalyst_origin: string }>(
      'SELECT scene_id, catalyst_origin FROM scene_allowlist ORDER BY scene_id'
    )
    expect(result.rows).toEqual([
      { scene_id: 'historical-scene', catalyst_origin: 'https://old.example' },
      { scene_id: 'scene-a', catalyst_origin: 'https://new.example' }
    ])
  })

  it('increments every funnel column on the event UTC day independent of the session timezone', async () => {
    const analytics = repository()
    const occurredAt = Date.parse('2026-10-01T00:30:00.000Z')

    const results = await Promise.all(
      FUNNEL_EVENTS.map((name, index) =>
        analytics.recordFunnel('scene-a', event(index + 1, name, occurredAt), rate(index + 1), NOW)
      )
    )

    expect(results).toEqual(FUNNEL_EVENTS.map(() => 'recorded'))
    const aggregate = await inspect.query<{
      day: string
      wake_count: string
      ready_count: string
      decode_count: string
      reveal_count: string
      author_count: string
      post_count: string
      invite_count: string
      mail_count: string
    }>(`SELECT
          to_char(day, 'YYYY-MM-DD') AS day,
          scene_id,
          wake_count,
          ready_count,
          decode_count,
          reveal_count,
          author_count,
          post_count,
          invite_count,
          mail_count
        FROM daily_funnel_aggregates`)
    expect(aggregate.rows).toEqual([
      {
        day: '2026-10-01',
        scene_id: 'scene-a',
        wake_count: '1',
        ready_count: '1',
        decode_count: '1',
        reveal_count: '1',
        author_count: '1',
        post_count: '1',
        invite_count: '1',
        mail_count: '1'
      }
    ])
  })

  it('commits rate for identical duplicates and rejects changed event-id reuse', async () => {
    await database.seedSceneAllowlist(['scene-a', 'scene-b'], CATALYST)
    const analytics = repository({ limit: 5, allowedSceneIds: ['scene-a', 'scene-b'] })
    const identity = rate(1)

    await expect(analytics.recordFunnel('scene-a', event(1), identity, NOW)).resolves.toBe('recorded')
    await expect(analytics.recordFunnel('scene-a', event(1), identity, NOW)).resolves.toBe('duplicate')
    await expect(analytics.recordFunnel('scene-a', event(1, 'ready'), identity, NOW)).resolves.toBe('event-id-conflict')
    await expect(analytics.recordFunnel('scene-a', event(1, 'wake', NOW - 1), identity, NOW)).resolves.toBe(
      'event-id-conflict'
    )
    await expect(analytics.recordFunnel('scene-b', event(1), identity, NOW)).resolves.toBe('event-id-conflict')

    const bucket = await inspect.query<{ request_count: number }>('SELECT request_count FROM rate_buckets')
    const receipts = await inspect.query<{ count: string }>('SELECT count(*) FROM analytics_receipts')
    const aggregate = await inspect.query<{ wake_count: string; ready_count: string }>(
      'SELECT wake_count, ready_count FROM daily_funnel_aggregates'
    )
    expect(bucket.rows).toEqual([{ request_count: 5 }])
    expect(receipts.rows).toEqual([{ count: '1' }])
    expect(aggregate.rows).toEqual([{ wake_count: '1', ready_count: '0' }])
  })

  it('admits exactly the configured limit under concurrent requests', async () => {
    const analytics = repository({ limit: 5 })
    const identity = rate(1)

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => analytics.recordFunnel('scene-a', event(index + 1), identity, NOW))
    )

    expect(results.filter((result) => result === 'recorded')).toHaveLength(5)
    expect(results.filter((result) => result === 'rate-limited')).toHaveLength(15)
    const bucket = await inspect.query<{ request_count: number }>('SELECT request_count FROM rate_buckets')
    const receipts = await inspect.query<{ count: string }>('SELECT count(*) FROM analytics_receipts')
    const aggregate = await inspect.query<{ wake_count: string }>('SELECT wake_count FROM daily_funnel_aggregates')
    expect(bucket.rows).toEqual([{ request_count: 5 }])
    expect(receipts.rows).toEqual([{ count: '5' }])
    expect(aggregate.rows).toEqual([{ wake_count: '5' }])
  })

  it('records one receipt and aggregate for concurrent identical events', async () => {
    const analytics = repository({ limit: 20 })
    const identity = rate(1)

    const results = await Promise.all(
      Array.from({ length: 10 }, () => analytics.recordFunnel('scene-a', event(1), identity, NOW))
    )

    expect(results.filter((result) => result === 'recorded')).toHaveLength(1)
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(9)
    const bucket = await inspect.query<{ request_count: number }>('SELECT request_count FROM rate_buckets')
    const aggregate = await inspect.query<{ wake_count: string }>('SELECT wake_count FROM daily_funnel_aggregates')
    expect(bucket.rows).toEqual([{ request_count: 10 }])
    expect(aggregate.rows).toEqual([{ wake_count: '1' }])
  })

  it('keeps replay protection in the application clock domain while the event day remains accepted', async () => {
    const retentionDays = 2
    const analytics = repository({ retentionDays })
    const cleanup = new RetentionRepository(database, { analyticsRetentionDays: retentionDays })
    const earliestAcceptedDay = Math.floor(NOW / DAY) * DAY - DAY
    const retainedEvent = event(1, 'wake', earliestAcceptedDay)
    const identity = rate(1)
    await inspect.query(
      "ALTER TABLE analytics_receipts ALTER COLUMN received_at SET DEFAULT '2020-01-01T00:00:00.000Z'::timestamptz"
    )

    try {
      await expect(analytics.recordFunnel('scene-a', retainedEvent, identity, NOW)).resolves.toBe('recorded')
      const receipt = await inspect.query<{ received_at: Date }>(
        'SELECT received_at FROM analytics_receipts WHERE event_id = $1',
        [retainedEvent.eventId]
      )
      expect(receipt.rows).toEqual([{ received_at: new Date(NOW) }])

      const pruned = await cleanup.pruneExpired(NOW)
      expect(pruned.analyticsReceipts).toEqual({ deleted: 0, possiblyBacklogged: false })
      await expect(analytics.recordFunnel('scene-a', retainedEvent, identity, NOW)).resolves.toBe('duplicate')

      const aggregate = await inspect.query<{ wake_count: string }>('SELECT wake_count FROM daily_funnel_aggregates')
      expect(aggregate.rows).toEqual([{ wake_count: '1' }])
    } finally {
      await inspect.query('ALTER TABLE analytics_receipts ALTER COLUMN received_at SET DEFAULT now()')
    }
  })

  it('rolls back rate and receipt when the aggregate write fails, then permits a retry', async () => {
    const analytics = repository()
    await inspect.query('ALTER TABLE daily_funnel_aggregates ADD CONSTRAINT force_wake_failure CHECK (wake_count = 0)')

    try {
      await expect(analytics.recordFunnel('scene-a', event(1), rate(1), NOW)).rejects.toThrow()
      const buckets = await inspect.query<{ count: string }>('SELECT count(*) FROM rate_buckets')
      const receipts = await inspect.query<{ count: string }>('SELECT count(*) FROM analytics_receipts')
      const aggregates = await inspect.query<{ count: string }>('SELECT count(*) FROM daily_funnel_aggregates')
      expect(buckets.rows).toEqual([{ count: '0' }])
      expect(receipts.rows).toEqual([{ count: '0' }])
      expect(aggregates.rows).toEqual([{ count: '0' }])
    } finally {
      await inspect.query('ALTER TABLE daily_funnel_aggregates DROP CONSTRAINT force_wake_failure')
    }

    await expect(analytics.recordFunnel('scene-a', event(1), rate(1), NOW)).resolves.toBe('recorded')
  })
})
