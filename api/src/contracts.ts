export const FUNNEL_EVENTS = ['wake', 'ready', 'decode', 'reveal', 'author', 'post', 'invite', 'mail'] as const

export type FunnelEvent = (typeof FUNNEL_EVENTS)[number]
export type ReportReason = 'unsafe-name' | 'duplicate' | 'abuse' | 'copyright' | 'other'
export type ModerationAction = 'quarantined' | 'shadow-hidden' | 'tombstoned'

export type AnalyticsEvent =
  | Readonly<{ eventId: string; event: FunnelEvent; occurredAt: number; kind: 'funnel' }>
  | Readonly<{
      eventId: string
      event: 'click'
      occurredAt: number
      campaign: string
      source: string
      kind: 'click'
    }>

export type PublishSubject = Readonly<{
  id: string
  content: string
  channel: 'untrusted'
  touringConsent: boolean
  createdAt: number
}>

export type ModerationReportInput = Readonly<{
  id: string
  contentId: string
  reason: ReportReason
  createdAt: number
  status: 'open'
}>

export type ModerationDecisionInput = Readonly<{
  id: string
  subjectId: string
  action: ModerationAction
  reason: string
  createdAt: number
}>

const MAX_TIMESTAMP = 8_640_000_000_000_000
const MAX_ID_BYTES = 128
const MAX_CONTENT_BYTES = 4_096
const MAX_DECISION_REASON_BYTES = 1_024
const EVENT_ID = /^evt_[a-f0-9]{32}$/u
const ATTRIBUTION_ID = /^[a-z0-9](?:[a-z0-9_-]{0,47})$/iu
const ETHEREUM_ADDRESS = /^0x[a-f0-9]{40}$/iu
const ADDRESS = /^0x[a-f0-9]{40}$/iu
const FUNNEL_EVENT_NAMES = new Set<string>(FUNNEL_EVENTS)
const REPORT_REASONS = new Set<string>(['unsafe-name', 'duplicate', 'abuse', 'copyright', 'other'])
const MODERATION_ACTIONS = new Set<string>(['quarantined', 'shadow-hidden', 'tombstoned'])
const ANALYTICS_KEYS = new Set(['eventId', 'event', 'occurredAt', 'campaign', 'source'])
const SUBJECT_KEYS = new Set(['id', 'content', 'touringConsent', 'createdAt'])
const REPORT_KEYS = new Set(['id', 'contentId', 'reason', 'createdAt', 'status'])
const DECISION_KEYS = new Set(['id', 'subjectId', 'action', 'reason', 'createdAt'])

function asObject(value: unknown, keys: ReadonlySet<string>) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !keys.has(key))) return null
  return input
}

function requireTimestamp(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
    throw new Error('Invalid timestamp')
  }
  return value
}

function requireText(value: unknown, label: string, maxBytes: number) {
  if (typeof value !== 'string') throw new Error(`${label} is required`)
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${label} is required`)
  if (normalized.includes('\0')) throw new Error(`${label} contains invalid characters`)
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`)
  }
  return normalized
}

function normalizeAttribution(value: unknown) {
  if (typeof value !== 'string' || !ATTRIBUTION_ID.test(value) || ETHEREUM_ADDRESS.test(value)) return null
  return value.toLowerCase()
}

export function normalizeAddress(value: unknown) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 42 || !ADDRESS.test(value)) {
    throw new Error('Invalid address')
  }
  return value.toLowerCase()
}

export function parseAnalyticsEvent(value: unknown): AnalyticsEvent {
  const input = asObject(value, ANALYTICS_KEYS)
  try {
    if (!input || typeof input.eventId !== 'string' || !EVENT_ID.test(input.eventId)) throw new Error()
    const occurredAt = requireTimestamp(input.occurredAt)
    if (input.event === 'click') {
      const campaign = normalizeAttribution(input.campaign)
      const source = normalizeAttribution(input.source)
      if (campaign === null || source === null) throw new Error()
      return Object.freeze({ eventId: input.eventId, event: 'click', occurredAt, campaign, source, kind: 'click' })
    }
    if (
      typeof input.event !== 'string' ||
      !FUNNEL_EVENT_NAMES.has(input.event) ||
      input.campaign !== undefined ||
      input.source !== undefined
    ) {
      throw new Error()
    }
    return Object.freeze({
      eventId: input.eventId,
      event: input.event as FunnelEvent,
      occurredAt,
      kind: 'funnel'
    })
  } catch {
    throw new Error('Invalid analytics event')
  }
}

export function parsePublishSubject(value: unknown): PublishSubject {
  const input = asObject(value, SUBJECT_KEYS)
  try {
    if (!input) throw new Error()
    if (input.touringConsent !== undefined && typeof input.touringConsent !== 'boolean') throw new Error()
    return Object.freeze({
      id: requireText(input.id, 'Subject id', MAX_ID_BYTES),
      content: requireText(input.content, 'Content', MAX_CONTENT_BYTES),
      channel: 'untrusted',
      touringConsent: input.touringConsent === true,
      createdAt: requireTimestamp(input.createdAt)
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('UTF-8 bytes')) throw error
    throw new Error('Invalid publish subject')
  }
}

export function parseModerationReport(value: unknown): ModerationReportInput {
  const input = asObject(value, REPORT_KEYS)
  try {
    if (!input || typeof input.reason !== 'string' || !REPORT_REASONS.has(input.reason)) throw new Error()
    if (input.status !== undefined && input.status !== 'open') throw new Error()
    return Object.freeze({
      id: requireText(input.id, 'Report id', MAX_ID_BYTES),
      contentId: requireText(input.contentId, 'Content id', MAX_ID_BYTES),
      reason: input.reason as ReportReason,
      createdAt: requireTimestamp(input.createdAt),
      status: 'open'
    })
  } catch {
    throw new Error('Invalid moderation report')
  }
}

export function parseModerationDecision(value: unknown): ModerationDecisionInput {
  const input = asObject(value, DECISION_KEYS)
  try {
    if (!input || typeof input.action !== 'string' || !MODERATION_ACTIONS.has(input.action)) throw new Error()
    return Object.freeze({
      id: requireText(input.id, 'Decision id', MAX_ID_BYTES),
      subjectId: requireText(input.subjectId, 'Subject id', MAX_ID_BYTES),
      action: input.action as ModerationAction,
      reason: requireText(input.reason, 'Decision reason', MAX_DECISION_REASON_BYTES),
      createdAt: requireTimestamp(input.createdAt)
    })
  } catch {
    throw new Error('Invalid moderation decision')
  }
}
