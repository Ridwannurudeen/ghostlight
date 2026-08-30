import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  ModerationAction,
  ModerationDecisionInput,
  ModerationReportInput,
  PublishSubject
} from '../src/contracts.js'
import type {
  DatabaseClient,
  DatabaseConnectionSource,
  DatabaseQueryResult,
  DatabaseRow,
  DatabaseValue
} from '../src/database.js'
import {
  ModerationRepository,
  type ModerationDecisionIdentity,
  type ModerationPublishIdentity,
  type ModerationReportIdentity
} from '../src/moderation-repository.js'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const CATALYST = 'https://peer.decentraland.org'
const ACTOR = `0x${'11'.repeat(20)}`
const MODERATOR = `0x${'22'.repeat(20)}`
const BUCKET_HASH = Buffer.alloc(32, 7)
const AUDIT_DIGEST = Buffer.alloc(32, 8)
const REPORTER_DIGEST = Buffer.alloc(32, 9)

const PUBLISH_IDENTITY: ModerationPublishIdentity = Object.freeze({
  actorAddress: ACTOR,
  bucketHash: BUCKET_HASH,
  auditDigest: AUDIT_DIGEST
})
const REPORT_IDENTITY: ModerationReportIdentity = Object.freeze({
  scope: 'report-wallet',
  bucketHash: BUCKET_HASH,
  reporterDigest: REPORTER_DIGEST,
  auditDigest: AUDIT_DIGEST
})
const DECISION_IDENTITY: ModerationDecisionIdentity = Object.freeze({
  actorAddress: MODERATOR,
  bucketHash: BUCKET_HASH,
  auditDigest: AUDIT_DIGEST
})

type QueryCall = Readonly<{ text: string; values: readonly DatabaseValue[] }>
type QueryStep = Readonly<{ result?: DatabaseQueryResult; error?: Error }>

const emptyResult = (rowCount = 0): DatabaseQueryResult => ({ rowCount, rows: [] })
const oneRow = (row: DatabaseRow = {}): DatabaseQueryResult => ({ rowCount: 1, rows: [row] })
const rowsResult = (rows: readonly DatabaseRow[]): DatabaseQueryResult => ({ rowCount: rows.length, rows })

class ScriptedClient implements DatabaseClient {
  readonly calls: QueryCall[] = []
  readonly releases: (Error | boolean | undefined)[] = []

  constructor(private readonly steps: QueryStep[]) {}

  async query(text: string, values: readonly DatabaseValue[] = []) {
    this.calls.push({ text, values: [...values] })
    const step = this.steps.shift()
    if (!step) throw new Error(`Unexpected query: ${text}`)
    if (step.error) throw step.error
    return step.result ?? emptyResult()
  }

  release(error?: Error | boolean) {
    this.releases.push(error)
  }

  assertComplete() {
    expect(this.steps).toEqual([])
  }
}

class ScriptedDatabase implements DatabaseConnectionSource {
  connectCount = 0

  constructor(private readonly clients: readonly ScriptedClient[]) {}

  async connect() {
    const client = this.clients[this.connectCount]
    this.connectCount += 1
    if (!client) throw new Error('Unexpected database connection')
    return client
  }
}

function repository(database: DatabaseConnectionSource, allowedSceneIds: readonly string[] = ['scene-a']) {
  return new ModerationRepository(database, {
    allowedSceneIds,
    trustedCatalystUrl: CATALYST,
    publishPerHour: 2,
    reportWalletPerHour: 3,
    reportGuestPerHour: 1,
    decisionPerMinute: 4
  })
}

function subject(overrides: Partial<PublishSubject> = {}): PublishSubject {
  return Object.freeze({
    id: 'subject-1',
    content: 'The ghost bows.',
    channel: 'untrusted',
    touringConsent: true,
    createdAt: NOW,
    ...overrides
  })
}

function report(overrides: Partial<ModerationReportInput> = {}): ModerationReportInput {
  return Object.freeze({
    id: 'report-1',
    contentId: 'subject-1',
    reason: 'abuse',
    createdAt: NOW,
    status: 'open',
    ...overrides
  })
}

function decision(
  action: ModerationAction = 'quarantined',
  overrides: Partial<ModerationDecisionInput> = {}
): ModerationDecisionInput {
  return Object.freeze({
    id: `decision-${action}`,
    subjectId: 'subject-1',
    action,
    reason: `Confirmed ${action}`,
    createdAt: NOW,
    ...overrides
  })
}

function subjectRow(overrides: DatabaseRow = {}): DatabaseRow {
  return {
    id: 'subject-1',
    sceneId: 'scene-a',
    authorAddress: ACTOR,
    content: 'The ghost bows.',
    channel: 'untrusted',
    status: 'published',
    touringConsent: true,
    createdAt: new Date(NOW),
    deletedAt: null,
    ...overrides
  }
}

