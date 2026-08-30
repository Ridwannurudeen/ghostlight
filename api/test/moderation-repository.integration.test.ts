import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  ModerationAction,
  ModerationDecisionInput,
  ModerationReportInput,
  PublishSubject,
  ReportReason
} from '../src/contracts.js'
import { createDatabase, type Database } from '../src/database.js'
import {
  ModerationRepository,
  type ModerationDecisionIdentity,
  type ModerationPublishIdentity,
  type ModerationReportIdentity
} from '../src/moderation-repository.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeDatabase = databaseUrl === undefined ? describe.skip : describe
const schema = `ghostlight_moderation_${randomUUID().replaceAll('-', '')}`
const CATALYST = 'https://peer.decentraland.org'
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const ACTOR_A = `0x${'11'.repeat(20)}`
const ACTOR_B = `0x${'22'.repeat(20)}`
const MODERATOR = `0x${'33'.repeat(20)}`
const OTHER_MODERATOR = `0x${'44'.repeat(20)}`

function digest(value: number) {
  return Buffer.alloc(32, value)
}

function publishIdentity(actorAddress: string, value: number): ModerationPublishIdentity {
  return Object.freeze({ actorAddress, bucketHash: digest(value), auditDigest: digest(value + 40) })
}

function reportIdentity(
  value: number,
  scope: ModerationReportIdentity['scope'] = 'report-wallet'
): ModerationReportIdentity {
  return Object.freeze({
    scope,
    bucketHash: digest(value),
    reporterDigest: digest(value + 40),
    auditDigest: digest(value + 80)
  })
}

function decisionIdentity(value: number, actorAddress = MODERATOR): ModerationDecisionIdentity {
  return Object.freeze({ actorAddress, bucketHash: digest(value), auditDigest: digest(value + 40) })
}

function subject(id: string, content: string, createdAt = NOW): PublishSubject {
  return Object.freeze({ id, content, channel: 'untrusted', touringConsent: true, createdAt })
}

function report(id: string, contentId: string, reason: ReportReason = 'abuse', createdAt = NOW): ModerationReportInput {
  return Object.freeze({ id, contentId, reason, createdAt, status: 'open' })
}

function decision(id: string, subjectId: string, action: ModerationAction, createdAt = NOW): ModerationDecisionInput {
  return Object.freeze({ id, subjectId, action, reason: `Confirmed ${action}`, createdAt })
}

