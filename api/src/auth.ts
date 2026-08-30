import {
  RequestError,
  rejectIfSigner,
  requireSigner,
  wellKnownComponents,
  type DecentralandSignatureContext
} from '@dcl/crypto-middleware'
import type { IHttpServerComponent } from '@well-known-components/interfaces'

export const SCENE_SIGNER = 'decentraland-kernel-scene'

export type SceneMetadata = Readonly<{
  sceneId: string
  parcel: string
  tld: 'org'
  network: 'mainnet'
  isGuest: boolean
  signer: typeof SCENE_SIGNER
  realm: Readonly<{
    hostname: string
    protocol: string
    serverName: string
  }>
  hashPayload: string
}> &
  Readonly<Record<string, unknown>>

export type SceneAuthContext = DecentralandSignatureContext<SceneMetadata>
export type ApiAuthContext = DecentralandSignatureContext<Record<string, unknown>>

export type PublishWalletMetadata = Readonly<{
  sceneId: string
  hashPayload: string
}> &
  Readonly<Record<string, unknown>>

export type DecisionWalletMetadata = Readonly<{
  hashPayload: string
}> &
  Readonly<Record<string, unknown>>

export type SceneAuthOptions = Readonly<{
  allowedSceneIds: readonly string[]
  trustedCatalystUrl: string
}>

export type WalletAuthOptions = Readonly<{
  trustedCatalystUrl: string
}>

const METADATA_KEYS = new Set(['sceneId', 'parcel', 'tld', 'network', 'isGuest', 'signer', 'realm', 'hashPayload'])
const REALM_KEYS = new Set(['hostname', 'protocol', 'serverName'])
const PUBLISH_WALLET_METADATA_KEYS = new Set(['sceneId', 'hashPayload'])
const DECISION_WALLET_METADATA_KEYS = new Set(['hashPayload'])
const SHA_256 = /^[0-9a-f]{64}$/u
const AUTH_EXPIRATION_MILLISECONDS = 60_000
const MAX_AUTH_CHAIN_LENGTH = 3
export const AUTH_FETCH_TIMEOUT_MILLISECONDS = 3_000
export const MAX_CONCURRENT_AUTH_FETCHES = 8
const MAX_AUTH_RESPONSE_BYTES = 16_384

type AuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

async function bufferAuthResponse(response: Response) {
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_AUTH_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Catalyst verification response is too large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  return new Response(Buffer.concat(chunks, length), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

export function createBoundedAuthFetcher(fetchImpl: AuthFetch = (input, init) => globalThis.fetch(input, init)) {
  let activeRequests = 0

  return {
    async fetch(input: string | URL | Request, init?: RequestInit) {
      if (activeRequests >= MAX_CONCURRENT_AUTH_FETCHES) {
        throw new Error('Catalyst verification capacity is exhausted')
      }

      activeRequests += 1
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => timeoutController.abort(), AUTH_FETCH_TIMEOUT_MILLISECONDS)
      timeout.unref()
      const upstreamSignals: AbortSignal[] = []
      if (init?.signal) upstreamSignals.push(init.signal)
      if (input instanceof Request) upstreamSignals.push(input.signal)
      const signal =
        upstreamSignals.length === 0
          ? timeoutController.signal
          : AbortSignal.any([timeoutController.signal, ...upstreamSignals])

      try {
        const response = await fetchImpl(input, {
          ...init,
          signal
        })
        return await bufferAuthResponse(response)
      } finally {
        clearTimeout(timeout)
        activeRequests -= 1
      }
    }
  }
}

const authFetcher = createBoundedAuthFetcher()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>) {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function isBoundedText(value: unknown, maximumBytes: number) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.trim() === value &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  )
}

function matchesSceneMetadata(
  metadata: Record<string, unknown>,
  allowedSceneIds: ReadonlySet<string>
): metadata is SceneMetadata {
  if (!hasExactKeys(metadata, METADATA_KEYS)) return false
  if (typeof metadata.sceneId !== 'string' || !allowedSceneIds.has(metadata.sceneId)) return false
  if (!isBoundedText(metadata.parcel, 128)) return false
  if (metadata.tld !== 'org' || metadata.network !== 'mainnet') return false
  if (typeof metadata.isGuest !== 'boolean' || metadata.signer !== SCENE_SIGNER) return false
  if (typeof metadata.hashPayload !== 'string' || !SHA_256.test(metadata.hashPayload)) return false
  if (!isRecord(metadata.realm) || !hasExactKeys(metadata.realm, REALM_KEYS)) return false
  return (
    isBoundedText(metadata.realm.hostname, 253) &&
    isBoundedText(metadata.realm.protocol, 32) &&
    isBoundedText(metadata.realm.serverName, 128)
  )
}

