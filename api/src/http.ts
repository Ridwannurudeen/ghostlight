import { createHash } from 'node:crypto'
import { Router } from '@well-known-components/http-server'
import type { IHttpServerComponent } from '@well-known-components/interfaces'
import {
  parseAnalyticsExportRange,
  type AnalyticsExportRange,
  type AnalyticsExportResult
} from './analytics-export-repository.js'
import type { AnalyticsRateIdentity, FunnelAnalyticsEvent, FunnelIngestResult } from './analytics-repository.js'
import { createSceneAuthMiddleware, createWalletAuthMiddleware, isSceneMetadata, type ApiAuthContext } from './auth.js'
import type { AppConfig } from './config.js'
import { normalizeAddress, parseAnalyticsEvent } from './contracts.js'

export const MAX_FUNNEL_BODY_BYTES = 1_024
export const READINESS_CACHE_MILLISECONDS = 1_000
const FUNNEL_PATH = '/v1/analytics/funnel'
const FUNNEL_EXPORT_ROUTE = '/v1/analytics/funnel/:fromDay/:toDay'

export interface FunnelRepository {
  recordFunnel(sceneId: string, event: FunnelAnalyticsEvent, rate: AnalyticsRateIdentity): Promise<FunnelIngestResult>
}

export interface FunnelExportRepository {
  exportFunnel(actorAddress: string, range: AnalyticsExportRange, bucketHash: Buffer): Promise<AnalyticsExportResult>
}

type FunnelHttpConfig = Pick<AppConfig, 'allowedSceneIds' | 'trustedCatalystUrl' | 'digestActor'>

type HttpBaseOptions = Readonly<{
  config: FunnelHttpConfig
  onUnexpectedError?: (error: unknown) => void
}>

export type FunnelHandlerOptions = HttpBaseOptions &
  Readonly<{
    repository: FunnelRepository
  }>

export type FunnelExportHandlerOptions = HttpBaseOptions &
  Readonly<{
    exportRepository: FunnelExportRepository
  }>

export type HttpRouterOptions = HttpBaseOptions &
  Readonly<{
    repository: FunnelRepository
    exportRepository: FunnelExportRepository
    isReady: () => Promise<boolean>
  }>

type RawBodyResult =
  | Readonly<{ kind: 'body'; value: Buffer }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'too-large' }>

const CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)$/u

function json(status: number, body: Record<string, unknown>, headers?: Record<string, string>) {
  return headers === undefined ? { status, body } : { status, body, headers }
}

function reportUnexpected(options: HttpBaseOptions, error: unknown) {
  if (options.onUnexpectedError) {
    options.onUnexpectedError(error)
  } else {
    console.error('Unexpected analytics HTTP error')
  }
}

function acceptsJson(contentType: string | null) {
  if (contentType === null) return false
  const [mediaType, ...parameters] = contentType.split(';').map((part) => part.trim())
  if (mediaType?.toLowerCase() !== 'application/json') return false
  return parameters.length === 0 || (parameters.length === 1 && /^charset\s*=\s*utf-8$/iu.test(parameters[0] ?? ''))
}

function asBuffer(chunk: unknown) {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  throw new TypeError('Unsupported request body chunk')
}

async function readRawBody(request: IHttpServerComponent.IRequest): Promise<RawBodyResult> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    if (!CONTENT_LENGTH.test(contentLength)) return { kind: 'invalid' }
    if (Number(contentLength) > MAX_FUNNEL_BODY_BYTES) return { kind: 'too-large' }
  }

  if (request.body === null) return { kind: 'body', value: Buffer.alloc(0) }
  if (request.body instanceof Uint8Array) {
    if (request.body.byteLength > MAX_FUNNEL_BODY_BYTES) return { kind: 'too-large' }
    return { kind: 'body', value: Buffer.from(request.body) }
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request.body as AsyncIterable<unknown>) {
    const buffer = asBuffer(chunk)
    length += buffer.byteLength
    if (length > MAX_FUNNEL_BODY_BYTES) return { kind: 'too-large' }
    chunks.push(buffer)
  }
  return { kind: 'body', value: Buffer.concat(chunks, length) }
}

function invalidRequest() {
  return json(400, { error: 'invalid-request' })
}

function exportJson(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return json(status, body, { ...headers, 'Cache-Control': 'no-store' })
}

function invalidExportRequest() {
  return exportJson(400, { error: 'invalid-request' })
}

function resultResponse(result: FunnelIngestResult) {
  switch (result) {
    case 'recorded':
    case 'duplicate':
      return json(202, { ok: true })
    case 'event-id-conflict':
      return json(409, { error: 'event-id-conflict' })
    case 'future':
    case 'expired':
    case 'scene-not-allowed':
      return invalidRequest()
    case 'rate-limited':
      return json(429, { error: 'rate-limited' }, { 'Retry-After': '60' })
  }
}