describeDatabase('moderation repository against PostgreSQL', () => {
  let admin: Client
  let inspect: Client
  let database: Database
  let concurrentDatabase: Database
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
    concurrentDatabase = createDatabase(connectionString)
    inspect = new Client({ connectionString })
    await inspect.connect()
    await Promise.all([database.migrate(), concurrentDatabase.migrate()])
  })

  beforeEach(async () => {
    await inspect.query(
      `TRUNCATE
         moderation_audit,
         moderation_decisions,
         moderation_reports,
         shadow_hides,
         moderation_subjects,
         rate_buckets,
         actor_roles,
         scene_allowlist
       CASCADE`
    )
    await database.seedSceneAllowlist(['scene-a', 'scene-b'], CATALYST)
    await inspect.query(
      `INSERT INTO actor_roles (actor_address, role)
       VALUES ($1, 'moderator'), ($2, 'moderator')`,
      [MODERATOR, OTHER_MODERATOR]
    )
  })

  afterAll(async () => {
    await inspect.end()
    await database.close()
    await concurrentDatabase.close()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  })

  function repository(
    source: Database = database,
    rates: Partial<{
      publishPerHour: number
      reportWalletPerHour: number
      reportGuestPerHour: number
      decisionPerMinute: number
    }> = {}
  ) {
    return new ModerationRepository(source, {
      allowedSceneIds: ['scene-a', 'scene-b'],
      trustedCatalystUrl: CATALYST,
      publishPerHour: rates.publishPerHour ?? 20,
      reportWalletPerHour: rates.reportWalletPerHour ?? 20,
      reportGuestPerHour: rates.reportGuestPerHour ?? 20,
      decisionPerMinute: rates.decisionPerMinute ?? 20
    })
  }

  it('uses server chronology, pseudonymous audits, and exact publish replay versus ID conflict', async () => {
    const moderation = repository()
    const input = subject('subject-1', 'The ghost bows.', NOW - 4 * 60 * 1_000)
    const identity = publishIdentity(ACTOR_A, 1)

    await expect(moderation.publish('scene-a', input, identity, NOW)).resolves.toMatchObject({
      status: 'published'
    })
    await expect(moderation.publish('scene-a', input, identity, NOW + 1_000)).resolves.toMatchObject({
      status: 'replay'
    })
    await expect(
      moderation.publish('scene-a', { ...input, content: 'Changed content.' }, identity, NOW + 2_000)
    ).resolves.toEqual({ status: 'id-conflict' })

    const stored = await inspect.query<{
      created_at: string
      channel: string
      fingerprint_length: number
    }>(
      `SELECT
         (extract(epoch FROM created_at) * 1000)::bigint::text AS created_at,
         channel,
         length(fingerprint) AS fingerprint_length
       FROM moderation_subjects
       WHERE id = 'subject-1'`
    )
    expect(stored.rows).toEqual([{ created_at: String(NOW), channel: 'untrusted', fingerprint_length: 64 }])

    const audits = await inspect.query<{
      action: string
      actor_address: string | null
      subject_id: string | null
      created_at: string
      details: Readonly<Record<string, unknown>>
    }>(
      `SELECT
         action,
         actor_address,
         subject_id,
         (extract(epoch FROM created_at) * 1000)::bigint::text AS created_at,
         details
       FROM moderation_audit
       ORDER BY sequence`
    )
    expect(audits.rows).toEqual([
      {
        action: 'published',
        actor_address: null,
        subject_id: 'subject-1',
        created_at: String(NOW),
        details: { clientCreatedAt: input.createdAt }
      },
      {
        action: 'publish-rejected',
        actor_address: null,
        subject_id: null,
        created_at: String(NOW + 2_000),
        details: {
          clientCreatedAt: input.createdAt,
          reason: 'id-conflict',
          requestedSubjectId: 'subject-1'
        }
      }
    ])
    const rates = await inspect.query<{ request_count: number }>(
      "SELECT request_count FROM rate_buckets WHERE scope = 'publish'"
    )
    expect(rates.rows).toEqual([{ request_count: 3 }])
    await expect(moderation.eligible('subject-1')).resolves.toEqual({ status: 'unavailable' })
  })

  it('enforces a global fixed Unicode fingerprint concurrently, including quarantine until tombstone releases it', async () => {
    const first = subject('subject-a', '\uFF27\uFF28\uFF2F\uFF33\uFF34\u2014BOWS')
    const second = subject('subject-b', 'ghost bows')
    const left = repository(database)
    const right = repository(concurrentDatabase)

    const results = await Promise.all([
      left.publish('scene-a', first, publishIdentity(ACTOR_A, 1), NOW),
      right.publish('scene-b', second, publishIdentity(ACTOR_B, 2), NOW)
    ])
    const publishedIndex = results.findIndex(({ status }) => status === 'published')
    expect(publishedIndex).not.toBe(-1)
    expect(results.filter(({ status }) => status === 'published')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'duplicate-content')).toHaveLength(1)

    const winner = publishedIndex === 0 ? first : second
    const loser = publishedIndex === 0 ? second : first
    const duplicate = results.find(({ status }) => status === 'duplicate-content')
    expect(duplicate).toEqual({ status: 'duplicate-content', duplicateOf: winner.id })

    const fingerprint = await inspect.query<{ fingerprint: string; length: number }>(
      'SELECT fingerprint, length(fingerprint) AS length FROM moderation_subjects'
    )
    expect(fingerprint.rows).toHaveLength(1)
    expect(fingerprint.rows[0]?.length).toBe(64)
    expect(fingerprint.rows[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/u)

    await expect(
      left.decide(decision('decision-quarantine', winner.id, 'quarantined'), decisionIdentity(3), NOW)
    ).resolves.toMatchObject({ status: 'applied', subjectStatus: 'quarantined' })
    await expect(left.publish('scene-a', loser, publishIdentity(ACTOR_A, 4), NOW)).resolves.toEqual({
      status: 'duplicate-content',
      duplicateOf: winner.id
    })

    await expect(
      left.decide(decision('decision-tombstone', winner.id, 'tombstoned'), decisionIdentity(5), NOW + 1_000)
    ).resolves.toMatchObject({ status: 'applied', subjectStatus: 'tombstoned' })
    await expect(left.publish('scene-a', loser, publishIdentity(ACTOR_A, 4), NOW + 2_000)).resolves.toMatchObject({
      status: 'published'
    })

    const subjects = await inspect.query<{ id: string; status: string }>(
      'SELECT id, status FROM moderation_subjects ORDER BY id'
    )
    expect(subjects.rows).toEqual(
      [
        { id: winner.id, status: 'tombstoned' },
        { id: loser.id, status: 'published' }
      ].sort((a, b) => a.id.localeCompare(b.id))
    )
  })

  it('keeps reporter identity out of queue/audit output and orders open reports by server time for moderators only', async () => {
    const moderation = repository()
    await moderation.publish('scene-a', subject('subject-1', 'First performance'), publishIdentity(ACTOR_A, 1), NOW)
    await moderation.publish('scene-b', subject('subject-2', 'Second performance'), publishIdentity(ACTOR_B, 2), NOW)

    const firstReport = report('report-1', 'subject-1', 'abuse', NOW - 4 * 60 * 1_000)
    const secondReport = report('report-2', 'subject-2', 'copyright', NOW - 4 * 60 * 1_000)
    const firstIdentity = reportIdentity(3)
    const secondIdentity = reportIdentity(4, 'report-guest')
    await expect(moderation.report('scene-b', firstReport, firstIdentity, NOW)).resolves.toEqual({
      status: 'reported'
    })
    await expect(moderation.report('scene-a', secondReport, secondIdentity, NOW + 1_000)).resolves.toEqual({
      status: 'reported'
    })
    await expect(moderation.report('scene-b', firstReport, firstIdentity, NOW + 2_000)).resolves.toEqual({
      status: 'replay'
    })
    await expect(
      moderation.report('scene-b', { ...firstReport, reason: 'other' }, firstIdentity, NOW + 3_000)
    ).resolves.toEqual({ status: 'report-id-conflict' })
    await expect(
      moderation.report('scene-b', { ...firstReport, contentId: 'subject-missing' }, firstIdentity, NOW + 3_500)
    ).resolves.toEqual({ status: 'report-id-conflict' })
    await expect(
      moderation.report('scene-b', { ...firstReport, id: 'report-3' }, firstIdentity, NOW + 4_000)
    ).resolves.toEqual({ status: 'duplicate-report', reportId: 'report-1' })

    await expect(moderation.queue(ACTOR_A)).resolves.toEqual({ status: 'unauthorized' })
    const queue = await moderation.queue(MODERATOR)
    expect(queue.status).toBe('data')
    if (queue.status !== 'data') throw new Error('Expected moderation queue data')
    expect(queue.rows.map(({ reportId, reportedAt }) => ({ reportId, reportedAt }))).toEqual([
      { reportId: 'report-1', reportedAt: NOW },
      { reportId: 'report-2', reportedAt: NOW + 1_000 }
    ])
    for (const row of queue.rows) {
      expect(row).not.toHaveProperty('reporterDigest')
      expect(row).not.toHaveProperty('reporterAddress')
    }

    const audits = await inspect.query<{ actor_address: string | null }>(
      "SELECT actor_address FROM moderation_audit WHERE action = 'reported' ORDER BY sequence"
    )
    expect(audits.rows).toEqual([{ actor_address: null }, { actor_address: null }])
    const persisted = await inspect.query<{ created_at: string }>(
      `SELECT (extract(epoch FROM created_at) * 1000)::bigint::text AS created_at
       FROM moderation_reports
       ORDER BY created_at`
    )
    expect(persisted.rows).toEqual([{ created_at: String(NOW) }, { created_at: String(NOW + 1_000) }])
  })

  it('revokes queue and decision authority without deleting historical moderator records', async () => {
    const moderation = repository()
    await moderation.publish('scene-a', subject('subject-1', 'Historical decision'), publishIdentity(ACTOR_A, 1), NOW)
    await moderation.publish(
      'scene-b',
      subject('subject-2', 'Post-revocation target'),
      publishIdentity(ACTOR_B, 2),
      NOW
    )
    await moderation.report('scene-a', report('report-1', 'subject-1'), reportIdentity(3), NOW)
    await moderation.report('scene-b', report('report-2', 'subject-2'), reportIdentity(4), NOW)
    await expect(
      moderation.decide(decision('decision-1', 'subject-1', 'quarantined'), decisionIdentity(5), NOW)
    ).resolves.toMatchObject({ status: 'applied', action: 'quarantined' })

    await expect(
      inspect.query(
        `UPDATE actor_roles
         SET revoked_at = $2
         WHERE actor_address = $1
           AND role = 'moderator'`,
        [MODERATOR, new Date(NOW + 500)]
      )
    ).resolves.toMatchObject({ rowCount: 1 })

    await expect(moderation.queue(MODERATOR)).resolves.toEqual({ status: 'unauthorized' })
    await expect(
      moderation.decide(
        decision('decision-2', 'subject-2', 'tombstoned', NOW + 1_000),
        decisionIdentity(6),
        NOW + 1_000
      )
    ).resolves.toEqual({ status: 'unauthorized' })

    const state = await inspect.query<{
      revoked: boolean
      decisions: string
      open_reports: string
      decision_rates: string
    }>(
      `SELECT
         roles.revoked_at IS NOT NULL AS revoked,
         (SELECT count(*) FROM moderation_decisions) AS decisions,
         (SELECT count(*) FROM moderation_reports WHERE status = 'open') AS open_reports,
         (SELECT count(*) FROM rate_buckets WHERE scope = 'decision') AS decision_rates
       FROM actor_roles AS roles
       WHERE roles.actor_address = $1
         AND roles.role = 'moderator'`,
      [MODERATOR]
    )
    expect(state.rows).toEqual([{ revoked: true, decisions: '1', open_reports: '1', decision_rates: '1' }])
  })

  it('admits exact concurrent publish and report limits with atomic fixed windows', async () => {
    const moderation = repository(database, { publishPerHour: 3, reportWalletPerHour: 2 })
    const publishRate = publishIdentity(ACTOR_A, 1)

    const publishResults = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        moderation.publish('scene-a', subject(`subject-${index}`, `Unique performance ${index}`), publishRate, NOW)
      )
    )
    expect(publishResults.filter(({ status }) => status === 'published')).toHaveLength(3)
    expect(publishResults.filter(({ status }) => status === 'rate-limited')).toHaveLength(9)

    const target = publishResults.find(({ status }) => status === 'published')
    if (!target || target.status !== 'published') throw new Error('Expected a published rate-test subject')
    const reportResults = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        moderation.report(
          'scene-a',
          report(`report-${index}`, target.subject.id),
          { ...reportIdentity(index + 10), bucketHash: digest(2) },
          NOW
        )
      )
    )
    expect(reportResults.filter(({ status }) => status === 'reported')).toHaveLength(2)
    expect(reportResults.filter(({ status }) => status === 'rate-limited')).toHaveLength(8)

    const rates = await inspect.query<{ scope: string; request_count: number }>(
      `SELECT scope, request_count
       FROM rate_buckets
       WHERE scope IN ('publish', 'report-wallet')
       ORDER BY scope`
    )
    expect(rates.rows).toEqual([
      { scope: 'publish', request_count: 3 },
      { scope: 'report-wallet', request_count: 2 }
    ])
  })

  it('serializes different-ID decisions into monotonic transitions without duplicate decisions or audits', async () => {
    const moderation = repository()
    await moderation.publish('scene-a', subject('subject-1', 'Decision race'), publishIdentity(ACTOR_A, 1), NOW)
    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        moderation.report('scene-a', report(`report-${index}`, 'subject-1'), reportIdentity(index + 2), NOW)
      )
    )

    const quarantineResults = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        moderation.decide(
          decision(`quarantine-${index}`, 'subject-1', 'quarantined'),
          { ...decisionIdentity(index + 10), bucketHash: digest(20) },
          NOW
        )
      )
    )
    expect(quarantineResults.filter(({ status }) => status === 'applied')).toHaveLength(1)
    expect(quarantineResults.filter(({ status }) => status === 'subject-unavailable')).toHaveLength(9)

    const tombstoneResults = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        moderation.decide(
          decision(`tombstone-${index}`, 'subject-1', 'tombstoned', NOW + 1_000),
          { ...decisionIdentity(index + 30), bucketHash: digest(21) },
          NOW + 1_000
        )
      )
    )
    expect(tombstoneResults.filter(({ status }) => status === 'applied')).toHaveLength(1)
    expect(tombstoneResults.filter(({ status }) => status === 'subject-unavailable')).toHaveLength(9)
    await expect(
      moderation.report('scene-a', report('report-0', 'subject-1'), reportIdentity(2), NOW + 2_000)
    ).resolves.toEqual({ status: 'replay' })

    const state = await inspect.query<{
      status: string
      open_reports: string
      decisions: string
      quarantine_audits: string
      tombstone_audits: string
    }>(
      `SELECT
         subjects.status,
         (SELECT count(*) FROM moderation_reports WHERE status = 'open') AS open_reports,
         (SELECT count(*) FROM moderation_decisions) AS decisions,
         (SELECT count(*) FROM moderation_audit WHERE action = 'quarantined') AS quarantine_audits,
         (SELECT count(*) FROM moderation_audit WHERE action = 'tombstoned') AS tombstone_audits
       FROM moderation_subjects AS subjects
       WHERE subjects.id = 'subject-1'`
    )
    expect(state.rows).toEqual([
      {
        status: 'tombstoned',
        open_reports: '0',
        decisions: '2',
        quarantine_audits: '1',
        tombstone_audits: '1'
      }
    ])
  })

  it('persists publish-after-hide normally while curated eligibility remains suppressed without an evasion oracle', async () => {
    const moderation = repository()
    await moderation.publish('scene-a', subject('subject-1', 'Shadow target'), publishIdentity(ACTOR_A, 1), NOW)
    await inspect.query("UPDATE moderation_subjects SET channel = 'trusted' WHERE id = 'subject-1'")
    await expect(moderation.eligible('subject-1')).resolves.toMatchObject({ status: 'eligible' })
    await moderation.report('scene-a', report('report-1', 'subject-1'), reportIdentity(2), NOW)

    await expect(
      moderation.decide(decision('shadow-1', 'subject-1', 'shadow-hidden'), decisionIdentity(3), NOW)
    ).resolves.toMatchObject({ status: 'applied', action: 'shadow-hidden' })
    await expect(moderation.eligible('subject-1')).resolves.toEqual({ status: 'unavailable' })

    await expect(
      moderation.publish('scene-b', subject('subject-2', 'Published after hide'), publishIdentity(ACTOR_A, 4), NOW)
    ).resolves.toMatchObject({ status: 'published' })
    await inspect.query("UPDATE moderation_subjects SET channel = 'trusted' WHERE id = 'subject-2'")
    await expect(moderation.eligible('subject-2')).resolves.toEqual({ status: 'unavailable' })

    await inspect.query(
      `INSERT INTO moderation_reports (
         id,
         subject_id,
         reporter_digest,
         reason,
         status,
         created_at,
         resolved_at
       )
       VALUES ('legacy-shadow-report', 'subject-2', $1, 'other', 'open', $2, NULL)`,
      [digest(99), new Date(NOW + 500)]
    )
    await expect(moderation.queue(MODERATOR)).resolves.toEqual({ status: 'data', rows: [] })

    const duplicateHideResults = await Promise.all([
      moderation.decide(decision('shadow-2', 'subject-1', 'shadow-hidden'), decisionIdentity(5), NOW + 1_000),
      moderation.decide(
        decision('shadow-3', 'subject-2', 'shadow-hidden', NOW + 1_000),
        decisionIdentity(6, OTHER_MODERATOR),
        NOW + 1_000
      )
    ])
    expect(duplicateHideResults).toEqual([{ status: 'subject-unavailable' }, { status: 'subject-unavailable' }])

    const counts = await inspect.query<{ hides: string; decisions: string; audits: string; open_reports: string }>(
      `SELECT
         (SELECT count(*) FROM shadow_hides WHERE lifted_at IS NULL) AS hides,
         (SELECT count(*) FROM moderation_decisions WHERE action = 'shadow-hidden') AS decisions,
         (SELECT count(*) FROM moderation_audit WHERE action = 'shadow-hidden') AS audits,
         (SELECT count(*) FROM moderation_reports WHERE status = 'open') AS open_reports`
    )
    expect(counts.rows).toEqual([{ hides: '1', decisions: '1', audits: '1', open_reports: '0' }])
  })

  it('requires affirmative touring consent in addition to channel and moderation eligibility', async () => {
    const moderation = repository()
    const inputs = [
      { id: 'trusted-opt-in', content: 'Trusted opted in', actor: ACTOR_A, consent: true },
      { id: 'curated-opt-in', content: 'Curated opted in', actor: ACTOR_A, consent: true },
      { id: 'trusted-opt-out', content: 'Trusted opted out', actor: ACTOR_A, consent: false },
      { id: 'curated-opt-out', content: 'Curated opted out', actor: ACTOR_A, consent: false },
      { id: 'untrusted-opt-in', content: 'Untrusted opted in', actor: ACTOR_A, consent: true },
      { id: 'quarantined-opt-in', content: 'Quarantined opted in', actor: ACTOR_A, consent: true },
      { id: 'tombstoned-opt-in', content: 'Tombstoned opted in', actor: ACTOR_A, consent: true },
      { id: 'hidden-opt-in', content: 'Hidden opted in', actor: ACTOR_B, consent: true }
    ] as const

    for (const [index, input] of inputs.entries()) {
      await expect(
        moderation.publish(
          'scene-a',
          { ...subject(input.id, input.content), touringConsent: input.consent },
          publishIdentity(input.actor, index + 1),
          NOW
        )
      ).resolves.toMatchObject({ status: 'published' })
    }

    await inspect.query(
      `UPDATE moderation_subjects
       SET channel = 'trusted'
       WHERE id = ANY($1::text[])`,
      [['trusted-opt-in', 'trusted-opt-out', 'quarantined-opt-in', 'tombstoned-opt-in', 'hidden-opt-in']]
    )
    await inspect.query(
      `UPDATE moderation_subjects
       SET channel = 'curated'
       WHERE id = ANY($1::text[])`,
      [['curated-opt-in', 'curated-opt-out']]
    )
    await moderation.decide(
      decision('quarantine-opt-in', 'quarantined-opt-in', 'quarantined'),
      decisionIdentity(20),
      NOW
    )
    await moderation.decide(decision('tombstone-opt-in', 'tombstoned-opt-in', 'tombstoned'), decisionIdentity(21), NOW)
    await moderation.decide(decision('shadow-hide-opt-in', 'hidden-opt-in', 'shadow-hidden'), decisionIdentity(22), NOW)

    await expect(moderation.eligible('trusted-opt-in')).resolves.toMatchObject({ status: 'eligible' })
    await expect(moderation.eligible('curated-opt-in')).resolves.toMatchObject({ status: 'eligible' })
    for (const id of [
      'trusted-opt-out',
      'curated-opt-out',
      'untrusted-opt-in',
      'quarantined-opt-in',
      'tombstoned-opt-in',
      'hidden-opt-in'
    ]) {
      await expect(moderation.eligible(id)).resolves.toEqual({ status: 'unavailable' })
    }
  })

  it('serializes a cross-subject report racing the first author shadow-hide without leaving an open report', async () => {
    const moderation = repository()
    await moderation.publish('scene-a', subject('subject-1', 'Shadow race decision'), publishIdentity(ACTOR_A, 1), NOW)
    await moderation.publish('scene-b', subject('subject-2', 'Shadow race report'), publishIdentity(ACTOR_A, 2), NOW)

    const blocker = new Client({ connectionString })
    await blocker.connect()
    await blocker.query('BEGIN')
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('ghostlight:shadow:' || $1, 0))", [ACTOR_A])

    const raceTag = schema.slice(-12)
    const reportApplicationName = `gl_report_shadow_${raceTag}`
    const decisionApplicationName = `gl_decide_shadow_${raceTag}`
    const reportUrl = new URL(connectionString)
    reportUrl.searchParams.set('application_name', reportApplicationName)
    const decisionUrl = new URL(connectionString)
    decisionUrl.searchParams.set('application_name', decisionApplicationName)
    const reportDatabase = createDatabase(reportUrl.toString())
    const decisionDatabase = createDatabase(decisionUrl.toString())
    const reporting = repository(reportDatabase)
    const deciding = repository(decisionDatabase)

    const reportPromise = reporting.report('scene-b', report('report-shadow-race', 'subject-2'), reportIdentity(3), NOW)
    const decisionPromise = deciding.decide(
      decision('decision-shadow-race', 'subject-1', 'shadow-hidden'),
      decisionIdentity(4),
      NOW
    )

    const deadline = Date.now() + 5_000
    let waiting = 0
    while (waiting < 2 && Date.now() < deadline) {
      const activity = await admin.query<{ count: string }>(
        `SELECT count(*)
         FROM pg_stat_activity
         WHERE application_name = ANY($1::text[])
           AND wait_event_type = 'Lock'`,
        [[reportApplicationName, decisionApplicationName]]
      )
      waiting = Number(activity.rows[0]?.count ?? 0)
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await blocker.query('COMMIT')

    const [reportOutcome, decisionOutcome] = await Promise.allSettled([reportPromise, decisionPromise])
    await Promise.all([reportDatabase.close(), decisionDatabase.close()])
    await blocker.end()

    expect(waiting).toBe(2)
    if (reportOutcome.status === 'rejected') throw reportOutcome.reason
    if (decisionOutcome.status === 'rejected') throw decisionOutcome.reason
    expect(['reported', 'subject-unavailable']).toContain(reportOutcome.value.status)
    expect(decisionOutcome.value).toMatchObject({ status: 'applied', action: 'shadow-hidden' })

    const invariant = await inspect.query<{
      active_hides: string
      shadow_decisions: string
      shadow_audits: string
      open_reports: string
    }>(
      `SELECT
         (SELECT count(*) FROM shadow_hides WHERE author_address = $1 AND lifted_at IS NULL) AS active_hides,
         (SELECT count(*) FROM moderation_decisions WHERE action = 'shadow-hidden') AS shadow_decisions,
         (SELECT count(*) FROM moderation_audit WHERE action = 'shadow-hidden') AS shadow_audits,
         (SELECT count(*)
          FROM moderation_reports AS reports
          JOIN moderation_subjects AS subjects ON subjects.id = reports.subject_id
          WHERE subjects.author_address = $1
            AND reports.status = 'open') AS open_reports`,
      [ACTOR_A]
    )
    expect(invariant.rows).toEqual([
      { active_hides: '1', shadow_decisions: '1', shadow_audits: '1', open_reports: '0' }
    ])
    await expect(moderation.queue(MODERATOR)).resolves.toEqual({ status: 'data', rows: [] })
  })

  it('serializes a report racing a tombstone so no open report survives unavailable content', async () => {
    const moderation = repository()
    await moderation.publish('scene-a', subject('subject-1', 'Race target'), publishIdentity(ACTOR_A, 1), NOW)

    const blocker = new Client({ connectionString })
    await blocker.connect()
    await blocker.query('BEGIN')
    await blocker.query("SELECT 1 FROM moderation_subjects WHERE id = 'subject-1' FOR UPDATE")

    const raceTag = schema.slice(-12)
    const reportApplicationName = `gl_report_tomb_${raceTag}`
    const decisionApplicationName = `gl_decide_tomb_${raceTag}`
    const reportUrl = new URL(connectionString)
    reportUrl.searchParams.set('application_name', reportApplicationName)
    const decisionUrl = new URL(connectionString)
    decisionUrl.searchParams.set('application_name', decisionApplicationName)
    const reportDatabase = createDatabase(reportUrl.toString())
    const decisionDatabase = createDatabase(decisionUrl.toString())
    const reporting = repository(reportDatabase)
    const deciding = repository(decisionDatabase)

    const reportPromise = reporting.report('scene-a', report('report-race', 'subject-1'), reportIdentity(2), NOW)
    const decisionPromise = deciding.decide(
      decision('decision-race', 'subject-1', 'tombstoned'),
      decisionIdentity(3),
      NOW
    )

    const applicationNames = [reportApplicationName, decisionApplicationName]
    const deadline = Date.now() + 5_000
    let waiting = 0
    while (waiting < 2 && Date.now() < deadline) {
      const activity = await admin.query<{ count: string }>(
        `SELECT count(*)
         FROM pg_stat_activity
         WHERE application_name = ANY($1::text[])
           AND wait_event_type = 'Lock'`,
        [applicationNames]
      )
      waiting = Number(activity.rows[0]?.count ?? 0)
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await blocker.query('COMMIT')

    const [reportOutcome, decisionOutcome] = await Promise.allSettled([reportPromise, decisionPromise])
    await Promise.all([reportDatabase.close(), decisionDatabase.close()])
    await blocker.end()

    expect(waiting).toBe(2)
    if (reportOutcome.status === 'rejected') throw reportOutcome.reason
    if (decisionOutcome.status === 'rejected') throw decisionOutcome.reason
    const reportResult = reportOutcome.value
    const decisionResult = decisionOutcome.value
    expect(['reported', 'subject-unavailable']).toContain(reportResult.status)
    expect(decisionResult).toMatchObject({ status: 'applied', subjectStatus: 'tombstoned' })

    const invariant = await inspect.query<{ status: string; open_reports: string }>(
      `SELECT
         subjects.status,
         (SELECT count(*) FROM moderation_reports WHERE subject_id = subjects.id AND status = 'open') AS open_reports
       FROM moderation_subjects AS subjects
       WHERE subjects.id = 'subject-1'`
    )
    expect(invariant.rows).toEqual([{ status: 'tombstoned', open_reports: '0' }])
  })

  it('rolls back a failed decision, including rate, transition, resolution, decision, and audit, then permits retry', async () => {
    const moderation = repository()
    await moderation.publish('scene-a', subject('subject-1', 'Rollback target'), publishIdentity(ACTOR_A, 1), NOW)
    await moderation.report('scene-a', report('report-1', 'subject-1'), reportIdentity(2), NOW)
    await inspect.query(
      "ALTER TABLE moderation_audit ADD CONSTRAINT reject_quarantine_audit CHECK (action <> 'quarantined')"
    )

    try {
      await expect(
        moderation.decide(decision('decision-1', 'subject-1', 'quarantined'), decisionIdentity(3), NOW)
      ).rejects.toThrow()
      const rolledBack = await inspect.query<{
        subject_status: string
        report_status: string
        decisions: string
        decision_rates: string
      }>(
        `SELECT
           (SELECT status FROM moderation_subjects WHERE id = 'subject-1') AS subject_status,
           (SELECT status FROM moderation_reports WHERE id = 'report-1') AS report_status,
           (SELECT count(*) FROM moderation_decisions) AS decisions,
           (SELECT count(*) FROM rate_buckets WHERE scope = 'decision') AS decision_rates`
      )
      expect(rolledBack.rows).toEqual([
        { subject_status: 'published', report_status: 'open', decisions: '0', decision_rates: '0' }
      ])
    } finally {
      await inspect.query('ALTER TABLE moderation_audit DROP CONSTRAINT reject_quarantine_audit')
    }

    await expect(
      moderation.decide(decision('decision-1', 'subject-1', 'quarantined'), decisionIdentity(3), NOW)
    ).resolves.toEqual({
      status: 'applied',
      action: 'quarantined',
      subjectStatus: 'quarantined',
      resolvedReports: 1
    })
  })
})