function queueRow(overrides: DatabaseRow = {}): DatabaseRow {
  return {
    reportId: 'report-1',
    subjectId: 'subject-1',
    sceneId: 'scene-a',
    authorAddress: ACTOR,
    content: 'The ghost bows.',
    channel: 'untrusted',
    touringConsent: true,
    subjectStatus: 'published',
    reason: 'abuse',
    reportedAt: new Date(NOW),
    ...overrides
  }
}

function exactDecisionRow(input: ModerationDecisionInput, exactClientTimestamp = true): DatabaseRow {
  return {
    id: input.id,
    subjectId: input.subjectId,
    action: input.action,
    reason: input.reason,
    moderatorAddress: MODERATOR,
    exactClientTimestamp
  }
}

describe('moderation repository configuration and boundaries', () => {
  it('copies valid scene configuration and rejects invalid rates, scenes, and Catalyst values', async () => {
    const configuredScenes = ['scene-a']
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: oneRow(subjectRow()) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]), configuredScenes)
    configuredScenes.push('scene-b')

    await expect(moderation.publish('scene-b', subject(), PUBLISH_IDENTITY, NOW)).resolves.toEqual({
      status: 'scene-not-allowed'
    })
    await expect(moderation.publish('scene-a', subject(), PUBLISH_IDENTITY, NOW)).resolves.toMatchObject({
      status: 'published'
    })
    client.assertComplete()

    const database = new ScriptedDatabase([])
    expect(
      () =>
        new ModerationRepository(database, {
          allowedSceneIds: [],
          trustedCatalystUrl: CATALYST,
          publishPerHour: 1,
          reportWalletPerHour: 1,
          reportGuestPerHour: 1,
          decisionPerMinute: 1
        })
    ).toThrow('Invalid moderation scene configuration')
    expect(
      () =>
        new ModerationRepository(database, {
          allowedSceneIds: ['scene-a'],
          trustedCatalystUrl: ' catalyst ',
          publishPerHour: 1,
          reportWalletPerHour: 1,
          reportGuestPerHour: 1,
          decisionPerMinute: 1
        })
    ).toThrow('Invalid moderation Catalyst configuration')
    expect(
      () =>
        new ModerationRepository(database, {
          allowedSceneIds: ['scene-a'],
          trustedCatalystUrl: CATALYST,
          publishPerHour: 0,
          reportWalletPerHour: 1,
          reportGuestPerHour: 1,
          decisionPerMinute: 1
        })
    ).toThrow('publishPerHour must be between 1 and 100000')
  })

  it('rejects malformed identities and current timestamps before connecting', async () => {
    const database = new ScriptedDatabase([])
    const moderation = repository(database)

    await expect(
      moderation.publish('scene-a', subject(), { ...PUBLISH_IDENTITY, actorAddress: ACTOR.toUpperCase() }, NOW)
    ).rejects.toThrow('Invalid moderation publish actor address')
    await expect(
      moderation.publish('scene-a', subject(), { ...PUBLISH_IDENTITY, bucketHash: Buffer.alloc(31) }, NOW)
    ).rejects.toThrow('Moderation publish bucket hash must be 32 bytes')
    await expect(
      moderation.report('scene-a', report(), { ...REPORT_IDENTITY, scope: 'invalid' as 'report-wallet' }, NOW)
    ).rejects.toThrow('Invalid moderation report rate scope')
    await expect(moderation.queue(MODERATOR.toUpperCase())).rejects.toThrow('Invalid moderation queue actor address')
    await expect(moderation.eligible('subject\0id')).rejects.toThrow('Invalid moderation eligibility subject id')
    await expect(moderation.report('scene-a', { ...report(), id: 'report\0id' }, REPORT_IDENTITY, NOW)).rejects.toThrow(
      'Invalid moderation report id'
    )
    await expect(moderation.decide({ ...decision(), reason: 'reason\0text' }, DECISION_IDENTITY, NOW)).rejects.toThrow(
      'Invalid moderation decision reason'
    )
    await expect(
      moderation.decide({ ...decision(), action: 'published' as ModerationAction }, DECISION_IDENTITY, NOW)
    ).rejects.toThrow('Invalid moderation decision')
    await expect(
      moderation.decide(decision(), { ...DECISION_IDENTITY, auditDigest: Buffer.alloc(31) }, NOW)
    ).rejects.toThrow('Moderation decision audit digest must be 32 bytes')
    await expect(moderation.publish('scene-a', subject(), PUBLISH_IDENTITY, -1)).rejects.toThrow(
      'Invalid current timestamp'
    )
    expect(database.connectCount).toBe(0)
  })

  it('uses a narrow server-time window before any database mutation', async () => {
    const database = new ScriptedDatabase([])
    const moderation = repository(database)

    await expect(
      moderation.publish('scene-a', subject({ createdAt: NOW - 5 * 60 * 1_000 - 1 }), PUBLISH_IDENTITY, NOW)
    ).resolves.toEqual({ status: 'timestamp-out-of-range' })
    await expect(
      moderation.report('scene-a', report({ createdAt: NOW + 60 * 1_000 + 1 }), REPORT_IDENTITY, NOW)
    ).resolves.toEqual({ status: 'timestamp-out-of-range' })
    await expect(
      moderation.decide(decision('quarantined', { createdAt: NOW - 5 * 60 * 1_000 - 1 }), DECISION_IDENTITY, NOW)
    ).resolves.toEqual({ status: 'timestamp-out-of-range' })
    expect(database.connectCount).toBe(0)
  })
})

