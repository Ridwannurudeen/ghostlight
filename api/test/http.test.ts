import { createHash } from 'node:crypto'
import { createPayload } from '@dcl/crypto-middleware'
import { Router, createTestServerComponent } from '@well-known-components/http-server'
import { describe, expect, it, vi } from 'vitest'
import type {
  AnalyticsExportRange,
  AnalyticsExportResult,
  AnalyticsExportRow
} from '../src/analytics-export-repository.js'
import type { AnalyticsRateIdentity, FunnelAnalyticsEvent, FunnelIngestResult } from '../src/analytics-repository.js'
import type { ApiAuthContext, SceneAuthContext, SceneMetadata } from '../src/auth.js'
import { parseConfig } from '../src/config.js'
import {
  MAX_FUNNEL_BODY_BYTES,
  MAX_MODERATION_BODY_BYTES,
  READINESS_CACHE_MILLISECONDS,
  createFunnelExportHandler,
  createFunnelHandler,
  createHttpRouter,
  createModerationAuditExportHandler,
  createModerationDecisionHandler,
  createModerationPublishHandler,
  createModerationQueueHandler,
  createModerationReportHandler,
  type FunnelExportRepository,
  type FunnelRepository,
  type ModerationAuditExportHttpRepository,
  type ModerationHttpRepository
} from '../src/http.js'
import type { ModerationAuditExportResult } from '../src/moderation-audit-export-repository.js'
import type {
  ModerationDecisionIdentity,
  ModerationDecisionResult,
  ModerationPublishIdentity,
  ModerationPublishResult,
  ModerationQueueResult,
  ModerationReportIdentity,
  ModerationReportResult,
  ModerationSubjectRow
} from '../src/moderation-repository.js'
import { seasonZeroCalendarSnapshot } from '../src/season-calendar.js'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const address = `0x${'1'.repeat(40)}`
const sceneId = 'bafkrei-ghostlight'
const exportPath = '/v1/analytics/funnel/2026-08-01/2026-08-30'
const auditExportPath = '/v1/moderation/audit/0'
const validWalletSignatureAddress = '0x5a78743a6917825631ee3a6df74532d57e57daa0'
const validWalletSignature =
  '0x26831b9a8d8f287957b0618bdc45c90e848ac3cbaf2157e7ed48a050c5d8b82a458f33a4c9b401e8d25aea2b43e4f739602f57773e7d981a2a47f134b22c9fd31c'
const validWalletSignatureTimestamp = '1790856000000'
const moderationAuditWalletAddress = '0xd00fc03ed527ca31039cd837c978da40fb2cef19'
const moderationAuditWalletSignature =
  '0x9d4aec9c4ff42b2d9ff735f0319f355fd61a6ae7a5a28f2f0f6a7321026939d53ad3cfa60860427f1ddd850fca57463f81aff0b3f5deac6c27fa26aa1fca788a1b'
const config = parseConfig({
  DATABASE_URL: 'postgresql://ghostlight:password@db.internal:5432/ghostlight',
  ALLOWED_SCENE_IDS: sceneId,
  TRUSTED_CATALYST_URL: 'https://peer.decentraland.org',
  ACTOR_DIGEST_KEY: 'x'.repeat(32)
})

type FunnelCall = Readonly<{
  sceneId: string
  event: FunnelAnalyticsEvent
  rate: AnalyticsRateIdentity
}>

type ExportCall = Readonly<{
  actorAddress: string
  range: AnalyticsExportRange
  bucketHash: Buffer
}>

type ModerationAuditExportCall = Readonly<{
  actorAddress: string
  afterSequence: string
  bucketHash: Buffer
}>

type PublishCall = Readonly<{
  sceneId: string
  subject: Parameters<ModerationHttpRepository['publish']>[1]
  identity: ModerationPublishIdentity
}>

type ReportCall = Readonly<{
  sceneId: string
  report: Parameters<ModerationHttpRepository['report']>[1]
  identity: ModerationReportIdentity
}>

type DecisionCall = Readonly<{
  decision: Parameters<ModerationHttpRepository['decide']>[0]
  identity: ModerationDecisionIdentity
}>

const exportRows: readonly AnalyticsExportRow[] = Object.freeze([
  Object.freeze({
    day: '2026-08-01',
    sceneId,
    wakeCount: '9007199254740993',
    readyCount: '2',
    decodeCount: '3',
    revealCount: '4',
    authorCount: '5',
    postCount: '6',
    inviteCount: '7',
    mailCount: '8'
  })
])

const moderationSubject: ModerationSubjectRow = Object.freeze({
  id: 'subject-1',
  sceneId,
  authorAddress: address,
  content: 'A lighthouse forgets the sea.',
  channel: 'untrusted',
  status: 'published',
  touringConsent: true,
  createdAt: NOW,
  deletedAt: null
})

const noAccessExportRepository: FunnelExportRepository = {
  async exportFunnel() {
    return { status: 'unauthorized' }
  }
}

const noAccessModerationAuditExportRepository: ModerationAuditExportHttpRepository = {
  async exportAudit() {
    return { status: 'unauthorized' }
  }
}

const noAccessModerationRepository: ModerationHttpRepository = {
  async publish() {
    return { status: 'invalid-content' }
  },
  async report() {
    return { status: 'scene-not-allowed' }
  },
  async queue() {
    return { status: 'unauthorized' }
  },
  async decide() {
    return { status: 'unauthorized' }
  }
}

function eventBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    eventId: `evt_${'a'.repeat(32)}`,
    event: 'wake',
    occurredAt: NOW,
    ...overrides
  })
}

function publishBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'subject-1',
    content: 'A lighthouse forgets the sea.',
    touringConsent: true,
    createdAt: NOW,
    ...overrides
  })
}

function reportBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'report-1',
    contentId: 'subject-1',
    reason: 'abuse',
    createdAt: NOW,
    ...overrides
  })
}

function decisionBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'decision-1',
    subjectId: 'subject-1',
    action: 'quarantined',
    reason: 'Reviewed by a moderator',
    createdAt: NOW,
    ...overrides
  })
}

function hash(raw: string | Buffer) {
  return createHash('sha256').update(raw).digest('hex')
}

function sceneMetadata(raw: string | Buffer, isGuest = false): SceneMetadata {
  return {
    sceneId,
    parcel: '52,68',
    tld: 'org',
    network: 'mainnet',
    isGuest,
    signer: 'decentraland-kernel-scene',
    realm: {
      hostname: 'peer.decentraland.org',
      protocol: 'v3',
      serverName: 'hela'
    },
    hashPayload: hash(raw)
  }
}

function handlerServer(
  raw: string | Buffer,
  outcome: FunnelIngestResult | Error = 'recorded',
  isGuest = false,
  actor = address,
  captureErrors = true
) {
  const calls: FunnelCall[] = []
  const errors: unknown[] = []
  const repository: FunnelRepository = {
    async recordFunnel(recordSceneId, event, rate) {
      calls.push({ sceneId: recordSceneId, event, rate })
      if (outcome instanceof Error) throw outcome
      return outcome
    }
  }
  const server = createTestServerComponent<SceneAuthContext>()
  const router = new Router<SceneAuthContext>()
  server.setContext({})
  server.use(async (context, next) => {
    context.verification = {
      auth: actor,
      authMetadata: sceneMetadata(raw, isGuest)
    }
    return next()
  })
  router.post(
    '/v1/analytics/funnel',
    captureErrors
      ? createFunnelHandler({ config, repository, onUnexpectedError: (error) => errors.push(error) })
      : createFunnelHandler({ config, repository })
  )
  server.use(router.middleware())
  return { server, calls, errors }
}

