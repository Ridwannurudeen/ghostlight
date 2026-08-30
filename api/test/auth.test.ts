import { createPayload } from '@dcl/crypto-middleware'
import { createTestServerComponent } from '@well-known-components/http-server'
import { describe, expect, it, vi } from 'vitest'
import {
  AUTH_FETCH_TIMEOUT_MILLISECONDS,
  MAX_CONCURRENT_AUTH_FETCHES,
  createBoundedAuthFetcher,
  createDecisionAuthMiddleware,
  createPublishAuthMiddleware,
  createQueueAuthMiddleware,
  createSceneAuthMiddleware,
  createWalletAuthMiddleware,
  isDecisionWalletMetadata,
  isEmptyWalletMetadata,
  isPublishWalletMetadata,
  isSceneMetadata,
  type ApiAuthContext,
  type SceneAuthContext
} from '../src/auth.js'

const sceneId = 'bafkrei-ghostlight'
const allowedSceneIds = Object.freeze([sceneId])
const ownerAddress = `0x${'1'.repeat(40)}`
const validSignatureAddress = '0x34dcaa77a8e617e7e46eb2db0d4c3dfe854bdd39'
const validSignature =
  '0xa9a16dfc4da7a6bbeadf362fca3ac5309f13eb119e9379d97c412ffc1cbb2a7b5ff4c715960748caee3412e8bdbcc0b1fff08cdcb6853390b62d7b352725431c1c'
const validSignatureTimestamp = '1790856000000'
const validWalletPath = '/v1/analytics/funnel/2026-08-01/2026-08-30'
const validWalletSignatureAddress = '0x5a78743a6917825631ee3a6df74532d57e57daa0'
const validWalletSignature =
  '0x26831b9a8d8f287957b0618bdc45c90e848ac3cbaf2157e7ed48a050c5d8b82a458f33a4c9b401e8d25aea2b43e4f739602f57773e7d981a2a47f134b22c9fd31c'
const validWalletLegacySignature =
  '0xa064be2f539f32779254aa913075411277bb2dd313b50543551e2dea19dcc7715fbf3f91721973bc8d1fb5522a5ec5ea2bd5201478dae5b35bef262752f891c01c'
const validWalletSignatureTimestamp = '1790856000000'
const moderationWalletAddress = '0x68f7d23a8a29eac2113d628c3bce4256692e0cac'
const moderationPublishSignature =
  '0xe21dac5d0d3e085ce95b42d51a710c28530e8b648401a3ce5d8c47c1336b190470cf2e8c74462ff2cdd6a6757ded2b7d4e0047d0c915561418322ed445d3f8141b'
const moderationDecisionSignature =
  '0xc8dcaa874988fe577d1a90064c966b7f74b4e944aef7a71e7974e11da83d84b20a7435d1ca671e16c8c702c77bcec87cd9e648f06fb49f7e2326446d4d59ef681b'
const moderationQueueSignature =
  '0xb6a54b57da20e528596d411d5c5dcaed618679c059eb9845e79dd60fc8c38d473be60a54f06d46a44a00cbb138a2efb2f96eb7d2243acdc10229159e55b2be631b'
const emptyBodyHash = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sceneId,
    parcel: '52,68',
    tld: 'org',
    network: 'mainnet',
    isGuest: false,
    signer: 'decentraland-kernel-scene',
    realm: {
      hostname: 'peer.decentraland.org',
      protocol: 'v3',
      serverName: 'hela'
    },
    hashPayload: 'a'.repeat(64),
    ...overrides
  }
}

function signatureHeaders(signedMetadata: Record<string, unknown>, signatureType = 'ECDSA_SIGNED_ENTITY') {
  return {
    'x-identity-auth-chain-0': JSON.stringify({
      type: 'SIGNER',
      payload: ownerAddress,
      signature: ''
    }),
    'x-identity-auth-chain-1': JSON.stringify({
      type: signatureType,
      payload: 'not-the-signed-payload',
      signature: 'malformed'
    }),
    'x-identity-timestamp': String(Date.now()),
    'x-identity-metadata': JSON.stringify(signedMetadata),
    'content-type': 'application/json'
  }
}