describe('transactional untrusted publishing', () => {
  it('locks the scene, spends the hourly bucket, stores a fixed SHA-256 fingerprint, and audits server time', async () => {
    const input = subject({ content: '  not reachable ' })
    const canonicalInput = subject({ content: 'ＮＯＴ—reachable' })
    const expectedFingerprint = createHash('sha256').update('not reachable').digest('hex')
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { result: oneRow(subjectRow({ content: canonicalInput.content })) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]))

    const result = await moderation.publish('scene-a', canonicalInput, PUBLISH_IDENTITY, NOW)

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM scene_allowlist'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      expect.stringContaining('INSERT INTO moderation_subjects'),
      expect.stringContaining('INSERT INTO moderation_audit'),
      'COMMIT'
    ])
    expect(client.calls[1]?.text).toContain('FOR KEY SHARE')
    expect(client.calls[1]?.values).toEqual(['scene-a', CATALYST])
    expect(client.calls[2]?.text).toContain("date_trunc('hour'")
    expect(client.calls[2]?.values).toEqual(['publish', BUCKET_HASH, 2, new Date(NOW)])
    expect(client.calls[2]?.values[1]).not.toBe(BUCKET_HASH)
    expect(client.calls[3]?.values).toEqual([
      canonicalInput.id,
      'scene-a',
      ACTOR,
      canonicalInput.content,
      expectedFingerprint,
      true,
      new Date(NOW)
    ])
    expect(client.calls[4]?.values).toEqual([
      'published',
      null,
      AUDIT_DIGEST,
      canonicalInput.id,
      new Date(NOW),
      JSON.stringify({ clientCreatedAt: NOW })
    ])
    expect(client.calls[4]?.values[2]).not.toBe(AUDIT_DIGEST)
    expect(result).toEqual({
      status: 'published',
      subject: {
        id: 'subject-1',
        sceneId: 'scene-a',
        authorAddress: ACTOR,
        content: canonicalInput.content,
        channel: 'untrusted',
        status: 'published',
        touringConsent: true,
        createdAt: NOW,
        deletedAt: null
      }
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.status === 'published' && Object.isFrozen(result.subject)).toBe(true)
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
    expect(input.content).not.toBe(canonicalInput.content)
  })

  it('rejects separator-only content without connecting and rolls back a missing persisted scene or full rate bucket', async () => {
    const missingScene = new ScriptedClient([
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const fullRate = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const database = new ScriptedDatabase([missingScene, fullRate])
    const moderation = repository(database)

    await expect(moderation.publish('scene-a', subject({ content: '— !!!' }), PUBLISH_IDENTITY, NOW)).resolves.toEqual({
      status: 'invalid-content'
    })
    await expect(
      moderation.publish('scene-a', subject({ content: 'ghost\0bows' }), PUBLISH_IDENTITY, NOW)
    ).resolves.toEqual({ status: 'invalid-content' })
    await expect(moderation.publish('scene-a', subject(), PUBLISH_IDENTITY, NOW)).resolves.toEqual({
      status: 'scene-not-allowed'
    })
    await expect(moderation.publish('scene-a', subject(), PUBLISH_IDENTITY, NOW)).resolves.toEqual({
      status: 'rate-limited'
    })

    expect(database.connectCount).toBe(2)
    expect(missingScene.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM scene_allowlist'),
      'ROLLBACK'
    ])
    expect(fullRate.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM scene_allowlist'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      'ROLLBACK'
    ])
    missingScene.assertComplete()
    fullRate.assertComplete()
  })

  it('classifies exact replay and changed ID reuse after consuming rate', async () => {
    const fingerprint = createHash('sha256').update('the ghost bows').digest('hex')
    const replay = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow(subjectRow({ fingerprint, exactClientTimestamp: true })) },
      { result: emptyResult() }
    ])
    const conflict = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow(subjectRow({ fingerprint, exactClientTimestamp: false })) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([replay, conflict]))

    await expect(moderation.publish('scene-a', subject(), PUBLISH_IDENTITY, NOW)).resolves.toMatchObject({
      status: 'replay'
    })
    await expect(moderation.publish('scene-a', subject(), PUBLISH_IDENTITY, NOW)).resolves.toEqual({
      status: 'id-conflict'
    })

    expect(replay.calls[2]?.text).toContain('INSERT INTO rate_buckets')
    expect(replay.calls.at(-1)?.text).toBe('COMMIT')
    expect(conflict.calls[5]?.values).toEqual([
      'publish-rejected',
      null,
      AUDIT_DIGEST,
      null,
      new Date(NOW),
      JSON.stringify({ clientCreatedAt: NOW, reason: 'id-conflict', requestedSubjectId: 'subject-1' })
    ])
    expect(conflict.calls.at(-1)?.text).toBe('COMMIT')
    replay.assertComplete()
    conflict.assertComplete()
  })

  it('detects global NFKC/case/separator duplicates and audits without exposing the normalized text', async () => {
    const input = subject({ id: 'subject-2', content: 'ＧＨＯＳＴ—BOWS' })
    const fingerprint = createHash('sha256').update('ghost bows').digest('hex')
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: oneRow({ id: 'subject-1' }) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]))

    await expect(moderation.publish('scene-a', input, PUBLISH_IDENTITY, NOW)).resolves.toEqual({
      status: 'duplicate-content',
      duplicateOf: 'subject-1'
    })

    expect(client.calls[3]?.values?.[4]).toBe(fingerprint)
    expect(client.calls[5]?.text).toContain("status <> 'tombstoned'")
    expect(client.calls[5]?.text).not.toContain('scene_id')
    expect(client.calls[6]?.values?.[1]).toBeNull()
    expect(client.calls[6]?.values?.[3]).toBeNull()
    expect(client.calls[6]?.values?.[5]).toBe(
      JSON.stringify({
        clientCreatedAt: NOW,
        duplicateOf: 'subject-1',
        reason: 'duplicate-content',
        requestedSubjectId: 'subject-2'
      })
    )
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
    client.assertComplete()
  })

  it('rolls back failures and destroys a client when rollback also fails', async () => {
    const writeFailure = new Error('subject write failed')
    const rollbackFailure = new Error('rollback failed')
    const ordinary = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { error: writeFailure },
      { result: emptyResult() }
    ])
    const brokenRollback = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { error: writeFailure },
      { error: rollbackFailure }
    ])
    const moderation = repository(new ScriptedDatabase([ordinary, brokenRollback]))

    await expect(moderation.publish('scene-a', subject(), PUBLISH_IDENTITY, NOW)).rejects.toBe(writeFailure)
    const combined = await moderation
      .publish('scene-a', subject(), PUBLISH_IDENTITY, NOW)
      .catch((error: unknown) => error)

    expect(ordinary.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(ordinary.releases).toEqual([undefined])
    expect(combined).toBeInstanceOf(AggregateError)
    expect((combined as AggregateError).errors).toEqual([writeFailure, rollbackFailure])
    expect(brokenRollback.releases).toEqual([rollbackFailure])
    ordinary.assertComplete()
    brokenRollback.assertComplete()
  })
})