function post(
  server: ReturnType<typeof createTestServerComponent<SceneAuthContext>>,
  raw: string | Buffer,
  headers: Record<string, string> = { 'content-type': 'application/json' },
  suffix = ''
) {
  return server.fetch(`/v1/analytics/funnel${suffix}`, {
    method: 'POST',
    headers,
    body: raw
  })
}

function exportHandlerServer(
  outcome: AnalyticsExportResult | Error = { status: 'data', rows: exportRows },
  actor = address,
  captureErrors = true
) {
  const calls: ExportCall[] = []
  const errors: unknown[] = []
  const exportRepository: FunnelExportRepository = {
    async exportFunnel(actorAddress, range, bucketHash) {
      calls.push({ actorAddress, range, bucketHash })
      if (outcome instanceof Error) throw outcome
      return outcome
    }
  }
  const server = createTestServerComponent<ApiAuthContext>()
  const router = new Router<ApiAuthContext>()
  server.setContext({})
  server.use(async (context, next) => {
    context.verification = { auth: actor, authMetadata: {} }
    return next()
  })
  router.get(
    '/v1/analytics/funnel/:fromDay/:toDay',
    captureErrors
      ? createFunnelExportHandler({
          config,
          exportRepository,
          onUnexpectedError: (error) => errors.push(error)
        })
      : createFunnelExportHandler({ config, exportRepository })
  )
  server.use(router.middleware())
  return { server, calls, errors }
}

function moderationAuditExportHandlerServer(
  outcome: ModerationAuditExportResult | Error = {
    status: 'data',
    afterSequence: '0',
    nextCursor: null,
    items: [
      {
        sequence: '1',
        action: 'reported',
        moderatorAddress: null,
        subjectId: 'subject-1',
        createdAt: NOW,
        details: {
          clientCreatedAt: NOW - 1,
          reason: 'abuse',
          reportId: 'report-1',
          reportingSceneId: sceneId
        }
      }
    ]
  },
  actor = address,
  authMetadata: Record<string, unknown> = {},
  captureErrors = true
) {
  const calls: ModerationAuditExportCall[] = []
  const errors: unknown[] = []
  const moderationAuditExportRepository: ModerationAuditExportHttpRepository = {
    async exportAudit(actorAddress, afterSequence, bucketHash) {
      calls.push({ actorAddress, afterSequence, bucketHash })
      if (outcome instanceof Error) throw outcome
      return outcome
    }
  }
  const server = createTestServerComponent<ApiAuthContext>()
  const router = new Router<ApiAuthContext>()
  server.setContext({})
  server.use(async (context, next) => {
    context.verification = { auth: actor, authMetadata }
    return next()
  })
  router.get(
    '/v1/moderation/audit/:afterSequence',
    captureErrors
      ? createModerationAuditExportHandler({
          config,
          moderationAuditExportRepository,
          onUnexpectedError: (error) => errors.push(error)
        })
      : createModerationAuditExportHandler({ config, moderationAuditExportRepository })
  )
  server.use(router.middleware())
  return { server, calls, errors }
}

type ModerationOutcomes = Readonly<{
  publish?: ModerationPublishResult | Error | undefined
  report?: ModerationReportResult | Error | undefined
  queue?: ModerationQueueResult | Error | undefined
  decide?: ModerationDecisionResult | Error | undefined
}>