function authenticationServer(trustedCatalystUrl = 'https://peer.decentraland.org') {
  const server = createTestServerComponent<SceneAuthContext>()
  const state = { reached: false }
  server.setContext({})
  server.use(createSceneAuthMiddleware({ allowedSceneIds, trustedCatalystUrl }))
  server.use(async () => {
    state.reached = true
    return { status: 200, body: { ok: true } }
  })
  return { server, state }
}

function walletAuthenticationServer(trustedCatalystUrl = 'https://peer.decentraland.org') {
  const server = createTestServerComponent<ApiAuthContext>()
  const state: { reached: boolean; auth: string | undefined } = {
    reached: false,
    auth: undefined
  }
  server.setContext({})
  server.use(createWalletAuthMiddleware({ trustedCatalystUrl }))
  server.use(async (context) => {
    state.reached = true
    state.auth = context.verification?.auth
    return { status: 200, body: { ok: true } }
  })
  return { server, state }
}

function moderationAuthenticationServer(
  middleware: ReturnType<
    typeof createPublishAuthMiddleware | typeof createDecisionAuthMiddleware | typeof createQueueAuthMiddleware
  >
) {
  const server = createTestServerComponent<ApiAuthContext>()
  const state: { reached: boolean; auth: string | undefined } = { reached: false, auth: undefined }
  server.setContext({})
  server.use(middleware)
  server.use(async (context) => {
    state.reached = true
    state.auth = context.verification?.auth
    return { status: 200, body: { ok: true } }
  })
  return { server, state }
}

describe('bounded Catalyst verification fetches', () => {
  it('aborts an outbound verification that exceeds the fixed deadline', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = createBoundedAuthFetcher(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          })
      )

      const pending = fetcher.fetch('https://peer.decentraland.org/lambdas/crypto/validate-signature')
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(AUTH_FETCH_TIMEOUT_MILLISECONDS)

      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the deadline active through response-body consumption and recovers capacity', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const fetcher = createBoundedAuthFetcher(async (_input, init) => {
        calls += 1
        if (calls > 1) return new Response('{"valid":false,"ownerAddress":"0x0"}')
        if (!init?.signal) throw new Error('Expected a bounded fetch signal')
        const signal = init.signal
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"valid":'))
              signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
            }
          })
        )
      })

      const pending = fetcher.fetch('https://peer.decentraland.org/lambdas/crypto/validate-signature')
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(AUTH_FETCH_TIMEOUT_MILLISECONDS)
      await rejection

      await expect(
        fetcher.fetch('https://peer.decentraland.org/lambdas/crypto/validate-signature')
      ).resolves.toBeInstanceOf(Response)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed at the concurrency ceiling and releases capacity after completion', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const fetcher = createBoundedAuthFetcher(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const pending = Array.from({ length: MAX_CONCURRENT_AUTH_FETCHES }, () =>
      fetcher.fetch('https://peer.decentraland.org/lambdas/crypto/validate-signature')
    )

    await expect(fetcher.fetch('https://peer.decentraland.org/lambdas/crypto/validate-signature')).rejects.toThrow(
      'Catalyst verification capacity is exhausted'
    )

    for (const resolve of resolvers) resolve(new Response('{"valid":false,"ownerAddress":"0x0"}'))
    await Promise.all(pending)

    const recovered = fetcher.fetch('https://peer.decentraland.org/lambdas/crypto/validate-signature')
    resolvers[MAX_CONCURRENT_AUTH_FETCHES]?.(new Response('{"valid":false,"ownerAddress":"0x0"}'))
    await expect(recovered).resolves.toBeInstanceOf(Response)
  })

  it('rejects an oversized successful Catalyst response', async () => {
    const fetcher = createBoundedAuthFetcher(async () => new Response('x'.repeat(20_000)))

    await expect(fetcher.fetch('https://peer.decentraland.org/lambdas/crypto/validate-signature')).rejects.toThrow(
      'Catalyst verification response is too large'
    )
  })
})

