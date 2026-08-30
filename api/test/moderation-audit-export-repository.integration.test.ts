import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AnalyticsExportRepository, parseAnalyticsExportRange } from '../src/analytics-export-repository.js'
import { createDatabase, type Database } from '../src/database.js'
import { ModerationAuditExportRepository } from '../src/moderation-audit-export-repository.js'
import { ModerationRepository, type ModerationPublishIdentity } from '../src/moderation-repository.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeDatabase = databaseUrl === undefined ? describe.skip : describe
const schema = `ghostlight_audit_export_${randomUUID().replaceAll('-', '')}`
const CATALYST = 'https://peer.decentraland.org'
const NOW = Date.parse('2026-08-30T18:45:00.000Z')
const MODERATOR = `0x${'11'.repeat(20)}`
const REVOKED_MODERATOR = `0x${'22'.repeat(20)}`
const ANALYST = `0x${'33'.repeat(20)}`
const UNLISTED = `0x${'44'.repeat(20)}`
const AUTHOR = `0x${'55'.repeat(20)}`
const AUDIT_LOCK_NAMESPACE = 1_195_912_019
const AUDIT_LOCK_ID = 2

function digest(value: number) {
  return Buffer.alloc(32, value)
}

describeDatabase('moderation audit export against PostgreSQL', () => {
  let admin: Client
  let inspect: Client
  let database: Database
  let connectionString: string

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('TEST_DATABASE_URL is required')
    admin = new Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)

    const isolatedUrl = new URL(databaseUrl)
    isolatedUrl.searchParams.set('options', `-c search_path=${schema} -c timezone=America/Los_Angeles`)
    connectionString = isolatedUrl.toString()
    database = createDatabase(connectionString)
    inspect = new Client({ connectionString })
    await inspect.connect()
    await database.migrate()
  })

  beforeEach(async () => {
    await inspect.query(
      `TRUNCATE
         moderation_audit,
         moderation_decisions,
         moderation_reports,
         shadow_hides,
         moderation_subjects,
         daily_funnel_aggregates,
         analytics_receipts,
         rate_buckets,
         actor_roles,
         scene_allowlist
       RESTART IDENTITY CASCADE`
    )
    await database.seedSceneAllowlist(['scene-a'], CATALYST)
    await inspect.query(
      `INSERT INTO actor_roles (actor_address, role, revoked_at)
       VALUES
         ($1, 'moderator', NULL),
         ($2, 'moderator', $4::timestamptz),
         ($3, 'analyst', NULL)`,
      [MODERATOR, REVOKED_MODERATOR, ANALYST, new Date(NOW)]
    )
  })

  afterAll(async () => {
    await inspect.end()
    await database.close()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  })

  function repository(source: Database = database, auditExportPerHour = 6) {
    return new ModerationAuditExportRepository(source, { auditExportPerHour })
  }

  async function insertRejectedAudits(count: number) {
    await inspect.query(
      `INSERT INTO moderation_audit (
         action,
         actor_address,
         actor_digest,
         subject_id,
         created_at,
         details
       )
       SELECT
         'publish-rejected',
         NULL,
         decode(repeat('ab', 32), 'hex'),
         NULL,
         $1::timestamptz + generated.offset * INTERVAL '1 millisecond',
         jsonb_build_object(
           'clientCreatedAt', $2::bigint + generated.offset,
           'reason', 'id-conflict',
           'requestedSubjectId', 'subject-' || generated.offset::text
         )
       FROM generate_series(1, $3) AS generated(offset)`,
      [new Date(NOW), NOW - 1_000, count]
    )
  }

  it('allows only an active moderator and consumes rate only for the authorized call', async () => {
    const audit = repository()
    const actors = [MODERATOR, REVOKED_MODERATOR, ANALYST, UNLISTED] as const
    const results = await Promise.all(
      actors.map((actor, index) => audit.exportAudit(actor, '0', digest(index + 1), NOW))
    )

    expect(results).toEqual([
      { status: 'data', afterSequence: '0', nextCursor: null, items: [] },
      { status: 'unauthorized' },
      { status: 'unauthorized' },
      { status: 'unauthorized' }
    ])
    const rates = await inspect.query<{ count: string }>(
      "SELECT count(*) FROM rate_buckets WHERE scope = 'moderation-audit-export'"
    )
    expect(rates.rows).toEqual([{ count: '1' }])
  })

  it('keeps analytics and moderation-audit export quotas independent for the same actor bucket', async () => {
    const sharedBucket = digest(1)
    const analytics = new AnalyticsExportRepository(database, {
      allowedSceneIds: ['scene-a'],
      exportPerHour: 1
    })
    const audit = repository(database, 1)
    const range = parseAnalyticsExportRange('2026-08-30', '2026-08-30')

    await expect(analytics.exportFunnel(MODERATOR, range, sharedBucket, NOW)).resolves.toMatchObject({
      status: 'data'
    })
    await expect(audit.exportAudit(MODERATOR, '0', sharedBucket, NOW)).resolves.toMatchObject({ status: 'data' })
    await expect(analytics.exportFunnel(MODERATOR, range, sharedBucket, NOW)).resolves.toEqual({
      status: 'rate-limited'
    })
    await expect(audit.exportAudit(MODERATOR, '0', sharedBucket, NOW)).resolves.toEqual({
      status: 'rate-limited'
    })

    const rates = await inspect.query<{ scope: string; request_count: number }>(
      `SELECT scope, request_count
       FROM rate_buckets
       WHERE scope IN ('export', 'moderation-audit-export')
       ORDER BY scope`
    )
    expect(rates.rows).toEqual([
      { scope: 'export', request_count: 1 },
      { scope: 'moderation-audit-export', request_count: 1 }
    ])
  })

  it('paginates fifty rows without exposing the fifty-first sentinel', async () => {
    await insertRejectedAudits(51)
    const audit = repository()

    const first = await audit.exportAudit(MODERATOR, '0', digest(1), NOW)
    expect(first.status).toBe('data')
    if (first.status !== 'data') throw new Error('Expected first audit page')
    expect(first.items).toHaveLength(50)
    expect(first.items[0]?.sequence).toBe('1')
    expect(first.items.at(-1)?.sequence).toBe('50')
    expect(first.nextCursor).toBe('50')
    expect(
      first.items.every(({ moderatorAddress, subjectId }) => moderatorAddress === null && subjectId === null)
    ).toBe(true)

    if (first.nextCursor === null) throw new Error('Expected a second audit page')
    const second = await audit.exportAudit(MODERATOR, first.nextCursor, digest(1), NOW)
    expect(second).toEqual({
      status: 'data',
      afterSequence: '50',
      nextCursor: null,
      items: [
        {
          sequence: '51',
          action: 'publish-rejected',
          moderatorAddress: null,
          subjectId: null,
          createdAt: NOW + 51,
          details: {
            clientCreatedAt: NOW - 949,
            reason: 'id-conflict',
            requestedSubjectId: 'subject-51'
          }
        }
      ]
    })
  })

  it('serializes role revocation with an in-flight export and rejects every later page', async () => {
    await inspect.query(
      `INSERT INTO rate_buckets (scope, bucket_hash, window_start, request_count, expires_at)
       VALUES (
         'moderation-audit-export',
         $1,
         date_trunc('hour', $2::timestamptz),
         0,
         date_trunc('hour', $2::timestamptz) + INTERVAL '1 hour'
       )`,
      [digest(7), new Date(NOW)]
    )

    const blocker = new Client({ connectionString })
    await blocker.connect()
    await blocker.query('BEGIN')
    await blocker.query(
      `SELECT 1
       FROM rate_buckets
       WHERE scope = 'moderation-audit-export'
         AND bucket_hash = $1
       FOR UPDATE`,
      [digest(7)]
    )

    const raceTag = schema.slice(-12)
    const exportApplicationName = `gl_audit_export_${raceTag}`
    const revokeApplicationName = `gl_audit_revoke_${raceTag}`
    const exportUrl = new URL(connectionString)
    exportUrl.searchParams.set('application_name', exportApplicationName)
    const exportDatabase = createDatabase(exportUrl.toString())
    const revoker = new Client({ connectionString, application_name: revokeApplicationName })
    await revoker.connect()

    const exportPromise = repository(exportDatabase).exportAudit(MODERATOR, '0', digest(7), NOW)
    const exportDeadline = Date.now() + 5_000
    let exportWaiting = false
    while (!exportWaiting && Date.now() < exportDeadline) {
      const activity = await admin.query<{ count: string }>(
        `SELECT count(*)
         FROM pg_stat_activity
         WHERE application_name = $1
           AND wait_event_type = 'Lock'`,
        [exportApplicationName]
      )
      exportWaiting = activity.rows[0]?.count === '1'
      if (!exportWaiting) await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const revokePromise = revoker.query(
      "UPDATE actor_roles SET revoked_at = $2 WHERE actor_address = $1 AND role = 'moderator'",
      [MODERATOR, new Date(NOW + 1)]
    )
    const revokeDeadline = Date.now() + 5_000
    let revokeWaiting = false
    while (!revokeWaiting && Date.now() < revokeDeadline) {
      const activity = await admin.query<{ count: string }>(
        `SELECT count(*)
         FROM pg_stat_activity
         WHERE application_name = $1
           AND wait_event_type = 'Lock'`,
        [revokeApplicationName]
      )
      revokeWaiting = activity.rows[0]?.count === '1'
      if (!revokeWaiting) await new Promise((resolve) => setTimeout(resolve, 10))
    }

    await blocker.query('COMMIT')
    const [exportResult, revokeResult] = await Promise.all([exportPromise, revokePromise])
    await Promise.all([exportDatabase.close(), revoker.end(), blocker.end()])

    expect(exportWaiting).toBe(true)
    expect(revokeWaiting).toBe(true)
    expect(exportResult).toMatchObject({ status: 'data' })
    expect(revokeResult.rowCount).toBe(1)
    await expect(repository().exportAudit(MODERATOR, '0', digest(8), NOW + 2)).resolves.toEqual({
      status: 'unauthorized'
    })
  })

  it('does not advance past an uncommitted lower sequence while a writer waits for the global audit lock', async () => {
    const lower = new Client({ connectionString })
    let lowerConnected = false
    let lowerTransactionOpen = false
    let writerDatabase: Database | undefined
    let publishPromise: ReturnType<ModerationRepository['publish']> | undefined
    let publishObserved = false
    let failure: unknown

    try {
      await lower.connect()
      lowerConnected = true
      await lower.query('BEGIN')
      lowerTransactionOpen = true
      await lower.query('SELECT pg_advisory_xact_lock($1, $2)', [AUDIT_LOCK_NAMESPACE, AUDIT_LOCK_ID])
      await lower.query(
        `INSERT INTO moderation_audit (
           action,
           actor_address,
           actor_digest,
           subject_id,
           created_at,
           details
         )
         VALUES (
           'publish-rejected',
           NULL,
           $1,
           NULL,
           $2,
           $3::jsonb
         )`,
        [
          digest(1),
          new Date(NOW),
          JSON.stringify({ clientCreatedAt: NOW, reason: 'id-conflict', requestedSubjectId: 'lower' })
        ]
      )

      const writerApplicationName = `gl_audit_writer_${schema.slice(-12)}`
      const writerUrl = new URL(connectionString)
      writerUrl.searchParams.set('application_name', writerApplicationName)
      writerDatabase = createDatabase(writerUrl.toString())
      const moderation = new ModerationRepository(writerDatabase, {
        allowedSceneIds: ['scene-a'],
        trustedCatalystUrl: CATALYST,
        publishPerHour: 6,
        reportWalletPerHour: 6,
        reportGuestPerHour: 6,
        decisionPerMinute: 6
      })
      const identity: ModerationPublishIdentity = {
        actorAddress: AUTHOR,
        bucketHash: digest(2),
        auditDigest: digest(3)
      }
      publishPromise = moderation.publish(
        'scene-a',
        { id: 'higher', content: 'Higher committed audit', channel: 'untrusted', touringConsent: true, createdAt: NOW },
        identity,
        NOW
      )

      const deadline = Date.now() + 5_000
      let writerWaiting = false
      while (!writerWaiting && Date.now() < deadline) {
        const activity = await admin.query<{ count: string }>(
          `SELECT count(*)
           FROM pg_stat_activity
           WHERE application_name = $1
             AND wait_event_type = 'Lock'`,
          [writerApplicationName]
        )
        writerWaiting = activity.rows[0]?.count === '1'
        if (!writerWaiting) await new Promise((resolve) => setTimeout(resolve, 10))
      }

      const beforeCommit = await repository().exportAudit(MODERATOR, '0', digest(4), NOW)
      expect(beforeCommit).toEqual({ status: 'data', afterSequence: '0', nextCursor: null, items: [] })

      await lower.query('COMMIT')
      lowerTransactionOpen = false
      publishObserved = true
      const published = await publishPromise

      expect(writerWaiting).toBe(true)
      expect(published).toMatchObject({ status: 'published' })
      const afterCommit = await repository().exportAudit(MODERATOR, '0', digest(5), NOW)
      expect(afterCommit.status).toBe('data')
      if (afterCommit.status !== 'data') throw new Error('Expected complete audit page')
      expect(afterCommit.items.map(({ sequence }) => sequence)).toEqual(['1', '2'])
      expect(afterCommit.nextCursor).toBeNull()
    } catch (error) {
      failure = error
    } finally {
      const cleanupFailures: unknown[] = []
      if (lowerTransactionOpen) {
        try {
          await lower.query('ROLLBACK')
          lowerTransactionOpen = false
        } catch (error) {
          cleanupFailures.push(error)
        }
      }
      if (lowerConnected) {
        try {
          await lower.end()
          lowerConnected = false
        } catch (error) {
          cleanupFailures.push(error)
        }
      }
      if (publishPromise && !publishObserved) {
        try {
          await publishPromise
        } catch (error) {
          cleanupFailures.push(error)
        }
      }
      if (writerDatabase) {
        try {
          await writerDatabase.close()
        } catch (error) {
          cleanupFailures.push(error)
        }
      }

      if (cleanupFailures.length > 0) {
        failure = new AggregateError(
          failure === undefined ? cleanupFailures : [failure, ...cleanupFailures],
          'Late-commit audit export test and cleanup failed'
        )
      }
    }

    if (failure !== undefined) throw failure
  })

  it('rolls back the consumed export rate when a persisted row is malformed', async () => {
    await insertRejectedAudits(1)
    await inspect.query('UPDATE moderation_audit SET details = details || \'{"extra": true}\'::jsonb')

    await expect(repository().exportAudit(MODERATOR, '0', digest(1), NOW)).rejects.toThrow(
      'Invalid moderation audit export row'
    )
    const rate = await inspect.query<{ count: string }>(
      "SELECT count(*) FROM rate_buckets WHERE scope = 'moderation-audit-export'"
    )
    expect(rate.rows).toEqual([{ count: '0' }])
  })
})