function moderationMock(outcomes: ModerationOutcomes = {}) {
  const publishCalls: PublishCall[] = []
  const reportCalls: ReportCall[] = []
  const queueCalls: string[] = []
  const decisionCalls: DecisionCall[] = []
  const repository: ModerationHttpRepository = {
    async publish(callSceneId, subject, identity) {
      publishCalls.push({ sceneId: callSceneId, subject, identity })
      const outcome = outcomes.publish ?? { status: 'published', subject: moderationSubject }
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    async report(callSceneId, report, identity) {
      reportCalls.push({ sceneId: callSceneId, report, identity })
      const outcome = outcomes.report ?? { status: 'reported' }
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    async queue(moderatorAddress) {
      queueCalls.push(moderatorAddress)
      const outcome = outcomes.queue ?? { status: 'data', rows: [] }
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    async decide(decision, identity) {
      decisionCalls.push({ decision, identity })
      const outcome = outcomes.decide ?? {
        status: 'applied',
        action: 'quarantined',
        subjectStatus: 'quarantined',
        resolvedReports: 1
      }
      if (outcome instanceof Error) throw outcome
      return outcome
    }
  }
  return { repository, publishCalls, reportCalls, queueCalls, decisionCalls }
}

function publishHandlerServer(signedRaw: string | Buffer, outcome?: ModerationPublishResult | Error, actor = address) {
  const mock = moderationMock({ publish: outcome })
  const errors: unknown[] = []
  const server = createTestServerComponent<ApiAuthContext>()
  const router = new Router<ApiAuthContext>()
  server.setContext({})
  server.use(async (context, next) => {
    context.verification = {
      auth: actor,
      authMetadata: { sceneId, hashPayload: hash(signedRaw) }
    }
    return next()
  })
  router.post(
    '/v1/moderation/subjects',
    createModerationPublishHandler({
      config,
      moderationRepository: mock.repository,
      onUnexpectedError: (error) => errors.push(error)
    })
  )
  server.use(router.middleware())
  return { server, errors, ...mock }
}

function reportHandlerServer(
  signedRaw: string | Buffer,
  outcome?: ModerationReportResult | Error,
  isGuest = false,
  actor = address
) {
  const mock = moderationMock({ report: outcome })
  const errors: unknown[] = []
  const server = createTestServerComponent<ApiAuthContext>()
  const router = new Router<ApiAuthContext>()
  server.setContext({})
  server.use(async (context, next) => {
    context.verification = {
      auth: actor,
      authMetadata: sceneMetadata(signedRaw, isGuest)
    }
    return next()
  })
  router.post(
    '/v1/moderation/reports',
    createModerationReportHandler({
      config,
      moderationRepository: mock.repository,
      onUnexpectedError: (error) => errors.push(error)
    })
  )
  server.use(router.middleware())
  return { server, errors, ...mock }
}

function decisionHandlerServer(
  signedRaw: string | Buffer,
  outcome?: ModerationDecisionResult | Error,
  actor = address
) {
  const mock = moderationMock({ decide: outcome })
  const errors: unknown[] = []
  const server = createTestServerComponent<ApiAuthContext>()
  const router = new Router<ApiAuthContext>()
  server.setContext({})
  server.use(async (context, next) => {
    context.verification = { auth: actor, authMetadata: { hashPayload: hash(signedRaw) } }
    return next()
  })
  router.post(
    '/v1/moderation/decisions',
    createModerationDecisionHandler({
      config,
      moderationRepository: mock.repository,
      onUnexpectedError: (error) => errors.push(error)
    })
  )
  server.use(router.middleware())
  return { server, errors, ...mock }
}

function queueHandlerServer(outcome?: ModerationQueueResult | Error, actor = address) {
  const mock = moderationMock({ queue: outcome })
  const errors: unknown[] = []
  const server = createTestServerComponent<ApiAuthContext>()
  const router = new Router<ApiAuthContext>()
  server.setContext({})
  server.use(async (context, next) => {
    context.verification = { auth: actor, authMetadata: {} }
    return next()
  })
  router.get(
    '/v1/moderation/queue',
    createModerationQueueHandler({
      config,
      moderationRepository: mock.repository,
      onUnexpectedError: (error) => errors.push(error)
    })
  )
  server.use(router.middleware())
  return { server, errors, ...mock }
}

function moderationPost(
  server: ReturnType<typeof createTestServerComponent<ApiAuthContext>>,
  path: string,
  raw: string | Buffer,
  headers: Record<string, string> = { 'content-type': 'application/json' }
) {
  return server.fetch(path, { method: 'POST', headers, body: raw })
}

describe('funnel HTTP ingestion', () => {
  it('hashes and parses the exact raw body, then derives wallet rate identity from verification', async () => {
    const raw = eventBody()
    const { server, calls } = handlerServer(raw)

    const response = await post(server, raw, { 'content-type': 'application/json; charset=utf-8' })

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      sceneId,
      event: {
        eventId: `evt_${'a'.repeat(32)}`,
        event: 'wake',
        occurredAt: NOW,
        kind: 'funnel'
      },
      rate: {
        scope: 'analytics-wallet',
        bucketHash: config.digestActor('analytics-wallet-rate', address)
      }
    })
  })

  it('derives guest rate identity only from signed metadata', async () => {
    const raw = eventBody({ event: 'ready' })
    const { server, calls } = handlerServer(raw, 'recorded', true)

    expect((await post(server, raw)).status).toBe(202)
    expect(calls[0]?.rate).toEqual({
      scope: 'analytics-guest',
      bucketHash: config.digestActor('analytics-guest-rate', address)
    })
  })

  it('normalizes a verified owner address before deriving its rate identity', async () => {
    const raw = eventBody()
    const { server, calls } = handlerServer(raw, 'recorded', false, address.toUpperCase())

    expect((await post(server, raw)).status).toBe(202)
    expect(calls[0]?.rate.bucketHash).toEqual(config.digestActor('analytics-wallet-rate', address))

    const malformed = handlerServer(raw, 'recorded', false, 'not-an-address')
    const response = await post(malformed.server, raw)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(malformed.calls).toEqual([])
  })

  it('returns the stable idempotency and repository outcome responses', async () => {
    const cases: ReadonlyArray<readonly [FunnelIngestResult, number, Record<string, unknown>]> = [
      ['duplicate', 202, { ok: true }],
      ['event-id-conflict', 409, { error: 'event-id-conflict' }],
      ['future', 400, { error: 'invalid-request' }],
      ['expired', 400, { error: 'invalid-request' }],
      ['scene-not-allowed', 400, { error: 'invalid-request' }]
    ]

    for (const [outcome, status, body] of cases) {
      const raw = eventBody()
      const { server } = handlerServer(raw, outcome)
      const response = await post(server, raw)
      expect(response.status, outcome).toBe(status)
      expect(await response.json(), outcome).toEqual(body)
    }
  })

  it('returns a bounded rate-limit response with Retry-After', async () => {
    const raw = eventBody()
    const { server } = handlerServer(raw, 'rate-limited')

    const response = await post(server, raw)

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(await response.json()).toEqual({ error: 'rate-limited' })
  })

  it('sanitizes and reports repository failures as unavailable', async () => {
    const raw = eventBody()
    const failure = new Error('postgresql://user:secret@db.internal exploded')
    const { server, errors } = handlerServer(raw, failure)

    const response = await post(server, raw)

    expect(response.status).toBe(503)
    const responseText = await response.text()
    expect(JSON.parse(responseText)).toEqual({ error: 'service-unavailable' })
    expect(errors).toEqual([failure])
    expect(responseText).not.toContain('secret')
  })

  it('uses only a fixed generic default report for unexpected failures', async () => {
    const raw = eventBody()
    const failure = new Error('postgresql://user:secret@db.internal exploded')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const { server } = handlerServer(raw, failure, false, address, false)
      expect((await post(server, raw)).status).toBe(503)
      expect(errorSpy).toHaveBeenCalledWith('Unexpected API HTTP error')
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('rejects a query, noncanonical path, encoded body, unsupported media type, or non-UTF-8 body', async () => {
    const raw = eventBody()

    const withQuery = handlerServer(raw)
    expect((await post(withQuery.server, raw, undefined, '?campaign=forbidden')).status).toBe(400)
    expect(withQuery.calls).toEqual([])

    const wrongType = handlerServer(raw)
    expect((await post(wrongType.server, raw, { 'content-type': 'text/plain' })).status).toBe(415)
    expect(wrongType.calls).toEqual([])

    const encoded = handlerServer(raw)
    expect(
      (
        await post(encoded.server, raw, {
          'content-type': 'application/json',
          'content-encoding': 'gzip'
        })
      ).status
    ).toBe(415)
    expect(encoded.calls).toEqual([])

    const identity = handlerServer(raw)
    expect(
      (
        await post(identity.server, raw, {
          'content-type': 'application/json',
          'content-encoding': 'identity'
        })
      ).status
    ).toBe(202)

    const wrongPath = handlerServer(raw)
    const wrongPathResponse = await wrongPath.server.fetch('/V1/ANALYTICS/FUNNEL', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw
    })
    expect(wrongPathResponse.status).toBe(400)
    expect(wrongPath.calls).toEqual([])

    const invalidUtf8 = Buffer.from([0xff])
    const invalidEncoding = handlerServer(invalidUtf8)
    expect((await post(invalidEncoding.server, invalidUtf8)).status).toBe(400)
    expect(invalidEncoding.calls).toEqual([])
  })

  it('enforces the 1,024-byte raw-body ceiling before JSON parsing', async () => {
    const body = eventBody()
    const exact = `${' '.repeat(MAX_FUNNEL_BODY_BYTES - Buffer.byteLength(body))}${body}`
    const accepted = handlerServer(exact)
    expect(Buffer.byteLength(exact)).toBe(MAX_FUNNEL_BODY_BYTES)
    expect((await post(accepted.server, exact)).status).toBe(202)

    const oversized = ` ${exact}`
    const rejected = handlerServer(oversized)
    const response = await post(rejected.server, oversized)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'payload-too-large' })
    expect(rejected.calls).toEqual([])
  })

  it('verifies the signed payload hash before parsing the exact funnel-only JSON contract', async () => {
    const valid = eventBody()
    const mismatched = handlerServer(valid)
    expect((await post(mismatched.server, `${valid} `)).status).toBe(400)
    expect(mismatched.calls).toEqual([])

    for (const raw of [
      '{',
      eventBody({ event: 'click', campaign: 'season-zero', source: 'social' }),
      eventBody({ extra: true })
    ]) {
      const invalid = handlerServer(raw)
      expect((await post(invalid.server, raw)).status).toBe(400)
      expect(invalid.calls).toEqual([])
    }
  })
})