describe('scene signed-fetch metadata', () => {
  it('accepts only the exact production ADR-289 shape for an allowlisted scene', () => {
    expect(isSceneMetadata(metadata(), allowedSceneIds)).toBe(true)
    expect(isSceneMetadata(metadata({ sceneId: 'not-allowlisted' }), allowedSceneIds)).toBe(false)
    expect(isSceneMetadata(metadata({ signer: 'wallet' }), allowedSceneIds)).toBe(false)
    expect(isSceneMetadata(metadata({ tld: 'zone' }), allowedSceneIds)).toBe(false)
    expect(isSceneMetadata(metadata({ network: 'sepolia' }), allowedSceneIds)).toBe(false)
    expect(isSceneMetadata(metadata({ extra: true }), allowedSceneIds)).toBe(false)
  })

  it('requires exact bounded scalar fields and a lowercase SHA-256 payload hash', () => {
    for (const malformed of [
      metadata({ sceneId: 1 }),
      metadata({ parcel: '' }),
      metadata({ parcel: ' 52,68' }),
      metadata({ parcel: 'x'.repeat(129) }),
      metadata({ isGuest: 'false' }),
      metadata({ hashPayload: 'A'.repeat(64) }),
      metadata({ hashPayload: 'a'.repeat(63) }),
      metadata({ hashPayload: undefined })
    ]) {
      expect(isSceneMetadata(malformed, allowedSceneIds)).toBe(false)
    }
  })

  it('requires an exact bounded realm object', () => {
    const validRealm = metadata().realm as Record<string, unknown>
    for (const realm of [
      null,
      [],
      { ...validRealm, extra: 'field' },
      { hostname: '', protocol: 'v3', serverName: 'hela' },
      { hostname: 'peer.decentraland.org', protocol: '', serverName: 'hela' },
      { hostname: 'peer.decentraland.org', protocol: 'v3', serverName: '' },
      { hostname: 'x'.repeat(254), protocol: 'v3', serverName: 'hela' },
      { hostname: 'peer.decentraland.org', protocol: 'x'.repeat(33), serverName: 'hela' },
      { hostname: 'peer.decentraland.org', protocol: 'v3', serverName: 'x'.repeat(129) }
    ]) {
      expect(isSceneMetadata(metadata({ realm }), allowedSceneIds)).toBe(false)
    }
  })
})

describe('moderation wallet metadata', () => {
  it('accepts only exact allowlisted publish metadata with a lowercase body hash', () => {
    const valid = { sceneId, hashPayload: emptyBodyHash }
    expect(isPublishWalletMetadata(valid, allowedSceneIds)).toBe(true)
    expect(isPublishWalletMetadata({ ...valid, sceneId: 'not-allowlisted' }, allowedSceneIds)).toBe(false)
    expect(isPublishWalletMetadata({ ...valid, hashPayload: emptyBodyHash.toUpperCase() }, allowedSceneIds)).toBe(false)
    expect(isPublishWalletMetadata({ ...valid, signer: 'wallet' }, allowedSceneIds)).toBe(false)
    expect(isPublishWalletMetadata({ hashPayload: emptyBodyHash }, allowedSceneIds)).toBe(false)
  })

  it('accepts only the exact decision and queue metadata shapes', () => {
    expect(isDecisionWalletMetadata({ hashPayload: emptyBodyHash })).toBe(true)
    expect(isDecisionWalletMetadata({ hashPayload: emptyBodyHash, extra: true })).toBe(false)
    expect(isDecisionWalletMetadata({ hashPayload: emptyBodyHash.toUpperCase() })).toBe(false)
    expect(isEmptyWalletMetadata({})).toBe(true)
    expect(isEmptyWalletMetadata({ fixtureVersion: 'V6' })).toBe(false)
  })
})