describe('transactional pseudonymous reporting', () => {
  it('spends the scoped hourly rate, uses server ordering time, and never writes a reporter address', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: oneRow({ authorAddress: ACTOR, status: 'published' }) },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: oneRow({ id: 'report-1' }) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]))

    await expect(moderation.report('scene-a', report(), REPORT_IDENTITY, NOW)).resolves.toEqual({
      status: 'reported'
    })

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM scene_allowlist'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      expect.stringContaining('FROM moderation_subjects'),
      expect.stringContaining('FROM moderation_reports'),
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('FROM shadow_hides'),
      expect.stringContaining('INSERT INTO moderation_reports'),
      expect.stringContaining('INSERT INTO moderation_audit'),
      'COMMIT'
    ])
    expect(client.calls[2]?.values).toEqual(['report-wallet', BUCKET_HASH, 3, new Date(NOW)])
    expect(client.calls[3]?.text).toContain('FOR UPDATE')
    expect(client.calls[5]?.values).toEqual([ACTOR])
    expect(client.calls[6]?.values).toEqual([ACTOR])
    expect(client.calls[7]?.values).toEqual(['report-1', 'subject-1', REPORTER_DIGEST, 'abuse', new Date(NOW)])
    expect(client.calls[8]?.values).toEqual([
      'reported',
      null,
      AUDIT_DIGEST,
      'subject-1',
      new Date(NOW),
      JSON.stringify({
        clientCreatedAt: NOW,
        reason: 'abuse',
        reportId: 'report-1',
        reportingSceneId: 'scene-a'
      })
    ])
    expect(client.calls[7]?.values[2]).not.toBe(REPORTER_DIGEST)
    expect(client.calls[8]?.values[2]).not.toBe(AUDIT_DIGEST)
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('uses the guest limit and handles persisted-scene, rate, missing-subject, and unavailable-subject results', async () => {
    const missingScene = new ScriptedClient([
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const fullRate = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const missingSubject = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const unavailableSubject = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: oneRow({ status: 'quarantined' }) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const shadowHiddenSubject = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: oneRow({ authorAddress: ACTOR, status: 'published' }) },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: oneRow() },
      { result: emptyResult() }
    ])
    const guest = Object.freeze({ ...REPORT_IDENTITY, scope: 'report-guest' as const })
    const moderation = repository(
      new ScriptedDatabase([missingScene, fullRate, missingSubject, unavailableSubject, shadowHiddenSubject])
    )

    await expect(moderation.report('scene-a', report(), guest, NOW)).resolves.toEqual({
      status: 'scene-not-allowed'
    })
    await expect(moderation.report('scene-a', report(), guest, NOW)).resolves.toEqual({ status: 'rate-limited' })
    await expect(moderation.report('scene-a', report(), guest, NOW)).resolves.toEqual({
      status: 'subject-not-found'
    })
    await expect(moderation.report('scene-a', report(), guest, NOW)).resolves.toEqual({
      status: 'subject-unavailable'
    })
    await expect(moderation.report('scene-a', report(), guest, NOW)).resolves.toEqual({
      status: 'subject-unavailable'
    })

    expect(fullRate.calls[2]?.values).toEqual(['report-guest', BUCKET_HASH, 1, new Date(NOW)])
    expect(missingSubject.calls.at(-1)?.text).toBe('COMMIT')
    expect(unavailableSubject.calls.at(-1)?.text).toBe('COMMIT')
    expect(shadowHiddenSubject.calls[5]?.text).toContain('pg_advisory_xact_lock')
    expect(shadowHiddenSubject.calls[6]?.text).toContain('FROM shadow_hides')
    expect(shadowHiddenSubject.calls.some(({ text }) => text.includes('INSERT INTO moderation_reports'))).toBe(false)
    for (const client of [missingScene, fullRate, missingSubject, unavailableSubject, shadowHiddenSubject]) {
      client.assertComplete()
    }
  })

  it('classifies a reused global report ID before returning a missing-subject result', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      {
        result: oneRow({
          id: 'report-1',
          subjectId: 'subject-existing',
          reporterDigest: REPORTER_DIGEST,
          reason: 'other',
          exactClientTimestamp: true
        })
      },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]))

    await expect(
      moderation.report('scene-a', report({ contentId: 'subject-missing' }), REPORT_IDENTITY, NOW)
    ).resolves.toEqual({ status: 'report-id-conflict' })

    expect(client.calls[3]?.text).toContain('FROM moderation_subjects')
    expect(client.calls[4]?.text).toContain('FROM moderation_reports')
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
    client.assertComplete()
  })

  it('classifies replay, ID conflict, and same-reporter duplicate after consuming rate', async () => {
    const base = (status = 'published') => [
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: oneRow({ authorAddress: ACTOR, status }) }
    ]
    const replay = new ScriptedClient([
      ...base('quarantined'),
      {
        result: oneRow({
          id: 'report-1',
          subjectId: 'subject-1',
          reporterDigest: REPORTER_DIGEST,
          reason: 'abuse',
          exactClientTimestamp: true
        })
      },
      { result: emptyResult() }
    ])
    const conflict = new ScriptedClient([
      ...base(),
      {
        result: oneRow({
          id: 'report-1',
          subjectId: 'subject-1',
          reporterDigest: REPORTER_DIGEST,
          reason: 'other',
          exactClientTimestamp: true
        })
      },
      { result: emptyResult() }
    ])
    const duplicate = new ScriptedClient([
      ...base(),
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: oneRow({ id: 'report-original' }) },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([replay, conflict, duplicate]))

    await expect(moderation.report('scene-a', report(), REPORT_IDENTITY, NOW)).resolves.toEqual({ status: 'replay' })
    await expect(moderation.report('scene-a', report(), REPORT_IDENTITY, NOW)).resolves.toEqual({
      status: 'report-id-conflict'
    })
    await expect(moderation.report('scene-a', report({ id: 'report-2' }), REPORT_IDENTITY, NOW)).resolves.toEqual({
      status: 'duplicate-report',
      reportId: 'report-original'
    })

    for (const client of [replay, conflict, duplicate]) {
      expect(client.calls[2]?.text).toContain('INSERT INTO rate_buckets')
      expect(client.calls.at(-1)?.text).toBe('COMMIT')
      client.assertComplete()
    }
  })

  it('rolls back report write failures and releases the connection', async () => {
    const failure = new Error('report insert failed')
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: oneRow({ authorAddress: ACTOR, status: 'published' }) },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() },
      { error: failure },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]))

    await expect(moderation.report('scene-a', report(), REPORT_IDENTITY, NOW)).rejects.toBe(failure)

    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })
})