describe('moderation publishing HTTP', () => {
  it('publishes only the parsed untrusted subject with normalized wallet identities', async () => {
    const raw = publishBody()
    const { server, publishCalls } = publishHandlerServer(raw, undefined, address.toUpperCase())

    const response = await moderationPost(server, '/v1/moderation/subjects', raw)

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true })
    expect(publishCalls).toEqual([
      {
        sceneId,
        subject: {
          id: 'subject-1',
          content: 'A lighthouse forgets the sea.',
          channel: 'untrusted',
          touringConsent: true,
          createdAt: NOW
        },
        identity: {
          actorAddress: address,
          bucketHash: config.digestActor('publish-rate', address),
          auditDigest: config.digestActor('moderation-audit', address)
        }
      }
    ])
  })

  it('maps every publish result to the fixed public contract', async () => {
    const cases: ReadonlyArray<readonly [ModerationPublishResult, number, Record<string, unknown>, string | null]> = [
      [{ status: 'published', subject: moderationSubject }, 202, { ok: true }, null],
      [{ status: 'replay', subject: moderationSubject }, 202, { ok: true }, null],
      [{ status: 'id-conflict' }, 409, { error: 'subject-id-conflict' }, null],
      [{ status: 'duplicate-content', duplicateOf: 'subject-2' }, 409, { error: 'duplicate-content' }, null],
      [{ status: 'invalid-content' }, 400, { error: 'invalid-request' }, null],
      [{ status: 'timestamp-out-of-range' }, 400, { error: 'invalid-request' }, null],
      [{ status: 'scene-not-allowed' }, 400, { error: 'invalid-request' }, null],
      [{ status: 'rate-limited' }, 429, { error: 'rate-limited' }, '3600']
    ]

    for (const [outcome, status, body, retryAfter] of cases) {
      const raw = publishBody()
      const fixture = publishHandlerServer(raw, outcome)
      const response = await moderationPost(fixture.server, '/v1/moderation/subjects', raw)
      expect(response.status, outcome.status).toBe(status)
      expect(response.headers.get('cache-control'), outcome.status).toBe('no-store')
      expect(response.headers.get('retry-after'), outcome.status).toBe(retryAfter)
      expect(await response.json(), outcome.status).toEqual(body)
    }
  })
})

describe('moderation reporting HTTP', () => {
  it('uses actor-only rate identity but report-local unlinkable digests', async () => {
    const raw = reportBody()
    const { server, reportCalls } = reportHandlerServer(raw, undefined, false, address.toUpperCase())

    const response = await moderationPost(server, '/v1/moderation/reports', raw)

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true })
    const reportIdentity = `${address}\0subject-1\0abuse`
    expect(reportCalls).toEqual([
      {
        sceneId,
        report: {
          id: 'report-1',
          contentId: 'subject-1',
          reason: 'abuse',
          createdAt: NOW,
          status: 'open'
        },
        identity: {
          scope: 'report-wallet',
          bucketHash: config.digestActor('report-wallet-rate', address),
          reporterDigest: config.digestActor('moderation-report', reportIdentity),
          auditDigest: config.digestActor('moderation-audit', reportIdentity)
        }
      }
    ])
    expect(reportCalls[0]?.identity).not.toHaveProperty('actorAddress')

    const otherRaw = reportBody({ id: 'report-2', contentId: 'subject-2' })
    const other = reportHandlerServer(otherRaw)
    expect((await moderationPost(other.server, '/v1/moderation/reports', otherRaw)).status).toBe(202)
    expect(other.reportCalls[0]?.identity.reporterDigest).not.toEqual(reportCalls[0]?.identity.reporterDigest)
    expect(other.reportCalls[0]?.identity.auditDigest).not.toEqual(reportCalls[0]?.identity.auditDigest)
  })

  it('derives the independent guest rate scope from signed scene metadata', async () => {
    const raw = reportBody()
    const { server, reportCalls } = reportHandlerServer(raw, undefined, true)

    expect((await moderationPost(server, '/v1/moderation/reports', raw)).status).toBe(202)
    expect(reportCalls[0]?.identity).toMatchObject({
      scope: 'report-guest',
      bucketHash: config.digestActor('report-guest-rate', address)
    })
  })

  it('maps every report result to the fixed public contract', async () => {
    const cases: ReadonlyArray<readonly [ModerationReportResult, number, Record<string, unknown>, string | null]> = [
      [{ status: 'reported' }, 202, { ok: true }, null],
      [{ status: 'replay' }, 202, { ok: true }, null],
      [{ status: 'duplicate-report', reportId: 'report-2' }, 202, { ok: true }, null],
      [{ status: 'report-id-conflict' }, 409, { error: 'report-id-conflict' }, null],
      [{ status: 'subject-not-found' }, 404, { error: 'not-found' }, null],
      [{ status: 'subject-unavailable' }, 404, { error: 'not-found' }, null],
      [{ status: 'timestamp-out-of-range' }, 400, { error: 'invalid-request' }, null],
      [{ status: 'scene-not-allowed' }, 400, { error: 'invalid-request' }, null],
      [{ status: 'rate-limited' }, 429, { error: 'rate-limited' }, '3600']
    ]

    for (const [outcome, status, body, retryAfter] of cases) {
      const raw = reportBody()
      const fixture = reportHandlerServer(raw, outcome)
      const response = await moderationPost(fixture.server, '/v1/moderation/reports', raw)
      expect(response.status, outcome.status).toBe(status)
      expect(response.headers.get('cache-control'), outcome.status).toBe('no-store')
      expect(response.headers.get('retry-after'), outcome.status).toBe(retryAfter)
      expect(await response.json(), outcome.status).toEqual(body)
    }
  })
})

describe('moderation queue and decisions HTTP', () => {
  it('returns the fixed repository queue without accepting a limit or exposing digests', async () => {
    const row = Object.freeze({
      reportId: 'report-1',
      subjectId: 'subject-1',
      sceneId,
      authorAddress: address,
      content: moderationSubject.content,
      channel: 'untrusted' as const,
      touringConsent: true,
      subjectStatus: 'published' as const,
      reason: 'abuse' as const,
      reportedAt: NOW
    })
    const { server, queueCalls } = queueHandlerServer({ status: 'data', rows: [row] }, address.toUpperCase())

    const response = await server.fetch('/v1/moderation/queue')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const responseText = await response.text()
    expect(JSON.parse(responseText)).toEqual({ items: [row] })
    expect(responseText).not.toContain('digest')
    expect(queueCalls).toEqual([address])

    const withLimit = await server.fetch('/v1/moderation/queue?limit=1')
    expect(withLimit.status).toBe(400)
    expect(withLimit.headers.get('cache-control')).toBe('no-store')
    expect(queueCalls).toEqual([address])
  })

  it('maps queue role denial and failures without leaking details', async () => {
    const forbidden = queueHandlerServer({ status: 'unauthorized' })
    const forbiddenResponse = await forbidden.server.fetch('/v1/moderation/queue')
    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.headers.get('cache-control')).toBe('no-store')
    expect(await forbiddenResponse.json()).toEqual({ error: 'forbidden' })

    const failure = new Error('postgresql://moderator:secret@db.internal leaked')
    const unavailable = queueHandlerServer(failure)
    const unavailableResponse = await unavailable.server.fetch('/v1/moderation/queue')
    expect(unavailableResponse.status).toBe(503)
    expect(unavailableResponse.headers.get('cache-control')).toBe('no-store')
    const responseText = await unavailableResponse.text()
    expect(JSON.parse(responseText)).toEqual({ error: 'service-unavailable' })
    expect(responseText).not.toContain('secret')
    expect(unavailable.errors).toEqual([failure])
  })

  it('parses decisions and derives only moderator rate and audit identities', async () => {
    const raw = decisionBody()
    const { server, decisionCalls } = decisionHandlerServer(raw, undefined, address.toUpperCase())

    const response = await moderationPost(server, '/v1/moderation/decisions', raw)

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true })
    expect(decisionCalls).toEqual([
      {
        decision: {
          id: 'decision-1',
          subjectId: 'subject-1',
          action: 'quarantined',
          reason: 'Reviewed by a moderator',
          createdAt: NOW
        },
        identity: {
          actorAddress: address,
          bucketHash: config.digestActor('decision-rate', address),
          auditDigest: config.digestActor('moderation-audit', address)
        }
      }
    ])
  })

  it('maps every decision result to the fixed public contract', async () => {
    const cases: ReadonlyArray<readonly [ModerationDecisionResult, number, Record<string, unknown>, string | null]> = [
      [
        { status: 'applied', action: 'quarantined', subjectStatus: 'quarantined', resolvedReports: 1 },
        202,
        { ok: true },
        null
      ],
      [{ status: 'replay' }, 202, { ok: true }, null],
      [{ status: 'decision-id-conflict' }, 409, { error: 'decision-id-conflict' }, null],
      [{ status: 'unauthorized' }, 403, { error: 'forbidden' }, null],
      [{ status: 'subject-not-found' }, 404, { error: 'not-found' }, null],
      [{ status: 'subject-unavailable' }, 409, { error: 'subject-unavailable' }, null],
      [{ status: 'timestamp-out-of-range' }, 400, { error: 'invalid-request' }, null],
      [{ status: 'rate-limited' }, 429, { error: 'rate-limited' }, '60']
    ]

    for (const [outcome, status, body, retryAfter] of cases) {
      const raw = decisionBody()
      const fixture = decisionHandlerServer(raw, outcome)
      const response = await moderationPost(fixture.server, '/v1/moderation/decisions', raw)
      expect(response.status, outcome.status).toBe(status)
      expect(response.headers.get('cache-control'), outcome.status).toBe('no-store')
      expect(response.headers.get('retry-after'), outcome.status).toBe(retryAfter)
      expect(await response.json(), outcome.status).toEqual(body)
    }
  })
})

