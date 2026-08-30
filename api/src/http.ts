import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Router } from '@well-known-components/http-server'
import type { IHttpServerComponent } from '@well-known-components/interfaces'
import {
  parseAnalyticsExportRange,
  type AnalyticsExportRange,
  type AnalyticsExportResult
} from './analytics-export-repository.js'
import type { AnalyticsRateIdentity, FunnelAnalyticsEvent, FunnelIngestResult } from './analytics-repository.js'
import {
  createDecisionAuthMiddleware,
  createPublishAuthMiddleware,
  createQueueAuthMiddleware,
  createSceneAuthMiddleware,
  createWalletAuthMiddleware,
  isDecisionWalletMetadata,
  isEmptyWalletMetadata,
  isPublishWalletMetadata,
  isSceneMetadata,
  type ApiAuthContext
} from './auth.js'
import type { AppConfig } from './config.js'
import {
  normalizeAddress,
  parseAnalyticsEvent,
  parseModerationDecision,
  parseModerationReport,
  parsePublishSubject,
  type ModerationDecisionInput,
  type ModerationReportInput,
  type PublishSubject
} from './contracts.js'
import type {
  ModerationDecisionIdentity,
  ModerationDecisionResult,
  ModerationPublishIdentity,
  ModerationPublishResult,
  ModerationQueueResult,
  ModerationReportIdentity,
  ModerationReportResult
} from './moderation-repository.js'
import { parseModerationAuditCursor, type ModerationAuditExportResult } from './moderation-audit-export-repository.js'
import { seasonZeroCalendarSnapshot } from './season-calendar.js'

export const MAX_FUNNEL_BODY_BYTES = 1_024
export const MAX_MODERATION_BODY_BYTES = 8_192
export const READINESS_CACHE_MILLISECONDS = 1_000
const FUNNEL_PATH = '/v1/analytics/funnel'
const FUNNEL_EXPORT_ROUTE = '/v1/analytics/funnel/:fromDay/:toDay'
const MODERATION_SUBJECTS_PATH = '/v1/moderation/subjects'
const MODERATION_REPORTS_PATH = '/v1/moderation/reports'
const MODERATION_QUEUE_PATH = '/v1/moderation/queue'
const MODERATION_DECISIONS_PATH = '/v1/moderation/decisions'
const MODERATION_AUDIT_ROUTE = '/v1/moderation/audit/:afterSequence'
const SEASON_ZERO_CALENDAR_PATH = '/v1/seasons/season-zero/calendar'
const LIVE_PATH = '/health/live'
const READY_PATH = '/health/ready'
const FUNNEL_EXPORT_PATH = /^\/v1\/analytics\/funnel\/[^/]+\/[^/]+$/u
const MODERATION_AUDIT_PATH = /^\/v1\/moderation\/audit\/[^/]+$/u

type RequestSloRouteTemplate =
  | typeof FUNNEL_PATH
  | typeof FUNNEL_EXPORT_ROUTE
  | typeof MODERATION_SUBJECTS_PATH
  | typeof MODERATION_REPORTS_PATH
  | typeof MODERATION_QUEUE_PATH
  | typeof MODERATION_DECISIONS_PATH
  | typeof MODERATION_AUDIT_ROUTE
  | typeof SEASON_ZERO_CALENDAR_PATH
  | typeof LIVE_PATH
  | typeof READY_PATH
  | 'unmatched'

type RequestSloMethod = 'CONNECT' | 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT' | 'TRACE' | 'OTHER'

export type RequestSloRecord = Readonly<{
  route: RequestSloRouteTemplate
  method: RequestSloMethod
  status: number
  durationMs: number
}>

export interface FunnelRepository {
  recordFunnel(sceneId: string, event: FunnelAnalyticsEvent, rate: AnalyticsRateIdentity): Promise<FunnelIngestResult>
}

export interface FunnelExportRepository {
  exportFunnel(actorAddress: string, range: AnalyticsExportRange, bucketHash: Buffer): Promise<AnalyticsExportResult>
}