describe('moderator queue and public eligibility', () => {
  it('locks moderator authority and returns a fixed, oldest-first queue without reporter digests', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: rowsResult([queueRow(), queueRow({ reportId: 'report-2', reason: 'other' })]) },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]))

    const result = await moderation.queue(MODERATOR)

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      expect.stringContaining('FROM moderation_reports'),
      'COMMIT'
    ])
    expect(client.calls[1]?.text).toContain("role = 'moderator'")
    expect(client.calls[1]?.text).toContain('FOR KEY SHARE')
    expect(client.calls[2]?.text).toContain("WHERE reports.status = 'open'")
    expect(client.calls[2]?.text).toContain('FROM shadow_hides')
    expect(client.calls[2]?.text).toContain('hides.lifted_at IS NULL')
    expect(client.calls[2]?.text).toContain('ORDER BY reports.created_at ASC, reports.id ASC')
    expect(client.calls[2]?.text).toContain('LIMIT 50')
    expect(client.calls[2]?.text).not.toContain('reporter_digest')
    expect(result).toEqual({
      status: 'data',
      rows: [
        {
          reportId: 'report-1',
          subjectId: 'subject-1',
          sceneId: 'scene-a',
          authorAddress: ACTOR,
          content: 'The ghost bows.',
          channel: 'untrusted',
          touringConsent: true,
          subjectStatus: 'published',
          reason: 'abuse',
          reportedAt: NOW
        },
        {
          reportId: 'report-2',
          subjectId: 'subject-1',
          sceneId: 'scene-a',
          authorAddress: ACTOR,
          content: 'The ghost bows.',
          channel: 'untrusted',
          touringConsent: true,
          subjectStatus: 'published',
          reason: 'other',
          reportedAt: NOW
        }
      ]
    })
    expect(result.status === 'data' && Object.isFrozen(result.rows)).toBe(true)
    client.assertComplete()
  })

  it('denies non-moderators before reading the queue and rolls back malformed database rows', async () => {
    const unauthorized = new ScriptedClient([
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const malformed = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow(queueRow({ reportedAt: NOW })) },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([unauthorized, malformed]))

    await expect(moderation.queue(ACTOR)).resolves.toEqual({ status: 'unauthorized' })
    await expect(moderation.queue(MODERATOR)).rejects.toThrow('Invalid moderation queue reportedAt')

    expect(unauthorized.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      'ROLLBACK'
    ])
    expect(malformed.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(malformed.releases).toEqual([undefined])
    unauthorized.assertComplete()
    malformed.assertComplete()
  })

  it('collapses unknown, non-published, and active shadow-hidden subjects into unavailable eligibility', async () => {
    const eligible = new ScriptedClient([{ result: oneRow(subjectRow({ channel: 'trusted' })) }])
    const unavailable = new ScriptedClient([{ result: emptyResult() }])
    const moderation = repository(new ScriptedDatabase([eligible, unavailable]))

    await expect(moderation.eligible('subject-1')).resolves.toMatchObject({ status: 'eligible' })
    await expect(moderation.eligible('subject-2')).resolves.toEqual({ status: 'unavailable' })

    expect(eligible.calls[0]?.text).toContain("subjects.status = 'published'")
    expect(eligible.calls[0]?.text).toContain("subjects.channel IN ('curated', 'trusted')")
    expect(eligible.calls[0]?.text).toContain('FROM shadow_hides')
    expect(eligible.calls[0]?.text).toContain('hides.lifted_at IS NULL')
    expect(eligible.releases).toEqual([undefined])
    expect(unavailable.releases).toEqual([undefined])
    eligible.assertComplete()
    unavailable.assertComplete()
  })
})