describe('moderation signed-body boundaries', () => {
  it('accepts exactly 8,192 raw bytes and rejects 8,193 before parsing', async () => {
    const body = publishBody()
    const exact = `${' '.repeat(MAX_MODERATION_BODY_BYTES - Buffer.byteLength(body))}${body}`
    expect(Buffer.byteLength(exact)).toBe(MAX_MODERATION_BODY_BYTES)
    const accepted = publishHandlerServer(exact)
    expect((await moderationPost(accepted.server, '/v1/moderation/subjects', exact)).status).toBe(202)
    expect(accepted.publishCalls).toHaveLength(1)

    const oversized = ` ${exact}`
    const rejected = publishHandlerServer(oversized)
    const response = await moderationPost(rejected.server, '/v1/moderation/subjects', oversized)
    expect(Buffer.byteLength(oversized)).toBe(MAX_MODERATION_BODY_BYTES + 1)
    expect(response.status).toBe(413)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'payload-too-large' })
    expect(rejected.publishCalls).toEqual([])
  })

  it('binds the exact raw body before fatal UTF-8, JSON, and contract parsing', async () => {
    const valid = publishBody()
    const mismatch = publishHandlerServer(valid)
    expect((await moderationPost(mismatch.server, '/v1/moderation/subjects', `${valid} `)).status).toBe(400)
    expect(mismatch.publishCalls).toEqual([])

    for (const raw of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from(publishBody({ extra: true }))]) {
      const invalid = publishHandlerServer(raw)
      const response = await moderationPost(invalid.server, '/v1/moderation/subjects', raw)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(invalid.publishCalls).toEqual([])
    }

    const report = reportBody()
    const mismatchedReport = reportHandlerServer(report)
    expect((await moderationPost(mismatchedReport.server, '/v1/moderation/reports', `${report} `)).status).toBe(400)
    expect(mismatchedReport.reportCalls).toEqual([])

    const decision = decisionBody()
    const mismatchedDecision = decisionHandlerServer(decision)
    expect((await moderationPost(mismatchedDecision.server, '/v1/moderation/decisions', `${decision} `)).status).toBe(
      400
    )
    expect(mismatchedDecision.decisionCalls).toEqual([])
  })

  it('rejects noncanonical paths, queries, encodings, and media types', async () => {
    const raw = publishBody()
    const cases: ReadonlyArray<readonly [string, Record<string, string>, number]> = [
      ['/v1/moderation/subjects?mode=trusted', { 'content-type': 'application/json' }, 400],
      ['/V1/MODERATION/SUBJECTS', { 'content-type': 'application/json' }, 400],
      ['/v1/moderation/subjects/', { 'content-type': 'application/json' }, 400],
      ['/v1/moderation/subjects', { 'content-type': 'text/plain' }, 415],
      ['/v1/moderation/subjects', { 'content-type': 'application/json', 'content-encoding': 'gzip' }, 415]
    ]

    for (const [path, headers, status] of cases) {
      const fixture = publishHandlerServer(raw)
      const response = await moderationPost(fixture.server, path, raw, headers)
      expect(response.status, path).toBe(status)
      expect(response.headers.get('cache-control'), path).toBe('no-store')
      expect(fixture.publishCalls, path).toEqual([])
    }
  })

  it('sanitizes repository exceptions for every moderation mutation', async () => {
    const failure = new Error('postgresql://user:secret@db.internal exploded')
    const fixtures = [
      {
        raw: publishBody(),
        path: '/v1/moderation/subjects',
        fixture: (raw: string) => publishHandlerServer(raw, failure)
      },
      {
        raw: reportBody(),
        path: '/v1/moderation/reports',
        fixture: (raw: string) => reportHandlerServer(raw, failure)
      },
      {
        raw: decisionBody(),
        path: '/v1/moderation/decisions',
        fixture: (raw: string) => decisionHandlerServer(raw, failure)
      }
    ]

    for (const entry of fixtures) {
      const fixture = entry.fixture(entry.raw)
      const response = await moderationPost(fixture.server, entry.path, entry.raw)
      expect(response.status, entry.path).toBe(503)
      expect(response.headers.get('cache-control'), entry.path).toBe('no-store')
      const responseText = await response.text()
      expect(JSON.parse(responseText), entry.path).toEqual({ error: 'service-unavailable' })
      expect(responseText, entry.path).not.toContain('secret')
      expect(fixture.errors, entry.path).toEqual([failure])
    }
  })
})