export interface ModerationHttpRepository {
  publish(
    sceneId: string,
    subject: PublishSubject,
    identity: ModerationPublishIdentity
  ): Promise<ModerationPublishResult>
  report(
    sceneId: string,
    report: ModerationReportInput,
    identity: ModerationReportIdentity
  ): Promise<ModerationReportResult>
  queue(moderatorAddress: string): Promise<ModerationQueueResult>
  decide(decision: ModerationDecisionInput, identity: ModerationDecisionIdentity): Promise<ModerationDecisionResult>
}

export interface ModerationAuditExportHttpRepository {
  exportAudit(actorAddress: string, afterSequence: string, bucketHash: Buffer): Promise<ModerationAuditExportResult>
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

export type ModerationHandlerOptions = HttpBaseOptions &
  Readonly<{
    moderationRepository: ModerationHttpRepository
  }>

export type ModerationAuditExportHandlerOptions = HttpBaseOptions &
  Readonly<{
    moderationAuditExportRepository: ModerationAuditExportHttpRepository
  }>

export type HttpRouterOptions = HttpBaseOptions &
  Readonly<{
    repository: FunnelRepository
    exportRepository: FunnelExportRepository
    moderationRepository: ModerationHttpRepository
    moderationAuditExportRepository: ModerationAuditExportHttpRepository
    isReady: () => Promise<boolean>
  }>

type RawBodyResult =
  | Readonly<{ kind: 'body'; value: Buffer }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'too-large' }>

type SignedJsonBodyResult =
  | Readonly<{ kind: 'json'; value: unknown }>
  | Readonly<{ kind: 'invalid' | 'too-large' | 'unsupported' | 'unavailable' }>

const CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)$/u

function requestSloRouteTemplate(pathname: string): RequestSloRouteTemplate {
  const normalizedPathname = (pathname.endsWith('/') ? pathname.slice(0, -1) : pathname).toLowerCase()
  switch (normalizedPathname) {
    case FUNNEL_PATH:
    case MODERATION_SUBJECTS_PATH:
    case MODERATION_REPORTS_PATH:
    case MODERATION_QUEUE_PATH:
    case MODERATION_DECISIONS_PATH:
    case SEASON_ZERO_CALENDAR_PATH:
    case LIVE_PATH:
    case READY_PATH:
      return normalizedPathname
  }
  if (FUNNEL_EXPORT_PATH.test(normalizedPathname)) return FUNNEL_EXPORT_ROUTE
  if (MODERATION_AUDIT_PATH.test(normalizedPathname)) return MODERATION_AUDIT_ROUTE
  return 'unmatched'
}

function requestSloMethod(method: string): RequestSloMethod {
  const normalized = method.toUpperCase()
  switch (normalized) {
    case 'CONNECT':
    case 'DELETE':
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
    case 'PATCH':
    case 'POST':
    case 'PUT':
    case 'TRACE':
      return normalized
    default:
      return 'OTHER'
  }
}

function requestSloStatus(status: number | undefined) {
  if (status === undefined) return 200
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500
}

function requestSloErrorStatus(error: unknown) {
  if (typeof error !== 'object' || error === null) return 500
  const status = 'status' in error ? error.status : undefined
  const statusCode = 'statusCode' in error ? error.statusCode : undefined
  const coercedStatus = status || statusCode
  return typeof coercedStatus === 'number' &&
    Number.isInteger(coercedStatus) &&
    coercedStatus >= 100 &&
    coercedStatus <= 599
    ? coercedStatus
    : 500
}

function requestSloDuration(startedAt: number, finishedAt: number) {
  const duration = finishedAt - startedAt
  return Number.isFinite(duration) && duration >= 0 ? duration : 0
}