export function isSceneMetadata(
  metadata: Record<string, unknown>,
  allowedSceneIds: readonly string[]
): metadata is SceneMetadata {
  return matchesSceneMetadata(metadata, new Set(allowedSceneIds))
}

export function isPublishWalletMetadata(
  metadata: Record<string, unknown>,
  allowedSceneIds: readonly string[]
): metadata is PublishWalletMetadata {
  return (
    hasExactKeys(metadata, PUBLISH_WALLET_METADATA_KEYS) &&
    typeof metadata.sceneId === 'string' &&
    new Set(allowedSceneIds).has(metadata.sceneId) &&
    typeof metadata.hashPayload === 'string' &&
    SHA_256.test(metadata.hashPayload)
  )
}

export function isDecisionWalletMetadata(metadata: Record<string, unknown>): metadata is DecisionWalletMetadata {
  return (
    hasExactKeys(metadata, DECISION_WALLET_METADATA_KEYS) &&
    typeof metadata.hashPayload === 'string' &&
    SHA_256.test(metadata.hashPayload)
  )
}

export function isEmptyWalletMetadata(metadata: Record<string, unknown>) {
  return Object.keys(metadata).length === 0
}

type RequiredAuthOptions<P extends Record<string, unknown>> = Readonly<{
  trustedCatalystUrl: string
  metadataValidator: (metadata: P) => boolean
}>

function createRequiredAuthMiddleware<P extends Record<string, unknown>>(
  options: RequiredAuthOptions<P>
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  const middleware = wellKnownComponents<P>({
    catalyst: options.trustedCatalystUrl,
    fetcher: authFetcher,
    expiration: AUTH_EXPIRATION_MILLISECONDS,
    maxChainLength: MAX_AUTH_CHAIN_LENGTH,
    optional: false,
    metadataValidator: options.metadataValidator,
    onError: (error) => {
      if (error instanceof RequestError && error.statusCode === 400) {
        return { error: 'invalid-request' }
      }
      if (error instanceof RequestError && error.statusCode === 401) {
        return { error: 'unauthorized' }
      }
      return { error: 'service-unavailable' }
    }
  }) as unknown as IHttpServerComponent.IRequestHandler<ApiAuthContext>

  return async (context, next) => {
    const response = await middleware(context, next)
    if (context.verification === undefined && response.status !== undefined && response.status >= 500) {
      return { ...response, status: 503, body: { error: 'service-unavailable' } }
    }
    return response
  }
}

export function createSceneAuthMiddleware(
  options: SceneAuthOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  const allowedSceneIds = new Set(options.allowedSceneIds)
  const sceneSigner = requireSigner<SceneMetadata>(SCENE_SIGNER)
  return createRequiredAuthMiddleware<SceneMetadata>({
    trustedCatalystUrl: options.trustedCatalystUrl,
    metadataValidator: (metadata) => sceneSigner(metadata) && matchesSceneMetadata(metadata, allowedSceneIds)
  })
}

export function createWalletAuthMiddleware(
  options: WalletAuthOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  return createRequiredAuthMiddleware({
    trustedCatalystUrl: options.trustedCatalystUrl,
    metadataValidator: rejectIfSigner(SCENE_SIGNER)
  })
}

export function createPublishAuthMiddleware(
  options: SceneAuthOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  const allowedSceneIds = new Set(options.allowedSceneIds)
  const directWallet = rejectIfSigner(SCENE_SIGNER)
  return createRequiredAuthMiddleware<PublishWalletMetadata>({
    trustedCatalystUrl: options.trustedCatalystUrl,
    metadataValidator: (metadata) =>
      directWallet(metadata) &&
      hasExactKeys(metadata, PUBLISH_WALLET_METADATA_KEYS) &&
      typeof metadata.sceneId === 'string' &&
      allowedSceneIds.has(metadata.sceneId) &&
      typeof metadata.hashPayload === 'string' &&
      SHA_256.test(metadata.hashPayload)
  })
}

export function createDecisionAuthMiddleware(
  options: WalletAuthOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  const directWallet = rejectIfSigner(SCENE_SIGNER)
  return createRequiredAuthMiddleware<DecisionWalletMetadata>({
    trustedCatalystUrl: options.trustedCatalystUrl,
    metadataValidator: (metadata) => directWallet(metadata) && isDecisionWalletMetadata(metadata)
  })
}

export function createQueueAuthMiddleware(
  options: WalletAuthOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  const directWallet = rejectIfSigner(SCENE_SIGNER)
  return createRequiredAuthMiddleware({
    trustedCatalystUrl: options.trustedCatalystUrl,
    metadataValidator: (metadata) => directWallet(metadata) && isEmptyWalletMetadata(metadata)
  })
}