describe('aggregate funnel export HTTP', () => {
  it('returns canonical aggregate rows and derives only the normalized wallet export identity', async () => {
    const { server, calls } = exportHandlerServer({ status: 'data', rows: exportRows }, address.toUpperCase())

    const response = await server.fetch(exportPath)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const responseText = await response.text()
    expect(JSON.parse(responseText)).toEqual({
      fromDay: '2026-08-01',
      toDay: '2026-08-30',
      rows: exportRows
    })
    expect(responseText).not.toContain(address)
    expect(responseText).not.toContain('receipt')
    expect(calls).toEqual([
      {
        actorAddress: address,
        range: { fromDay: '2026-08-01', toDay: '2026-08-30', dayCount: 30 },
        bucketHash: config.digestActor('export-rate', address)
      }
    ])
  })

  it('rejects invalid ranges, noncanonical raw paths, and query strings before export', async () => {
    for (const path of [
      '/v1/analytics/funnel/2026-02-30/2026-03-01',
      '/v1/analytics/funnel/2026-08-30/2026-08-01',
      '/v1/analytics/funnel/2026-08-01/2026-09-01',
      '/V1/ANALYTICS/FUNNEL/2026-08-01/2026-08-30',
      '/v1/analytics/funnel/2026-08-01/2026-08-30/',
      '/v1/analytics/funnel/2026-08-01/2026-08-%33%30',
      '/v1/analytics/funnel/2026-08-01/2026-08-30?format=raw'
    ]) {
      const { server, calls } = exportHandlerServer()
      const response = await server.fetch(path)
      expect(response.status, path).toBe(400)
      expect(response.headers.get('cache-control'), path).toBe('no-store')
      expect(await response.json(), path).toEqual({ error: 'invalid-request' })
      expect(calls, path).toEqual([])
    }
  })

  it('rejects a malformed verified wallet address before export', async () => {
    const { server, calls } = exportHandlerServer({ status: 'data', rows: exportRows }, 'wallet')

    const response = await server.fetch(exportPath)

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(calls).toEqual([])
  })

  it('maps role denial and hourly rate limiting to stable responses', async () => {
    const forbidden = exportHandlerServer({ status: 'unauthorized' })
    const forbiddenResponse = await forbidden.server.fetch(exportPath)
    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.headers.get('cache-control')).toBe('no-store')
    expect(await forbiddenResponse.json()).toEqual({ error: 'forbidden' })

    const limited = exportHandlerServer({ status: 'rate-limited' })
    const limitedResponse = await limited.server.fetch(exportPath)
    expect(limitedResponse.status).toBe(429)
    expect(limitedResponse.headers.get('cache-control')).toBe('no-store')
    expect(limitedResponse.headers.get('retry-after')).toBe('3600')
    expect(await limitedResponse.json()).toEqual({ error: 'rate-limited' })
  })

  it('sanitizes and reports export repository failures as unavailable', async () => {
    const failure = new Error('postgresql://analyst:secret@db.internal leaked')
    const { server, errors } = exportHandlerServer(failure)

    const response = await server.fetch(exportPath)

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const responseText = await response.text()
    expect(JSON.parse(responseText)).toEqual({ error: 'service-unavailable' })
    expect(responseText).not.toContain('secret')
    expect(errors).toEqual([failure])
  })
})

describe('moderation audit export HTTP', () => {
  it('returns the sanitized page and derives only the dedicated normalized moderator identity', async () => {
    const fixture = moderationAuditExportHandlerServer(undefined, address.toUpperCase())

    const response = await fixture.server.fetch(auditExportPath)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const responseText = await response.text()
    expect(JSON.parse(responseText)).toEqual({
      afterSequence: '0',
      nextCursor: null,
      items: [
        {
          sequence: '1',
          action: 'reported',
          moderatorAddress: null,
          subjectId: 'subject-1',
          createdAt: NOW,
          details: {
            clientCreatedAt: NOW - 1,
            reason: 'abuse',
            reportId: 'report-1',
            reportingSceneId: sceneId
          }
        }
      ]
    })
    expect(responseText).not.toContain(address)
    expect(responseText).not.toContain('digest')
    expect(responseText).not.toContain('reporter')
    expect(responseText).not.toContain('content')
    expect(fixture.calls).toEqual([
      {
        actorAddress: address,
        afterSequence: '0',
        bucketHash: config.digestActor('moderation-audit-export-rate', address)
      }
    ])
  })

  it('accepts the exact PostgreSQL bigint ceiling and rejects every noncanonical cursor or path before export', async () => {
    const maximum = moderationAuditExportHandlerServer({
      status: 'data',
      afterSequence: '9223372036854775807',
      nextCursor: null,
      items: []
    })
    expect((await maximum.server.fetch('/v1/moderation/audit/9223372036854775807')).status).toBe(200)
    expect(maximum.calls[0]?.afterSequence).toBe('9223372036854775807')

    for (const path of [
      '/v1/moderation/audit/00',
      '/v1/moderation/audit/01',
      '/v1/moderation/audit/-1',
      '/v1/moderation/audit/+1',
      '/v1/moderation/audit/1.0',
      '/v1/moderation/audit/9223372036854775808',
      '/v1/moderation/audit/%30',
      '/v1/moderation/audit/0/',
      '/V1/MODERATION/AUDIT/0',
      '/v1/moderation/audit/0?format=raw'
    ]) {
      const fixture = moderationAuditExportHandlerServer()
      const response = await fixture.server.fetch(path)
      expect(response.status, path).toBe(400)
      expect(response.headers.get('cache-control'), path).toBe('no-store')
      expect(await response.json(), path).toEqual({ error: 'invalid-request' })
      expect(fixture.calls, path).toEqual([])
    }
  })

  it('rejects absent or malformed direct-wallet verification before export', async () => {
    const invalidMetadata = moderationAuditExportHandlerServer(undefined, address, { unexpected: true })
    const invalidMetadataResponse = await invalidMetadata.server.fetch(auditExportPath)
    expect(invalidMetadataResponse.status).toBe(401)
    expect(invalidMetadataResponse.headers.get('cache-control')).toBe('no-store')
    expect(await invalidMetadataResponse.json()).toEqual({ error: 'unauthorized' })
    expect(invalidMetadata.calls).toEqual([])

    const invalidAddress = moderationAuditExportHandlerServer(undefined, 'wallet')
    const invalidAddressResponse = await invalidAddress.server.fetch(auditExportPath)
    expect(invalidAddressResponse.status).toBe(401)
    expect(invalidAddressResponse.headers.get('cache-control')).toBe('no-store')
    expect(await invalidAddressResponse.json()).toEqual({ error: 'unauthorized' })
    expect(invalidAddress.calls).toEqual([])

    const server = createTestServerComponent<ApiAuthContext>()
    const router = new Router<ApiAuthContext>()
    server.setContext({})
    router.get(
      '/v1/moderation/audit/:afterSequence',
      createModerationAuditExportHandler({
        config,
        moderationAuditExportRepository: noAccessModerationAuditExportRepository
      })
    )
    server.use(router.middleware())
    const missing = await server.fetch(auditExportPath)
    expect(missing.status).toBe(401)
    expect(missing.headers.get('cache-control')).toBe('no-store')
    expect(await missing.json()).toEqual({ error: 'unauthorized' })
  })

  it('maps role denial and its separate hourly rate limit to stable responses', async () => {
    const forbidden = moderationAuditExportHandlerServer({ status: 'unauthorized' })
    const forbiddenResponse = await forbidden.server.fetch(auditExportPath)
    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.headers.get('cache-control')).toBe('no-store')
    expect(await forbiddenResponse.json()).toEqual({ error: 'forbidden' })

    const limited = moderationAuditExportHandlerServer({ status: 'rate-limited' })
    const limitedResponse = await limited.server.fetch(auditExportPath)
    expect(limitedResponse.status).toBe(429)
    expect(limitedResponse.headers.get('cache-control')).toBe('no-store')
    expect(limitedResponse.headers.get('retry-after')).toBe('3600')
    expect(await limitedResponse.json()).toEqual({ error: 'rate-limited' })
  })

  it('sanitizes and reports repository failures as unavailable', async () => {
    const failure = new Error('postgresql://moderator:secret@db.internal leaked')
    const fixture = moderationAuditExportHandlerServer(failure)

    const response = await fixture.server.fetch(auditExportPath)

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const responseText = await response.text()
    expect(JSON.parse(responseText)).toEqual({ error: 'service-unavailable' })
    expect(responseText).not.toContain('secret')
    expect(fixture.errors).toEqual([failure])
  })
})