export function createRequestSloMiddleware(
  options: Readonly<{
    record: (record: RequestSloRecord) => void
    monotonicNow?: () => number
  }>
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  return async (context, next) => {
    const route = requestSloRouteTemplate(context.url.pathname)
    const method = requestSloMethod(context.request.method)
    const startedAt = monotonicNow()
    let status = 500
    try {
      const response = await next()
      status = requestSloStatus(response.status)
      return response
    } catch (error) {
      status = requestSloErrorStatus(error)
      throw error
    } finally {
      options.record({
        route,
        method,
        status,
        durationMs: requestSloDuration(startedAt, monotonicNow())
      })
    }
  }
}

function json(status: number, body: Record<string, unknown>, headers?: Record<string, string>) {
  return headers === undefined ? { status, body } : { status, body, headers }
}

type HeaderCollection = Readonly<{
  forEach(callback: (value: string, name: string) => void): void
}>

function isHeaderCollection(value: object): value is HeaderCollection {
  return 'forEach' in value && typeof value.forEach === 'function'
}

function withNoStore(headers: IHttpServerComponent.IResponse['headers']) {
  const normalized: Record<string, string | string[]> = {}
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      const name = pair[0]
      const value = pair[1]
      if (name !== undefined && value !== undefined) normalized[name] = value
    }
  } else if (headers !== undefined && isHeaderCollection(headers)) {
    headers.forEach((value, name) => {
      normalized[name] = value
    })
  } else if (headers !== undefined) {
    Object.assign(normalized, headers)
  }

  for (const name of Object.keys(normalized)) {
    if (name.toLowerCase() === 'cache-control') delete normalized[name]
  }
  normalized['Cache-Control'] = 'no-store'
  return normalized
}

const noStore: IHttpServerComponent.IRequestHandler<ApiAuthContext> = async (_context, next) => {
  const response = await next()
  return { ...response, headers: withNoStore(response.headers) }
}

function reportUnexpected(options: HttpBaseOptions, error: unknown) {
  if (options.onUnexpectedError) {
    options.onUnexpectedError(error)
  } else {
    console.error('Unexpected API HTTP error')
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

async function readRawBody(request: IHttpServerComponent.IRequest, maximumBytes: number): Promise<RawBodyResult> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    if (!CONTENT_LENGTH.test(contentLength)) return { kind: 'invalid' }
    if (Number(contentLength) > maximumBytes) return { kind: 'too-large' }
  }

  if (request.body === null) return { kind: 'body', value: Buffer.alloc(0) }
  if (request.body instanceof Uint8Array) {
    if (request.body.byteLength > maximumBytes) return { kind: 'too-large' }
    return { kind: 'body', value: Buffer.from(request.body) }
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request.body as AsyncIterable<unknown>) {
    const buffer = asBuffer(chunk)
    length += buffer.byteLength
    if (length > maximumBytes) return { kind: 'too-large' }
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

function moderationJson(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return json(status, body, { ...headers, 'Cache-Control': 'no-store' })
}

function moderationInvalidRequest() {
  return moderationJson(400, { error: 'invalid-request' })
}

async function readSignedJsonBody(
  request: IHttpServerComponent.IRequest,
  expectedHash: string,
  options: HttpBaseOptions
): Promise<SignedJsonBodyResult> {
  const contentEncoding = request.headers.get('content-encoding')
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
    return { kind: 'unsupported' }
  }
  if (!acceptsJson(request.headers.get('content-type'))) return { kind: 'unsupported' }

  let rawBody: RawBodyResult
  try {
    rawBody = await readRawBody(request, MAX_MODERATION_BODY_BYTES)
  } catch (error) {
    reportUnexpected(options, error)
    return { kind: 'unavailable' }
  }
  if (rawBody.kind !== 'body') return rawBody
  if (createHash('sha256').update(rawBody.value).digest('hex') !== expectedHash) {
    return { kind: 'invalid' }
  }

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody.value)
    return { kind: 'json', value: JSON.parse(decoded) as unknown }
  } catch {
    return { kind: 'invalid' }
  }
}