describe('required scene authentication middleware', () => {
  it('accepts a valid v6 payload whose metadata bytes are signature-bound', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Number(validSignatureTimestamp))
      const { server, state } = authenticationServer()
      const signedMetadata = metadata()
      const rawMetadata = JSON.stringify(signedMetadata)
      const payload = createPayload('POST', '/v1/analytics/funnel', validSignatureTimestamp, rawMetadata)
      const response = await server.fetch('/v1/analytics/funnel', {
        method: 'POST',
        headers: {
          'x-identity-auth-chain-0': JSON.stringify({
            type: 'SIGNER',
            payload: validSignatureAddress,
            signature: ''
          }),
          'x-identity-auth-chain-1': JSON.stringify({
            type: 'ECDSA_SIGNED_ENTITY',
            payload,
            signature: validSignature
          }),
          'x-identity-timestamp': validSignatureTimestamp,
          'x-identity-metadata': rawMetadata,
          'content-type': 'application/json'
        },
        body: '{}'
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(state.reached).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves malformed authentication as a sanitized invalid request', async () => {
    const { server, state } = authenticationServer()

    const response = await server.fetch('/v1/analytics/funnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid-request' })
    expect(state.reached).toBe(false)
  })

  it('preserves failed signature verification as sanitized unauthorized', async () => {
    const { server, state } = authenticationServer()

    const response = await server.fetch('/v1/analytics/funnel', {
      method: 'POST',
      headers: signatureHeaders(metadata()),
      body: '{}'
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(state.reached).toBe(false)
  })

  it('composes the installed canonical scene signer gate with structural validation', async () => {
    const { server, state } = authenticationServer()

    const response = await server.fetch('/v1/analytics/funnel', {
      method: 'POST',
      headers: signatureHeaders(metadata({ signer: 'Decentraland-Kernel-Scene' })),
      body: '{}'
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid-request' })
    expect(state.reached).toBe(false)
  })

  it('maps unexpected and Catalyst verification failures to sanitized unavailable', async () => {
    const { server, state } = authenticationServer('not-a-valid-url')

    const response = await server.fetch('/v1/analytics/funnel', {
      method: 'POST',
      headers: signatureHeaders(metadata(), 'ECDSA_EIP_1654_EPHEMERAL'),
      body: '{}'
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'service-unavailable' })
    expect(state.reached).toBe(false)
  })

  it('routes contract-wallet verification through the bounded fetcher and sanitizes its failures', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(20_000)))
    try {
      const { server, state } = authenticationServer()

      const response = await server.fetch('/v1/analytics/funnel', {
        method: 'POST',
        headers: signatureHeaders(metadata(), 'ECDSA_EIP_1654_EPHEMERAL'),
        body: '{}'
      })

      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'service-unavailable' })
      expect(state.reached).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('required direct-wallet authentication middleware', () => {
  it('accepts a real current-v6 wallet signature without treating its metadata as scene metadata', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Number(validWalletSignatureTimestamp))
      const { server, state } = walletAuthenticationServer()
      const rawMetadata = JSON.stringify({ fixtureVersion: 'V6' })
      const payload = createPayload('GET', validWalletPath, validWalletSignatureTimestamp, rawMetadata)
      const response = await server.fetch(validWalletPath, {
        method: 'GET',
        headers: {
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
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(state).toEqual({ reached: true, auth: validWalletSignatureAddress })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects the matching legacy-folded wallet signature when fallback keys are absent', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Number(validWalletSignatureTimestamp))
      const { server, state } = walletAuthenticationServer()
      const rawMetadata = JSON.stringify({ fixtureVersion: 'V6' })
      const currentPayload = createPayload('GET', validWalletPath, validWalletSignatureTimestamp, rawMetadata)
      const legacyPayload = ['GET', validWalletPath, validWalletSignatureTimestamp, rawMetadata].join(':').toLowerCase()
      expect(currentPayload).not.toBe(legacyPayload)

      const response = await server.fetch(validWalletPath, {
        method: 'GET',
        headers: {
          'x-identity-auth-chain-0': JSON.stringify({
            type: 'SIGNER',
            payload: validWalletSignatureAddress,
            signature: ''
          }),
          'x-identity-auth-chain-1': JSON.stringify({
            type: 'ECDSA_SIGNED_ENTITY',
            payload: legacyPayload,
            signature: validWalletLegacySignature
          }),
          'x-identity-timestamp': validWalletSignatureTimestamp,
          'x-identity-metadata': rawMetadata
        }
      })

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
      expect(state.reached).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects scene-signer metadata before the export handler can run', async () => {
    const { server, state } = walletAuthenticationServer()

    const response = await server.fetch(validWalletPath, {
      method: 'GET',
      headers: signatureHeaders(metadata())
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid-request' })
    expect(state.reached).toBe(false)
  })
})

describe('required moderation wallet authentication middleware', () => {
  it('accepts real current-v6 signatures for the exact publish, decision, and queue contracts', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Number(validWalletSignatureTimestamp))
      const fixtures = [
        {
          path: '/v1/moderation/subjects',
          method: 'POST',
          rawMetadata: JSON.stringify({ sceneId, hashPayload: emptyBodyHash }),
          signature: moderationPublishSignature,
          middleware: createPublishAuthMiddleware({
            allowedSceneIds,
            trustedCatalystUrl: 'https://peer.decentraland.org'
          })
        },
        {
          path: '/v1/moderation/decisions',
          method: 'POST',
          rawMetadata: JSON.stringify({ hashPayload: emptyBodyHash }),
          signature: moderationDecisionSignature,
          middleware: createDecisionAuthMiddleware({ trustedCatalystUrl: 'https://peer.decentraland.org' })
        },
        {
          path: '/v1/moderation/queue',
          method: 'GET',
          rawMetadata: '{}',
          signature: moderationQueueSignature,
          middleware: createQueueAuthMiddleware({ trustedCatalystUrl: 'https://peer.decentraland.org' })
        }
      ] as const

      for (const fixture of fixtures) {
        const { server, state } = moderationAuthenticationServer(fixture.middleware)
        const payload = createPayload(fixture.method, fixture.path, validWalletSignatureTimestamp, fixture.rawMetadata)
        const response = await server.fetch(fixture.path, {
          method: fixture.method,
          headers: {
            'x-identity-auth-chain-0': JSON.stringify({
              type: 'SIGNER',
              payload: moderationWalletAddress,
              signature: ''
            }),
            'x-identity-auth-chain-1': JSON.stringify({
              type: 'ECDSA_SIGNED_ENTITY',
              payload,
              signature: fixture.signature
            }),
            'x-identity-timestamp': validWalletSignatureTimestamp,
            'x-identity-metadata': fixture.rawMetadata,
            'content-type': 'application/json'
          },
          body: fixture.method === 'POST' ? '{}' : undefined
        })

        expect(response.status, fixture.path).toBe(200)
        expect(state, fixture.path).toEqual({ reached: true, auth: moderationWalletAddress })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects extra, scene-signer, and nonempty queue metadata before handlers run', async () => {
    const fixtures = [
      {
        path: '/v1/moderation/subjects',
        metadata: { sceneId, hashPayload: emptyBodyHash, extra: true },
        middleware: createPublishAuthMiddleware({
          allowedSceneIds,
          trustedCatalystUrl: 'https://peer.decentraland.org'
        })
      },
      {
        path: '/v1/moderation/decisions',
        metadata: { hashPayload: emptyBodyHash, signer: 'decentraland-kernel-scene' },
        middleware: createDecisionAuthMiddleware({ trustedCatalystUrl: 'https://peer.decentraland.org' })
      },
      {
        path: '/v1/moderation/queue',
        metadata: { fixtureVersion: 'V6' },
        middleware: createQueueAuthMiddleware({ trustedCatalystUrl: 'https://peer.decentraland.org' })
      }
    ] as const

    for (const fixture of fixtures) {
      const { server, state } = moderationAuthenticationServer(fixture.middleware)
      const response = await server.fetch(fixture.path, {
        method: fixture.path.endsWith('queue') ? 'GET' : 'POST',
        headers: signatureHeaders(fixture.metadata),
        body: fixture.path.endsWith('queue') ? undefined : '{}'
      })
      expect(response.status, fixture.path).toBe(400)
      expect(await response.json(), fixture.path).toEqual({ error: 'invalid-request' })
      expect(state.reached, fixture.path).toBe(false)
    }
  })
})
