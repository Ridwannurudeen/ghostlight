import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AnalyticsExportRepository,
  parseAnalyticsExportRange,
  type AnalyticsExportRow
} from '../src/analytics-export-repository.js'
import { createDatabase, type Database } from '../src/database.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeDatabase = databaseUrl === undefined ? describe.skip : describe
const schema = `ghostlight_export_${randomUUID().replaceAll('-', '')}`
const CATALYST = 'https://peer.decentraland.org'
const NOW = Date.parse('2026-08-30T18:45:00.000Z')
const ANALYST = `0x${'11'.repeat(20)}`
const MODERATOR = `0x${'22'.repeat(20)}`
const TRUSTED_CREATOR = `0x${'33'.repeat(20)}`
const UNLISTED = `0x${'44'.repeat(20)}`
const DUAL_ROLE = `0x${'55'.repeat(20)}`
const REVOKED_ANALYST = `0x${'66'.repeat(20)}`
const RANGE = parseAnalyticsExportRange('2026-08-10', '2026-08-12')

function bucket(value: number) {
  return Buffer.alloc(32, value)
}

describeDatabase('analytics aggregate export against PostgreSQL', () => {
  let admin: Client
  let inspect: Client
  let database: Database

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
  })

  beforeEach(async () => {
    await inspect.query(
      'TRUNCATE daily_funnel_aggregates, analytics_receipts, rate_buckets, actor_roles, scene_allowlist CASCADE'
    )
    await database.seedSceneAllowlist(['scene-a', 'scene-b'], CATALYST)
    await inspect.query(
      `INSERT INTO actor_roles (actor_address, role, revoked_at)
       VALUES
         ($1, 'analyst', NULL),
         ($2, 'moderator', NULL),
         ($3, 'trusted-creator', NULL),
         ($4, 'analyst', NULL),
         ($4, 'moderator', NULL),
         ($5, 'analyst', $6::timestamptz)`,
      [ANALYST, MODERATOR, TRUSTED_CREATOR, DUAL_ROLE, REVOKED_ANALYST, new Date(NOW)]
    )
  })

  afterAll(async () => {
    await inspect.end()
    await database.close()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  })

  function repository(exportPerHour = 6, allowedSceneIds: readonly string[] = ['scene-a']) {
    return new AnalyticsExportRepository(database, { allowedSceneIds, exportPerHour })
  }

  async function insertAggregate(day: string, sceneId: string, counts: readonly string[]) {
    await inspect.query(
      `INSERT INTO daily_funnel_aggregates (
         day,
         scene_id,
         wake_count,
         ready_count,
         decode_count,
         reveal_count,
         author_count,
         post_count,
         invite_count,
         mail_count
       )
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [day, sceneId, ...counts]
    )
  }

  it('allows active analyst, moderator, and dual-role actors while denying revoked, unrelated, and unlisted actors', async () => {
    const analytics = repository()
    const actors = [ANALYST, MODERATOR, DUAL_ROLE, REVOKED_ANALYST, TRUSTED_CREATOR, UNLISTED] as const
    const results = await Promise.all(
      actors.map((actor, index) => analytics.exportFunnel(actor, RANGE, bucket(index + 1), NOW))
    )

    expect(results).toEqual([
      { status: 'data', rows: [] },
      { status: 'data', rows: [] },
      { status: 'data', rows: [] },
      { status: 'unauthorized' },
      { status: 'unauthorized' },
      { status: 'unauthorized' }
    ])
    const rates = await inspect.query<{ count: string }>("SELECT count(*) FROM rate_buckets WHERE scope = 'export'")
    expect(rates.rows).toEqual([{ count: '3' }])
  })

  it('revokes a moderator without deleting the role row referenced by historical moderation decisions', async () => {
    await inspect.query(
      `INSERT INTO moderation_subjects (
         id,
         scene_id,
         author_address,
         content,
         fingerprint,
         channel,
         created_at
       )
       VALUES ('subject-a', 'scene-a', $1, 'Ghost', 'fingerprint-a', 'untrusted', $2::timestamptz)`,
      [ANALYST, new Date(NOW)]
    )
    await inspect.query(
      `INSERT INTO moderation_reports (id, subject_id, reporter_digest, reason, created_at)
       VALUES ('report-a', 'subject-a', $1, 'other', $2::timestamptz)`,
      [bucket(9), new Date(NOW)]
    )
    await inspect.query(
      `INSERT INTO moderation_decisions (
         id,
         subject_id,
         report_id,
         action,
         reason,
         moderator_address,
         created_at
       )
       VALUES ('decision-a', 'subject-a', 'report-a', 'quarantined', 'reviewed', $1, $2::timestamptz)`,
      [MODERATOR, new Date(NOW)]
    )

    await inspect.query(
      `UPDATE actor_roles
       SET revoked_at = $2::timestamptz
       WHERE actor_address = $1
         AND role = 'moderator'`,
      [MODERATOR, new Date(NOW + 1)]
    )

    await expect(repository().exportFunnel(MODERATOR, RANGE, bucket(1), NOW + 2)).resolves.toEqual({
      status: 'unauthorized'
    })
    const history = await inspect.query<{ decision_count: string; revoked_at: Date | null }>(
      `SELECT count(decisions.id) AS decision_count, roles.revoked_at
       FROM actor_roles AS roles
       LEFT JOIN moderation_decisions AS decisions
         ON decisions.moderator_address = roles.actor_address
        AND decisions.moderator_role = roles.role
       WHERE roles.actor_address = $1
         AND roles.role = 'moderator'
       GROUP BY roles.revoked_at`,
      [MODERATOR]
    )
    expect(history.rows).toEqual([{ decision_count: '1', revoked_at: new Date(NOW + 1) }])
  })

  it('returns only configured-scene rows on the inclusive UTC range with exact bigint strings and no receipts', async () => {
    const aboveSafeInteger = [
      '9007199254740993',
      '9007199254740994',
      '9007199254740995',
      '9007199254740996',
      '9007199254740997',
      '9007199254740998',
      '9007199254740999',
      '9007199254741000'
    ] as const
    const smallCounts = ['1', '2', '3', '4', '5', '6', '7', '8'] as const
    await insertAggregate('2026-08-09', 'scene-a', smallCounts)
    await insertAggregate('2026-08-10', 'scene-a', aboveSafeInteger)
    await insertAggregate('2026-08-11', 'scene-a', smallCounts)
    await insertAggregate('2026-08-12', 'scene-a', aboveSafeInteger)
    await insertAggregate('2026-08-13', 'scene-a', smallCounts)
    await insertAggregate('2026-08-10', 'scene-b', smallCounts)

    const receiptsBefore = await inspect.query<{ count: string }>('SELECT count(*) FROM analytics_receipts')
    const result = await repository().exportFunnel(ANALYST, RANGE, bucket(1), NOW)
    const receiptsAfter = await inspect.query<{ count: string }>('SELECT count(*) FROM analytics_receipts')

    const expectedHugeRow = (day: string): AnalyticsExportRow => ({
      day,
      sceneId: 'scene-a',
      wakeCount: aboveSafeInteger[0],
      readyCount: aboveSafeInteger[1],
      decodeCount: aboveSafeInteger[2],
      revealCount: aboveSafeInteger[3],
      authorCount: aboveSafeInteger[4],
      postCount: aboveSafeInteger[5],
      inviteCount: aboveSafeInteger[6],
      mailCount: aboveSafeInteger[7]
    })
    expect(result).toEqual({
      status: 'data',
      rows: [
        expectedHugeRow('2026-08-10'),
        {
          day: '2026-08-11',
          sceneId: 'scene-a',
          wakeCount: '1',
          readyCount: '2',
          decodeCount: '3',
          revealCount: '4',
          authorCount: '5',
          postCount: '6',
          inviteCount: '7',
          mailCount: '8'
        },
        expectedHugeRow('2026-08-12')
      ]
    })
    expect(receiptsBefore.rows).toEqual([{ count: '0' }])
    expect(receiptsAfter.rows).toEqual([{ count: '0' }])
  })

  it('returns an empty data result when no configured aggregate exists in range', async () => {
    await insertAggregate('2026-08-11', 'scene-b', ['1', '1', '1', '1', '1', '1', '1', '1'])

    await expect(repository().exportFunnel(MODERATOR, RANGE, bucket(1), NOW)).resolves.toEqual({
      status: 'data',
      rows: []
    })
  })

  it('admits exactly exportPerHour concurrent calls and rate-limits all excess calls and the next request', async () => {
    const analytics = repository(3)
    const sharedBucket = bucket(1)

    const results = await Promise.all(
      Array.from({ length: 10 }, () => analytics.exportFunnel(ANALYST, RANGE, sharedBucket, NOW))
    )

    expect(results.filter(({ status }) => status === 'data')).toHaveLength(3)
    expect(results.filter(({ status }) => status === 'rate-limited')).toHaveLength(7)
    await expect(analytics.exportFunnel(ANALYST, RANGE, sharedBucket, NOW)).resolves.toEqual({
      status: 'rate-limited'
    })
    const rate = await inspect.query<{ request_count: number }>(
      "SELECT request_count FROM rate_buckets WHERE scope = 'export'"
    )
    expect(rate.rows).toEqual([{ request_count: 3 }])
  })

  it('rolls back a consumed rate admission after an aggregate query failure and permits retry', async () => {
    const analytics = repository()
    await inspect.query('ALTER TABLE daily_funnel_aggregates RENAME TO unavailable_funnel_aggregates')

    try {
      await expect(analytics.exportFunnel(ANALYST, RANGE, bucket(1), NOW)).rejects.toThrow()
      const rates = await inspect.query<{ count: string }>("SELECT count(*) FROM rate_buckets WHERE scope = 'export'")
      expect(rates.rows).toEqual([{ count: '0' }])
    } finally {
      await inspect.query('ALTER TABLE unavailable_funnel_aggregates RENAME TO daily_funnel_aggregates')
    }

    await expect(analytics.exportFunnel(ANALYST, RANGE, bucket(1), NOW)).resolves.toEqual({
      status: 'data',
      rows: []
    })
    const rate = await inspect.query<{ request_count: number }>(
      "SELECT request_count FROM rate_buckets WHERE scope = 'export'"
    )
    expect(rate.rows).toEqual([{ request_count: 1 }])
  })
})