export function createFunnelHandler(
  options: FunnelHandlerOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  return async (context) => {
    if (context.url.pathname !== FUNNEL_PATH) return invalidRequest()
    if (context.url.search !== '') return invalidRequest()
    const contentEncoding = context.request.headers.get('content-encoding')
    if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
      return json(415, { error: 'unsupported-media-type' })
    }
    if (!acceptsJson(context.request.headers.get('content-type'))) {
      return json(415, { error: 'unsupported-media-type' })
    }

    const verification = context.verification
    if (verification === undefined || !isSceneMetadata(verification.authMetadata, options.config.allowedSceneIds)) {
      return json(401, { error: 'unauthorized' })
    }

    let actor: string
    try {
      actor = normalizeAddress(verification.auth)
    } catch {
      return json(401, { error: 'unauthorized' })
    }

    let rawBody: RawBodyResult
    try {
      rawBody = await readRawBody(context.request)
    } catch (error) {
      reportUnexpected(options, error)
      return json(503, { error: 'service-unavailable' })
    }
    if (rawBody.kind === 'invalid') return invalidRequest()
    if (rawBody.kind === 'too-large') return json(413, { error: 'payload-too-large' })

    const calculatedHash = createHash('sha256').update(rawBody.value).digest('hex')
    if (calculatedHash !== verification.authMetadata.hashPayload) return invalidRequest()

    let decoded: string
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody.value)
    } catch {
      return invalidRequest()
    }

    let event: FunnelAnalyticsEvent
    try {
      const parsed = parseAnalyticsEvent(JSON.parse(decoded) as unknown)
      if (parsed.kind !== 'funnel') return invalidRequest()
      event = parsed
    } catch {
      return invalidRequest()
    }

    const scope = verification.authMetadata.isGuest ? 'analytics-guest' : 'analytics-wallet'
    const purpose = verification.authMetadata.isGuest ? 'analytics-guest-rate' : 'analytics-wallet-rate'
    let result: FunnelIngestResult
    try {
      result = await options.repository.recordFunnel(verification.authMetadata.sceneId, event, {
        scope,
        bucketHash: options.config.digestActor(purpose, actor)
      })
    } catch (error) {
      reportUnexpected(options, error)
      return json(503, { error: 'service-unavailable' })
    }
    return resultResponse(result)
  }
}

type FunnelExportRouteContext = IHttpServerComponent.PathAwareContext<ApiAuthContext, typeof FUNNEL_EXPORT_ROUTE>

export function createFunnelExportHandler(
  options: FunnelExportHandlerOptions
): IHttpServerComponent.IRequestHandler<FunnelExportRouteContext> {
  return async (context) => {
    const fromDay: unknown = context.params.fromDay
    const toDay: unknown = context.params.toDay
    if (
      typeof fromDay !== 'string' ||
      typeof toDay !== 'string' ||
      context.url.pathname !== `${FUNNEL_PATH}/${fromDay}/${toDay}` ||
      context.url.search !== ''
    ) {
      return invalidExportRequest()
    }

    let range: AnalyticsExportRange
    try {
      range = parseAnalyticsExportRange(fromDay, toDay)
    } catch {
      return invalidExportRequest()
    }

    const verification = context.verification
    if (verification === undefined) return exportJson(401, { error: 'unauthorized' })

    let actor: string
    try {
      actor = normalizeAddress(verification.auth)
    } catch {
      return exportJson(401, { error: 'unauthorized' })
    }

    let result: AnalyticsExportResult
    try {
      result = await options.exportRepository.exportFunnel(
        actor,
        range,
        options.config.digestActor('export-rate', actor)
      )
    } catch (error) {
      reportUnexpected(options, error)
      return exportJson(503, { error: 'service-unavailable' })
    }

    switch (result.status) {
      case 'unauthorized':
        return exportJson(403, { error: 'forbidden' })
      case 'rate-limited':
        return exportJson(429, { error: 'rate-limited' }, { 'Retry-After': '3600' })
      case 'data':
        return exportJson(200, { fromDay: range.fromDay, toDay: range.toDay, rows: result.rows })
    }
  }
}

export function createHttpRouter(options: HttpRouterOptions) {
  const router = new Router<ApiAuthContext>()
  let readiness: Readonly<{ ready: boolean; expiresAt: number }> | undefined
  let readinessProbe: Promise<boolean> | undefined
  router.get('/health/live', async () => json(200, { status: 'pass' }))
  router.get('/health/ready', async () => {
    const now = Date.now()
    if (readiness === undefined || now >= readiness.expiresAt) {
      if (readinessProbe === undefined) {
        readinessProbe = options
          .isReady()
          .catch((error) => {
            reportUnexpected(options, error)
            return false
          })
          .then((ready) => {
            readiness = { ready, expiresAt: Date.now() + READINESS_CACHE_MILLISECONDS }
            return ready
          })
          .finally(() => {
            readinessProbe = undefined
          })
      }
      await readinessProbe
    }
    const ready = readiness?.ready === true
    return json(ready ? 200 : 503, { status: ready ? 'pass' : 'fail' })
  })
  router.post(
    FUNNEL_PATH,
    createSceneAuthMiddleware({
      allowedSceneIds: options.config.allowedSceneIds,
      trustedCatalystUrl: options.config.trustedCatalystUrl
    }),
    createFunnelHandler(options)
  )
  router.get(
    FUNNEL_EXPORT_ROUTE,
    createWalletAuthMiddleware({ trustedCatalystUrl: options.config.trustedCatalystUrl }),
    createFunnelExportHandler(options)
  )
  return router
}
