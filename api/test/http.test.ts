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
  READINESS_CACHE_MILLISECONDS,
  createFunnelExportHandler,
  createFunnelHandler,
  createHttpRouter,
  type FunnelExportRepository,
  type FunnelRepository
} from '../src/http.js'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const address = `0x${'1'.repeat(40)}`
const sceneId = 'bafkrei-ghostlight'
const exportPath = '/v1/analytics/funnel/2026-08-01/2026-08-30'
const validWalletSignatureAddress = '0x5a78743a6917825631ee3a6df74532d57e57daa0'
const validWalletSignature =
  '0x26831b9a8d8f287957b0618bdc45c90e848ac3cbaf2157e7ed48a050c5d8b82a458f33a4c9b401e8d25aea2b43e4f739602f57773e7d981a2a47f134b22c9fd31c'
const validWalletSignatureTimestamp = '1790856000000'
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

const noAccessExportRepository: FunnelExportRepository = {
  async exportFunnel() {
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
      expect(errorSpy).toHaveBeenCalledWith('Unexpected analytics HTTP error')
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

      const [unready, coalesced] = await Promise.all([
        server.fetch('/health/ready'),
        server.fetch('/health/ready')
      ])
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
      isReady: async () => true
    })
    const server = createTestServerComponent<ApiAuthContext>()
    server.setContext({})
    server.use(router.middleware())

    const unsigned = await server.fetch(exportPath)
    expect(unsigned.status).toBe(400)
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
})