describe('transactional moderator decisions', () => {
  it('checks role before rate and rate before decision state', async () => {
    const unauthorized = new ScriptedClient([
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const fullRate = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([unauthorized, fullRate]))

    await expect(moderation.decide(decision(), { ...DECISION_IDENTITY, actorAddress: ACTOR }, NOW)).resolves.toEqual({
      status: 'unauthorized'
    })
    await expect(moderation.decide(decision(), DECISION_IDENTITY, NOW)).resolves.toEqual({
      status: 'rate-limited'
    })

    expect(unauthorized.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      'ROLLBACK'
    ])
    expect(fullRate.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      'ROLLBACK'
    ])
    expect(fullRate.calls[2]?.text).toContain("date_trunc('minute'")
    expect(fullRate.calls[2]?.values).toEqual([BUCKET_HASH, 4, new Date(NOW)])
    unauthorized.assertComplete()
    fullRate.assertComplete()
  })

  it.each([
    {
      action: 'quarantined' as const,
      initialStatus: 'published' as const,
      transition: "SET status = 'quarantined'",
      subjectStatus: 'quarantined' as const
    },
    {
      action: 'tombstoned' as const,
      initialStatus: 'published' as const,
      transition: "SET status = 'tombstoned'",
      subjectStatus: 'tombstoned' as const
    },
    {
      action: 'shadow-hidden' as const,
      initialStatus: 'published' as const,
      transition: 'INSERT INTO shadow_hides',
      subjectStatus: 'published' as const
    },
    {
      action: 'shadow-hidden' as const,
      initialStatus: 'tombstoned' as const,
      transition: 'INSERT INTO shadow_hides',
      subjectStatus: 'tombstoned' as const
    }
  ])('applies $action, resolves every open report, and audits in one transaction', async (scenario) => {
    const input = decision(scenario.action)
    const shadowChecks: QueryStep[] =
      scenario.action === 'shadow-hidden'
        ? [{ result: emptyResult() }, { result: emptyResult() }, { result: emptyResult() }]
        : []
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ authorAddress: ACTOR, status: scenario.initialStatus }) },
      { result: emptyResult() },
      ...shadowChecks,
      { result: oneRow({ id: input.id }) },
      {
        result:
          scenario.action === 'shadow-hidden'
            ? oneRow({ author_address: ACTOR })
            : oneRow({ status: scenario.subjectStatus })
      },
      { result: emptyResult(2) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]))

    await expect(moderation.decide(input, DECISION_IDENTITY, NOW)).resolves.toEqual({
      status: 'applied',
      action: scenario.action,
      subjectStatus: scenario.subjectStatus,
      resolvedReports: 2
    })

    const shadowQueries =
      scenario.action === 'shadow-hidden'
        ? [
            expect.stringContaining('pg_advisory_xact_lock'),
            expect.stringContaining('FROM moderation_decisions'),
            expect.stringContaining('FROM shadow_hides')
          ]
        : []
    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      expect.stringContaining('FROM moderation_decisions'),
      expect.stringContaining('FROM moderation_subjects'),
      expect.stringContaining('FROM moderation_decisions'),
      ...shadowQueries,
      expect.stringContaining('INSERT INTO moderation_decisions'),
      expect.stringContaining(scenario.transition),
      expect.stringContaining('UPDATE moderation_reports'),
      expect.stringContaining('INSERT INTO moderation_audit'),
      'COMMIT'
    ])
    expect(client.calls[4]?.text).toContain('FOR UPDATE')
    const decisionInsertIndex = scenario.action === 'shadow-hidden' ? 9 : 6
    expect(client.calls[decisionInsertIndex]?.values).toEqual([
      input.id,
      'subject-1',
      scenario.action,
      input.reason,
      MODERATOR,
      new Date(NOW)
    ])
    expect(client.calls[decisionInsertIndex + 2]?.text).toContain("status = 'open'")
    expect(client.calls[decisionInsertIndex + 3]?.values).toEqual([
      scenario.action,
      MODERATOR,
      AUDIT_DIGEST,
      'subject-1',
      new Date(NOW),
      JSON.stringify({ clientCreatedAt: NOW, decisionId: input.id, reason: input.reason })
    ])
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('classifies exact replay and ID conflict only after spending rate', async () => {
    const input = decision()
    const replay = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: oneRow(exactDecisionRow(input)) },
      { result: oneRow({ authorAddress: ACTOR, status: 'quarantined' }) },
      { result: emptyResult() }
    ])
    const conflict = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: oneRow(exactDecisionRow(input, false)) },
      { result: oneRow({ authorAddress: ACTOR, status: 'published' }) },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([replay, conflict]))

    await expect(moderation.decide(input, DECISION_IDENTITY, NOW)).resolves.toEqual({ status: 'replay' })
    await expect(moderation.decide(input, DECISION_IDENTITY, NOW)).resolves.toEqual({
      status: 'decision-id-conflict'
    })

    for (const client of [replay, conflict]) {
      expect(client.calls[2]?.text).toContain('INSERT INTO rate_buckets')
      expect(client.calls.at(-1)?.text).toBe('COMMIT')
      client.assertComplete()
    }
  })

  it('commits spent rate for missing and terminal subjects and rechecks an ID race after the subject lock', async () => {
    const input = decision()
    const missing = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const terminal = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ authorAddress: ACTOR, status: 'tombstoned' }) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const raced = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ authorAddress: ACTOR, status: 'published' }) },
      { result: oneRow(exactDecisionRow(input)) },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([missing, terminal, raced]))

    await expect(moderation.decide(input, DECISION_IDENTITY, NOW)).resolves.toEqual({
      status: 'subject-not-found'
    })
    await expect(moderation.decide(input, DECISION_IDENTITY, NOW)).resolves.toEqual({
      status: 'subject-unavailable'
    })
    await expect(moderation.decide(input, DECISION_IDENTITY, NOW)).resolves.toEqual({ status: 'replay' })

    for (const client of [missing, terminal, raced]) {
      expect(client.calls[2]?.text).toContain('INSERT INTO rate_buckets')
      expect(client.calls.at(-1)?.text).toBe('COMMIT')
      client.assertComplete()
    }
  })

  it('classifies an insert conflict caused by a concurrent different-subject decision', async () => {
    const input = decision()
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ authorAddress: ACTOR, status: 'published' }) },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: oneRow(exactDecisionRow(input, false)) },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]))

    await expect(moderation.decide(input, DECISION_IDENTITY, NOW)).resolves.toEqual({
      status: 'decision-id-conflict'
    })

    expect(client.calls[6]?.text).toContain('ON CONFLICT (id) DO NOTHING')
    expect(client.calls[7]?.text).toContain('FROM moderation_decisions')
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
    client.assertComplete()
  })

  it('rejects non-monotonic quarantine and duplicate active shadow decisions before decision/audit writes', async () => {
    const nonMonotonic = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ authorAddress: ACTOR, status: 'quarantined' }) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const activeShadow = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ authorAddress: ACTOR, status: 'published' }) },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: oneRow() },
      { result: emptyResult(2) },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([nonMonotonic, activeShadow]))

    await expect(moderation.decide(decision(), DECISION_IDENTITY, NOW)).resolves.toEqual({
      status: 'subject-unavailable'
    })
    await expect(moderation.decide(decision('shadow-hidden'), DECISION_IDENTITY, NOW)).resolves.toEqual({
      status: 'subject-unavailable'
    })

    expect(nonMonotonic.calls.some(({ text }) => text.includes('INSERT INTO moderation_decisions'))).toBe(false)
    expect(activeShadow.calls[6]?.text).toContain('pg_advisory_xact_lock')
    expect(activeShadow.calls[7]?.text).toContain('FROM moderation_decisions')
    expect(activeShadow.calls[8]?.text).toContain('FROM shadow_hides')
    expect(activeShadow.calls[9]?.text).toContain('UPDATE moderation_reports')
    expect(activeShadow.calls[9]?.values).toEqual([ACTOR, new Date(NOW)])
    expect(activeShadow.calls.some(({ text }) => text.includes('INSERT INTO moderation_decisions'))).toBe(false)
    expect(nonMonotonic.calls.at(-1)?.text).toBe('COMMIT')
    expect(activeShadow.calls.at(-1)?.text).toBe('COMMIT')
    nonMonotonic.assertComplete()
    activeShadow.assertComplete()
  })

  it('reclassifies a shadow decision ID that appears while waiting on the author-wide lock', async () => {
    const input = decision('shadow-hidden')
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ authorAddress: ACTOR, status: 'published' }) },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: oneRow(exactDecisionRow(input)) },
      { result: emptyResult() }
    ])
    const moderation = repository(new ScriptedDatabase([client]))

    await expect(moderation.decide(input, DECISION_IDENTITY, NOW)).resolves.toEqual({ status: 'replay' })

    expect(client.calls[6]?.text).toContain('pg_advisory_xact_lock')
    expect(client.calls[7]?.text).toContain('FROM moderation_decisions')
    expect(client.calls.some(({ text }) => text.includes('FROM shadow_hides'))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
    client.assertComplete()
  })

  it('rolls back transition failures and preserves rollback failures', async () => {
    const transitionFailure = new Error('transition failed')
    const rollbackFailure = new Error('rollback failed')
    const stepsBeforeTransition: QueryStep[] = [
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ authorAddress: ACTOR, status: 'published' }) },
      { result: emptyResult() },
      { result: oneRow({ id: 'decision-quarantined' }) }
    ]
    const ordinary = new ScriptedClient([
      ...stepsBeforeTransition,
      { error: transitionFailure },
      { result: emptyResult() }
    ])
    const brokenRollback = new ScriptedClient([
      ...stepsBeforeTransition,
      { error: transitionFailure },
      { error: rollbackFailure }
    ])
    const moderation = repository(new ScriptedDatabase([ordinary, brokenRollback]))

    await expect(moderation.decide(decision(), DECISION_IDENTITY, NOW)).rejects.toBe(transitionFailure)
    const combined = await moderation.decide(decision(), DECISION_IDENTITY, NOW).catch((error: unknown) => error)

    expect(ordinary.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(ordinary.releases).toEqual([undefined])
    expect(combined).toBeInstanceOf(AggregateError)
    expect((combined as AggregateError).errors).toEqual([transitionFailure, rollbackFailure])
    expect(brokenRollback.releases).toEqual([rollbackFailure])
    ordinary.assertComplete()
    brokenRollback.assertComplete()
  })
})