describe('Season Zero calendar HTTP', () => {
  it('serves the exact scheduled calendar publicly without touching repositories or readiness', async () => {
    vi.useFakeTimers()
    const recordFunnel = vi.fn<FunnelRepository['recordFunnel']>()
    const exportFunnel = vi.fn<FunnelExportRepository['exportFunnel']>()
    const publish = vi.fn<ModerationHttpRepository['publish']>()
    const report = vi.fn<ModerationHttpRepository['report']>()
    const queue = vi.fn<ModerationHttpRepository['queue']>()
    const decide = vi.fn<ModerationHttpRepository['decide']>()
    const exportAudit = vi.fn<ModerationAuditExportHttpRepository['exportAudit']>()
    const isReady = vi.fn(async () => false)
    const router = createHttpRouter({
      config,
      repository: { recordFunnel },
      exportRepository: { exportFunnel },
      moderationRepository: { publish, report, queue, decide },
      moderationAuditExportRepository: { exportAudit },
      isReady
    })
    const server = createTestServerComponent<ApiAuthContext>()
    server.setContext({})
    server.use(router.middleware())

    try {
      vi.setSystemTime(NOW)
      const response = await server.fetch('/v1/seasons/season-zero/calendar')

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body: unknown = await response.json()
      expect(body).toEqual(seasonZeroCalendarSnapshot(NOW))
      expect(body).toMatchObject({ kind: 'scheduled-calendar', liveOperationalStateAvailable: false })
      expect(body).not.toHaveProperty('active')
      expect(body).not.toHaveProperty('liveState')
      expect(body).not.toHaveProperty('operationalState')
      expect(recordFunnel).not.toHaveBeenCalled()
      expect(exportFunnel).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      expect(report).not.toHaveBeenCalled()
      expect(queue).not.toHaveBeenCalled()
      expect(decide).not.toHaveBeenCalled()
      expect(exportAudit).not.toHaveBeenCalled()
      expect(isReady).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects query strings and noncanonical calendar paths without repository access', async () => {
    const recordFunnel = vi.fn<FunnelRepository['recordFunnel']>()
    const exportFunnel = vi.fn<FunnelExportRepository['exportFunnel']>()
    const publish = vi.fn<ModerationHttpRepository['publish']>()
    const report = vi.fn<ModerationHttpRepository['report']>()
    const queue = vi.fn<ModerationHttpRepository['queue']>()
    const decide = vi.fn<ModerationHttpRepository['decide']>()
    const exportAudit = vi.fn<ModerationAuditExportHttpRepository['exportAudit']>()
    const isReady = vi.fn(async () => false)
    const router = createHttpRouter({
      config,
      repository: { recordFunnel },
      exportRepository: { exportFunnel },
      moderationRepository: { publish, report, queue, decide },
      moderationAuditExportRepository: { exportAudit },
      isReady
    })
    const server = createTestServerComponent<ApiAuthContext>()
    server.setContext({})
    server.use(router.middleware())

    for (const path of [
      '/v1/seasons/season-zero/calendar?state=live',
      '/v1/seasons/season-zero/calendar/',
      '/V1/SEASONS/SEASON-ZERO/CALENDAR'
    ]) {
      const response = await server.fetch(path)
      expect(response.status, path).toBe(400)
      expect(response.headers.get('cache-control'), path).toBe('no-store')
      expect(await response.json(), path).toEqual({ error: 'invalid-request' })
    }

    expect(recordFunnel).not.toHaveBeenCalled()
    expect(exportFunnel).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
    expect(exportAudit).not.toHaveBeenCalled()
    expect(isReady).not.toHaveBeenCalled()
  })
})

describe('HTTP router boundaries', () => {
  it('keeps liveness public and makes readiness fail closed without exposing probe errors', async () => {
    vi.useFakeTimers()
    const repository: FunnelRepository = {
      async recordFunnel() {
        return 'recorded'
      }
    }
    const errors: unknown[] = []
    let readiness: 'ready' | 'unready' | 'error' = 'unready'
    let readinessProbes = 0
    const router = createHttpRouter({
      config,
      repository,
      exportRepository: noAccessExportRepository,
      moderationRepository: noAccessModerationRepository,
      moderationAuditExportRepository: noAccessModerationAuditExportRepository,
      isReady: async () => {
        readinessProbes += 1
        if (readiness === 'error') throw new Error('database credentials leaked')
        return readiness === 'ready'
      },
      onUnexpectedError: (error) => errors.push(error)
    })
    const server = createTestServerComponent<SceneAuthContext>()
    server.setContext({})
    server.use(router.middleware())

    try {
      vi.setSystemTime(NOW)
      const live = await server.fetch('/health/live')
      expect(live.status).toBe(200)
      expect(await live.json()).toEqual({ status: 'pass' })

      const [unready, coalesced] = await Promise.all([server.fetch('/health/ready'), server.fetch('/health/ready')])
      expect(unready.status).toBe(503)
      expect(coalesced.status).toBe(503)
      expect(await unready.json()).toEqual({ status: 'fail' })
      expect(readinessProbes).toBe(1)

      readiness = 'ready'
      expect((await server.fetch('/health/ready')).status).toBe(503)
      expect(readinessProbes).toBe(1)
      await vi.advanceTimersByTimeAsync(READINESS_CACHE_MILLISECONDS)
      expect((await server.fetch('/health/ready')).status).toBe(200)
      expect(readinessProbes).toBe(2)

      readiness = 'error'
      await vi.advanceTimersByTimeAsync(READINESS_CACHE_MILLISECONDS)
      const failed = await server.fetch('/health/ready')
      expect(failed.status).toBe(503)
      expect(await failed.text()).not.toContain('credentials')
      expect(errors).toHaveLength(1)
      expect(readinessProbes).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('places required scene authentication in front of the production funnel route', async () => {
    let persisted = false
    const router = createHttpRouter({
      config,
      repository: {
        async recordFunnel() {
          persisted = true
          return 'recorded'
        }
      },
      exportRepository: noAccessExportRepository,
      moderationRepository: noAccessModerationRepository,
      moderationAuditExportRepository: noAccessModerationAuditExportRepository,
      isReady: async () => true
    })
    const server = createTestServerComponent<SceneAuthContext>()
    server.setContext({})
    server.use(router.middleware())

    const response = await post(server, eventBody())

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid-request' })
    expect(persisted).toBe(false)
  })

  it('places exact authentication before moderation and marks authentication failures no-store', async () => {
    const mock = moderationMock()
    const router = createHttpRouter({
      config,
      repository: {
        async recordFunnel() {
          return 'recorded'
        }
      },
      exportRepository: noAccessExportRepository,
      moderationRepository: mock.repository,
      moderationAuditExportRepository: noAccessModerationAuditExportRepository,
      isReady: async () => true
    })
    const server = createTestServerComponent<ApiAuthContext>()
    server.setContext({})
    server.use(router.middleware())

    for (const [path, method, body] of [
      ['/v1/moderation/subjects', 'POST', publishBody()],
      ['/v1/moderation/reports', 'POST', reportBody()],
      ['/v1/moderation/queue', 'GET', undefined],
      ['/v1/moderation/decisions', 'POST', decisionBody()]
    ] as const) {
      const response = await server.fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body
      })
      expect(response.status, path).toBe(400)
      expect(response.headers.get('cache-control'), path).toBe('no-store')
      expect(await response.json(), path).toEqual({ error: 'invalid-request' })
    }

    const publishRaw = publishBody()
    const signedMetadata = JSON.stringify({ sceneId, hashPayload: hash(publishRaw) })
    const invalidSignature = await server.fetch('/v1/moderation/subjects', {
      method: 'POST',
      headers: {
        'x-identity-auth-chain-0': JSON.stringify({ type: 'SIGNER', payload: address, signature: '' }),
        'x-identity-auth-chain-1': JSON.stringify({
          type: 'ECDSA_SIGNED_ENTITY',
          payload: 'not-the-signed-payload',
          signature: 'malformed'
        }),
        'x-identity-timestamp': String(Date.now()),
        'x-identity-metadata': signedMetadata,
        'content-type': 'application/json'
      },
      body: publishRaw
    })
    expect(invalidSignature.status).toBe(401)
    expect(invalidSignature.headers.get('cache-control')).toBe('no-store')
    expect(await invalidSignature.json()).toEqual({ error: 'unauthorized' })
    expect(mock.publishCalls).toEqual([])
    expect(mock.reportCalls).toEqual([])
    expect(mock.queueCalls).toEqual([])
    expect(mock.decisionCalls).toEqual([])
  })

  it('places direct-wallet authentication in front of the production export route', async () => {
    const calls: ExportCall[] = []
    const router = createHttpRouter({
      config,
      repository: {
        async recordFunnel() {
          return 'recorded'
        }
      },
      exportRepository: {
        async exportFunnel(actorAddress, range, bucketHash) {
          calls.push({ actorAddress, range, bucketHash })
          return { status: 'data', rows: exportRows }
        }
      },
      moderationRepository: noAccessModerationRepository,
      moderationAuditExportRepository: noAccessModerationAuditExportRepository,
      isReady: async () => true
    })
    const server = createTestServerComponent<ApiAuthContext>()
    server.setContext({})
    server.use(router.middleware())

    const unsigned = await server.fetch(exportPath)
    expect(unsigned.status).toBe(400)
    expect(unsigned.headers.get('cache-control')).toBe('no-store')
    expect(await unsigned.json()).toEqual({ error: 'invalid-request' })
    expect(calls).toEqual([])

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Number(validWalletSignatureTimestamp))
      const sceneMetadataRaw = JSON.stringify(sceneMetadata(''))
      const sceneRequest = await server.fetch(exportPath, {
        headers: {
          'x-identity-auth-chain-0': JSON.stringify({
            type: 'SIGNER',
            payload: address,
            signature: ''
          }),
          'x-identity-auth-chain-1': JSON.stringify({
            type: 'ECDSA_SIGNED_ENTITY',
            payload: 'not-the-signed-payload',
            signature: 'malformed'
          }),
          'x-identity-timestamp': validWalletSignatureTimestamp,
          'x-identity-metadata': sceneMetadataRaw
        }
      })
      expect(sceneRequest.status).toBe(400)
      expect(await sceneRequest.json()).toEqual({ error: 'invalid-request' })
      expect(calls).toEqual([])

      const rawMetadata = JSON.stringify({ fixtureVersion: 'V6' })
      const payload = createPayload('GET', exportPath, validWalletSignatureTimestamp, rawMetadata)
      const walletHeaders = {
        'x-identity-auth-chain-0': JSON.stringify({
          type: 'SIGNER',
          payload: validWalletSignatureAddress,
          signature: ''
        }),
        'x-identity-auth-chain-1': JSON.stringify({
          type: 'ECDSA_SIGNED_ENTITY',
          payload,
          signature: validWalletSignature
        }),
        'x-identity-timestamp': validWalletSignatureTimestamp,
        'x-identity-metadata': rawMetadata
      }
      const noncanonical = await server.fetch('/V1/ANALYTICS/FUNNEL/2026-08-01/2026-08-30', {
        headers: walletHeaders
      })
      expect(noncanonical.status).toBe(400)
      expect(noncanonical.headers.get('cache-control')).toBe('no-store')
      expect(await noncanonical.json()).toEqual({ error: 'invalid-request' })
      expect(calls).toEqual([])

      const authorized = await server.fetch(exportPath, { headers: walletHeaders })

      expect(authorized.status).toBe(200)
      expect(await authorized.json()).toEqual({
        fromDay: '2026-08-01',
        toDay: '2026-08-30',
        rows: exportRows
      })
      expect(calls).toEqual([
        {
          actorAddress: validWalletSignatureAddress,
          range: { fromDay: '2026-08-01', toDay: '2026-08-30', dayCount: 30 },
          bucketHash: config.digestActor('export-rate', validWalletSignatureAddress)
        }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('binds production moderator audit authentication to the exact cursor path and empty metadata', async () => {
    const calls: ModerationAuditExportCall[] = []
    const router = createHttpRouter({
      config,
      repository: {
        async recordFunnel() {
          return 'recorded'
        }
      },
      exportRepository: noAccessExportRepository,
      moderationRepository: noAccessModerationRepository,
      moderationAuditExportRepository: {
        async exportAudit(actorAddress, afterSequence, bucketHash) {
          calls.push({ actorAddress, afterSequence, bucketHash })
          return { status: 'data', afterSequence, nextCursor: null, items: [] }
        }
      },
      isReady: async () => true
    })
    const server = createTestServerComponent<ApiAuthContext>()
    server.setContext({})
    server.use(router.middleware())

    const unsigned = await server.fetch(auditExportPath)
    expect(unsigned.status).toBe(400)
    expect(unsigned.headers.get('cache-control')).toBe('no-store')
    expect(await unsigned.json()).toEqual({ error: 'invalid-request' })
    expect(calls).toEqual([])

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Number(validWalletSignatureTimestamp))
      const rawMetadata = '{}'
      const payload = createPayload('GET', auditExportPath, validWalletSignatureTimestamp, rawMetadata)
      const walletHeaders = {
        'x-identity-auth-chain-0': JSON.stringify({
          type: 'SIGNER',
          payload: moderationAuditWalletAddress,
          signature: ''
        }),
        'x-identity-auth-chain-1': JSON.stringify({
          type: 'ECDSA_SIGNED_ENTITY',
          payload,
          signature: moderationAuditWalletSignature
        }),
        'x-identity-timestamp': validWalletSignatureTimestamp,
        'x-identity-metadata': rawMetadata
      }

      const differentCursor = await server.fetch('/v1/moderation/audit/1', { headers: walletHeaders })
      expect(differentCursor.status).toBe(401)
      expect(differentCursor.headers.get('cache-control')).toBe('no-store')
      expect(await differentCursor.json()).toEqual({ error: 'unauthorized' })
      expect(calls).toEqual([])

      const authorized = await server.fetch(auditExportPath, { headers: walletHeaders })
      expect(authorized.status).toBe(200)
      expect(authorized.headers.get('cache-control')).toBe('no-store')
      expect(await authorized.json()).toEqual({ afterSequence: '0', nextCursor: null, items: [] })
      expect(calls).toEqual([
        {
          actorAddress: moderationAuditWalletAddress,
          afterSequence: '0',
          bucketHash: config.digestActor('moderation-audit-export-rate', moderationAuditWalletAddress)
        }
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