function moderationBodyFailure(result: Exclude<SignedJsonBodyResult, { kind: 'json' }>) {
  switch (result.kind) {
    case 'invalid':
      return moderationInvalidRequest()
    case 'too-large':
      return moderationJson(413, { error: 'payload-too-large' })
    case 'unsupported':
      return moderationJson(415, { error: 'unsupported-media-type' })
    case 'unavailable':
      return moderationJson(503, { error: 'service-unavailable' })
  }
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
      rawBody = await readRawBody(context.request, MAX_FUNNEL_BODY_BYTES)
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

export function createModerationPublishHandler(
  options: ModerationHandlerOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  return async (context) => {
    if (context.url.pathname !== MODERATION_SUBJECTS_PATH || context.url.search !== '') {
      return moderationInvalidRequest()
    }

    const verification = context.verification
    if (
      verification === undefined ||
      !isPublishWalletMetadata(verification.authMetadata, options.config.allowedSceneIds)
    ) {
      return moderationJson(401, { error: 'unauthorized' })
    }

    let actor: string
    try {
      actor = normalizeAddress(verification.auth)
    } catch {
      return moderationJson(401, { error: 'unauthorized' })
    }

    const body = await readSignedJsonBody(context.request, verification.authMetadata.hashPayload, options)
    if (body.kind !== 'json') return moderationBodyFailure(body)

    let subject: PublishSubject
    try {
      subject = parsePublishSubject(body.value)
    } catch {
      return moderationInvalidRequest()
    }

    let result: ModerationPublishResult
    try {
      result = await options.moderationRepository.publish(verification.authMetadata.sceneId, subject, {
        actorAddress: actor,
        bucketHash: options.config.digestActor('publish-rate', actor),
        auditDigest: options.config.digestActor('moderation-audit', actor)
      })
    } catch (error) {
      reportUnexpected(options, error)
      return moderationJson(503, { error: 'service-unavailable' })
    }

    switch (result.status) {
      case 'published':
      case 'replay':
        return moderationJson(202, { ok: true })
      case 'id-conflict':
        return moderationJson(409, { error: 'subject-id-conflict' })
      case 'duplicate-content':
        return moderationJson(409, { error: 'duplicate-content' })
      case 'invalid-content':
      case 'timestamp-out-of-range':
      case 'scene-not-allowed':
        return moderationInvalidRequest()
      case 'rate-limited':
        return moderationJson(429, { error: 'rate-limited' }, { 'Retry-After': '3600' })
    }
  }
}

export function createModerationReportHandler(
  options: ModerationHandlerOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  return async (context) => {
    if (context.url.pathname !== MODERATION_REPORTS_PATH || context.url.search !== '') {
      return moderationInvalidRequest()
    }

    const verification = context.verification
    if (verification === undefined || !isSceneMetadata(verification.authMetadata, options.config.allowedSceneIds)) {
      return moderationJson(401, { error: 'unauthorized' })
    }

    let actor: string
    try {
      actor = normalizeAddress(verification.auth)
    } catch {
      return moderationJson(401, { error: 'unauthorized' })
    }

    const body = await readSignedJsonBody(context.request, verification.authMetadata.hashPayload, options)
    if (body.kind !== 'json') return moderationBodyFailure(body)

    let report: ModerationReportInput
    try {
      report = parseModerationReport(body.value)
    } catch {
      return moderationInvalidRequest()
    }

    const digestIdentity = `${actor}\0${report.contentId}\0${report.reason}`
    const scope = verification.authMetadata.isGuest ? 'report-guest' : 'report-wallet'
    const ratePurpose = verification.authMetadata.isGuest ? 'report-guest-rate' : 'report-wallet-rate'
    let result: ModerationReportResult
    try {
      result = await options.moderationRepository.report(verification.authMetadata.sceneId, report, {
        scope,
        bucketHash: options.config.digestActor(ratePurpose, actor),
        reporterDigest: options.config.digestActor('moderation-report', digestIdentity),
        auditDigest: options.config.digestActor('moderation-audit', digestIdentity)
      })
    } catch (error) {
      reportUnexpected(options, error)
      return moderationJson(503, { error: 'service-unavailable' })
    }

    switch (result.status) {
      case 'reported':
      case 'replay':
      case 'duplicate-report':
        return moderationJson(202, { ok: true })
      case 'report-id-conflict':
        return moderationJson(409, { error: 'report-id-conflict' })
      case 'subject-not-found':
      case 'subject-unavailable':
        return moderationJson(404, { error: 'not-found' })
      case 'timestamp-out-of-range':
      case 'scene-not-allowed':
        return moderationInvalidRequest()
      case 'rate-limited':
        return moderationJson(429, { error: 'rate-limited' }, { 'Retry-After': '3600' })
    }
  }
}

export function createModerationQueueHandler(
  options: ModerationHandlerOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  return async (context) => {
    if (context.url.pathname !== MODERATION_QUEUE_PATH || context.url.search !== '') {
      return moderationInvalidRequest()
    }
    const verification = context.verification
    if (verification === undefined || !isEmptyWalletMetadata(verification.authMetadata)) {
      return moderationJson(401, { error: 'unauthorized' })
    }

    let actor: string
    try {
      actor = normalizeAddress(verification.auth)
    } catch {
      return moderationJson(401, { error: 'unauthorized' })
    }

    let result: ModerationQueueResult
    try {
      result = await options.moderationRepository.queue(actor)
    } catch (error) {
      reportUnexpected(options, error)
      return moderationJson(503, { error: 'service-unavailable' })
    }
    if (result.status === 'unauthorized') return moderationJson(403, { error: 'forbidden' })
    return moderationJson(200, { items: result.rows, queueDepth: result.queueDepth })
  }
}

export function createModerationDecisionHandler(
  options: ModerationHandlerOptions
): IHttpServerComponent.IRequestHandler<ApiAuthContext> {
  return async (context) => {
    if (context.url.pathname !== MODERATION_DECISIONS_PATH || context.url.search !== '') {
      return moderationInvalidRequest()
    }

    const verification = context.verification
    if (verification === undefined || !isDecisionWalletMetadata(verification.authMetadata)) {
      return moderationJson(401, { error: 'unauthorized' })
    }

    let actor: string
    try {
      actor = normalizeAddress(verification.auth)
    } catch {
      return moderationJson(401, { error: 'unauthorized' })
    }

    const body = await readSignedJsonBody(context.request, verification.authMetadata.hashPayload, options)
    if (body.kind !== 'json') return moderationBodyFailure(body)

    let decision: ModerationDecisionInput
    try {
      decision = parseModerationDecision(body.value)
    } catch {
      return moderationInvalidRequest()
    }

    let result: ModerationDecisionResult
    try {
      result = await options.moderationRepository.decide(decision, {
        actorAddress: actor,
        bucketHash: options.config.digestActor('decision-rate', actor),
        auditDigest: options.config.digestActor('moderation-audit', actor)
      })
    } catch (error) {
      reportUnexpected(options, error)
      return moderationJson(503, { error: 'service-unavailable' })
    }

    switch (result.status) {
      case 'applied':
      case 'replay':
        return moderationJson(202, { ok: true })
      case 'decision-id-conflict':
        return moderationJson(409, { error: 'decision-id-conflict' })
      case 'unauthorized':
        return moderationJson(403, { error: 'forbidden' })
      case 'subject-not-found':
        return moderationJson(404, { error: 'not-found' })
      case 'subject-unavailable':
        return moderationJson(409, { error: 'subject-unavailable' })
      case 'timestamp-out-of-range':
        return moderationInvalidRequest()
      case 'rate-limited':
        return moderationJson(429, { error: 'rate-limited' }, { 'Retry-After': '60' })
    }
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

type ModerationAuditExportRouteContext = IHttpServerComponent.PathAwareContext<
  ApiAuthContext,
  typeof MODERATION_AUDIT_ROUTE
>

export function createModerationAuditExportHandler(
  options: ModerationAuditExportHandlerOptions
): IHttpServerComponent.IRequestHandler<ModerationAuditExportRouteContext> {
  return async (context) => {
    const afterSequence: unknown = context.params.afterSequence
    if (
      typeof afterSequence !== 'string' ||
      context.url.pathname !== `/v1/moderation/audit/${afterSequence}` ||
      context.url.search !== ''
    ) {
      return moderationInvalidRequest()
    }

    let cursor: string
    try {
      cursor = parseModerationAuditCursor(afterSequence)
    } catch {
      return moderationInvalidRequest()
    }

    const verification = context.verification
    if (verification === undefined || !isEmptyWalletMetadata(verification.authMetadata)) {
      return moderationJson(401, { error: 'unauthorized' })
    }

    let actor: string
    try {
      actor = normalizeAddress(verification.auth)
    } catch {
      return moderationJson(401, { error: 'unauthorized' })
    }

    let result: ModerationAuditExportResult
    try {
      result = await options.moderationAuditExportRepository.exportAudit(
        actor,
        cursor,
        options.config.digestActor('moderation-audit-export-rate', actor)
      )
    } catch (error) {
      reportUnexpected(options, error)
      return moderationJson(503, { error: 'service-unavailable' })
    }

    switch (result.status) {
      case 'unauthorized':
        return moderationJson(403, { error: 'forbidden' })
      case 'rate-limited':
        return moderationJson(429, { error: 'rate-limited' }, { 'Retry-After': '3600' })
      case 'data':
        return moderationJson(200, {
          afterSequence: result.afterSequence,
          nextCursor: result.nextCursor,
          items: result.items
        })
    }
  }
}

export function createHttpRouter(options: HttpRouterOptions) {
  const router = new Router<ApiAuthContext>()
  let readiness: Readonly<{ ready: boolean; expiresAt: number }> | undefined
  let readinessProbe: Promise<boolean> | undefined
  router.get(SEASON_ZERO_CALENDAR_PATH, noStore, async (context) => {
    if (context.url.pathname !== SEASON_ZERO_CALENDAR_PATH || context.url.search !== '') {
      return invalidRequest()
    }
    return json(200, { ...seasonZeroCalendarSnapshot(Date.now()) })
  })
  router.get(LIVE_PATH, async () => json(200, { status: 'pass' }))
  router.get(READY_PATH, async () => {
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
    noStore,
    createWalletAuthMiddleware({ trustedCatalystUrl: options.config.trustedCatalystUrl }),
    createFunnelExportHandler(options)
  )
  router.post(
    MODERATION_SUBJECTS_PATH,
    noStore,
    createPublishAuthMiddleware({
      allowedSceneIds: options.config.allowedSceneIds,
      trustedCatalystUrl: options.config.trustedCatalystUrl
    }),
    createModerationPublishHandler(options)
  )
  router.post(
    MODERATION_REPORTS_PATH,
    noStore,
    createSceneAuthMiddleware({
      allowedSceneIds: options.config.allowedSceneIds,
      trustedCatalystUrl: options.config.trustedCatalystUrl
    }),
    createModerationReportHandler(options)
  )
  router.get(
    MODERATION_QUEUE_PATH,
    noStore,
    createQueueAuthMiddleware({ trustedCatalystUrl: options.config.trustedCatalystUrl }),
    createModerationQueueHandler(options)
  )
  router.post(
    MODERATION_DECISIONS_PATH,
    noStore,
    createDecisionAuthMiddleware({ trustedCatalystUrl: options.config.trustedCatalystUrl }),
    createModerationDecisionHandler(options)
  )
  router.get(
    MODERATION_AUDIT_ROUTE,
    noStore,
    createQueueAuthMiddleware({ trustedCatalystUrl: options.config.trustedCatalystUrl }),
    createModerationAuditExportHandler(options)
  )
  return router
}
