export const FUNNEL_EVENTS = ['wake', 'ready', 'decode', 'reveal', 'author', 'post', 'invite', 'mail'] as const

export type FunnelEvent = (typeof FUNNEL_EVENTS)[number]

export type FunnelAggregateRow = {
  day: string
  wake: number
  ready: number
  decode: number
  reveal: number
  author: number
  post: number
  invite: number
  mail: number
}

export type ClickAggregateRow = {
  day: string
  campaign: string
  source: string
  clicks: number
}

export type InviteLinkRecord = {
  token: string
  campaign: string
  source: string
  destinationUrl: string
  createdAt: number
}

export type AnalyticsRecordResult = 'recorded' | 'duplicate' | 'invalid' | 'expired' | 'future' | 'capacity'

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 31
const MAX_RETENTION_DAYS = 366
const DEFAULT_EVENT_ID_CAPACITY = 10_000
const MAX_EVENT_ID_CAPACITY = 100_000
const MAX_ATTRIBUTION_ID_LENGTH = 48
const MAX_TIMESTAMP = 8_640_000_000_000_000
const ATTRIBUTION_ID = /^[a-z0-9](?:[a-z0-9_-]{0,47})$/iu
const EVENT_ID = /^evt_[a-f0-9]{32}$/u
const INVITE_TOKEN = /^inv_[a-f0-9]{32}$/u
const ETHEREUM_ADDRESS = /^0x[a-f0-9]{40}$/iu
const WORLD_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu
const HTTPS_ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/?$/iu
const FUNNEL_EVENT_NAMES = new Set<string>(FUNNEL_EVENTS)
const EVENT_FIELDS = new Set(['eventId', 'event', 'occurredAt', 'campaign', 'source'])
const INVITE_LINK_FIELDS = new Set(['token', 'worldName', 'campaign', 'source', 'createdAt'])

type AcceptedFunnelEvent = {
  eventId: string
  event: FunnelEvent
  occurredAt: number
  kind: 'funnel'
}

type AcceptedClickEvent = {
  eventId: string
  event: 'click'
  occurredAt: number
  campaign: string
  source: string
  kind: 'click'
}

type AcceptedEvent = AcceptedFunnelEvent | AcceptedClickEvent

type StoredAggregate<Row> = {
  dayNumber: number
  row: Row
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP
}

function dayNumber(timestamp: number) {
  return Math.floor(timestamp / DAY_MILLISECONDS)
}

function dayKey(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function emptyFunnelRow(day: string): FunnelAggregateRow {
  return {
    day,
    wake: 0,
    ready: 0,
    decode: 0,
    reveal: 0,
    author: 0,
    post: 0,
    invite: 0,
    mail: 0
  }
}

function normalizeAttributionId(value: unknown) {
  if (!isAttributionId(value)) return null
  return value.toLowerCase()
}

function parseEvent(value: unknown): AcceptedEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => !EVENT_FIELDS.has(key)) ||
    typeof input.eventId !== 'string' ||
    !EVENT_ID.test(input.eventId) ||
    typeof input.event !== 'string' ||
    !isTimestamp(input.occurredAt)
  ) {
    return null
  }

  if (input.event === 'click') {
    const campaign = normalizeAttributionId(input.campaign)
    const source = normalizeAttributionId(input.source)
    if (campaign === null || source === null) return null
    return {
      eventId: input.eventId,
      event: 'click',
      occurredAt: input.occurredAt,
      campaign,
      source,
      kind: 'click'
    }
  }

  if (!FUNNEL_EVENT_NAMES.has(input.event) || input.campaign !== undefined || input.source !== undefined) return null
  return {
    eventId: input.eventId,
    event: input.event as FunnelEvent,
    occurredAt: input.occurredAt,
    kind: 'funnel'
  }
}

export function isAttributionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ATTRIBUTION_ID_LENGTH &&
    ATTRIBUTION_ID.test(value) &&
    !ETHEREUM_ADDRESS.test(value)
  )
}

export function isInviteToken(value: unknown): value is string {
  return typeof value === 'string' && INVITE_TOKEN.test(value)
}

export function createWorldInviteUrl(worldName: string) {
  if (!WORLD_NAME.test(worldName)) throw new TypeError('Invalid World name')
  return `https://decentraland.org/jump/?realm=${encodeURIComponent(worldName.toLowerCase())}`
}

export function createInviteLandingUrl(landingOrigin: string, token: string) {
  if (!isInviteToken(token)) throw new TypeError('Invalid invite token')
  if (!HTTPS_ORIGIN.test(landingOrigin)) throw new TypeError('Invalid landing origin')
  return `${landingOrigin.replace(/\/$/u, '')}/invite/${token}`
}

export function createInviteLinkRecord(value: unknown): InviteLinkRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid invite link record')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !INVITE_LINK_FIELDS.has(key))) {
    throw new TypeError('Invalid invite link record')
  }
  const campaign = normalizeAttributionId(input.campaign)
  const source = normalizeAttributionId(input.source)
  if (
    !isInviteToken(input.token) ||
    typeof input.worldName !== 'string' ||
    campaign === null ||
    source === null ||
    !isTimestamp(input.createdAt)
  ) {
    throw new TypeError('Invalid invite link record')
  }
  return {
    token: input.token,
    campaign,
    source,
    destinationUrl: createWorldInviteUrl(input.worldName),
    createdAt: input.createdAt
  }
}

export class FunnelAnalytics {
  private readonly retentionDays: number
  private readonly maxEventIds: number
  private readonly eventDays = new Map<string, number>()
  private readonly funnelAggregates = new Map<string, StoredAggregate<FunnelAggregateRow>>()
  private readonly clickAggregates = new Map<string, StoredAggregate<ClickAggregateRow>>()

  constructor(options: { retentionDays?: number; maxEventIds?: number } = {}) {
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS
    this.maxEventIds = options.maxEventIds ?? DEFAULT_EVENT_ID_CAPACITY
    if (
      !Number.isSafeInteger(this.retentionDays) ||
      this.retentionDays < 1 ||
      this.retentionDays > MAX_RETENTION_DAYS
    ) {
      throw new RangeError(`retentionDays must be between 1 and ${MAX_RETENTION_DAYS}`)
    }
    if (!Number.isSafeInteger(this.maxEventIds) || this.maxEventIds < 1 || this.maxEventIds > MAX_EVENT_ID_CAPACITY) {
      throw new RangeError(`maxEventIds must be between 1 and ${MAX_EVENT_ID_CAPACITY}`)
    }
  }

  record(input: unknown, now = Date.now()): AnalyticsRecordResult {
    if (!isTimestamp(now)) return 'invalid'
    this.prune(now)
    const event = parseEvent(input)
    if (!event) return 'invalid'
    if (event.occurredAt > now) return 'future'
    const retainedDay = dayNumber(event.occurredAt)
    if (retainedDay < this.minimumDay(now)) return 'expired'
    if (this.eventDays.has(event.eventId)) return 'duplicate'
    if (this.eventDays.size >= this.maxEventIds) return 'capacity'

    if (event.kind === 'funnel') {
      const key = dayKey(event.occurredAt)
      const aggregate = this.funnelAggregates.get(key) ?? {
        dayNumber: retainedDay,
        row: emptyFunnelRow(key)
      }
      aggregate.row[event.event] += 1
      this.funnelAggregates.set(key, aggregate)
    } else {
      const day = dayKey(event.occurredAt)
      const key = JSON.stringify([day, event.campaign, event.source])
      const aggregate = this.clickAggregates.get(key) ?? {
        dayNumber: retainedDay,
        row: { day, campaign: event.campaign, source: event.source, clicks: 0 }
      }
      aggregate.row.clicks += 1
      this.clickAggregates.set(key, aggregate)
    }
    this.eventDays.set(event.eventId, retainedDay)
    return 'recorded'
  }

  exportFunnelRows(now = Date.now()): FunnelAggregateRow[] {
    this.prepareExport(now)
    return [...this.funnelAggregates.values()]
      .map(({ row }) => ({ ...row }))
      .sort((left, right) => left.day.localeCompare(right.day))
  }

  exportClickRows(now = Date.now()): ClickAggregateRow[] {
    this.prepareExport(now)
    return [...this.clickAggregates.values()]
      .map(({ row }) => ({ ...row }))
      .sort(
        (left, right) =>
          left.day.localeCompare(right.day) ||
          left.campaign.localeCompare(right.campaign) ||
          left.source.localeCompare(right.source)
      )
  }

  private prepareExport(now: number) {
    if (!isTimestamp(now)) throw new RangeError('Invalid export timestamp')
    this.prune(now)
  }

  private minimumDay(now: number) {
    return dayNumber(now) - this.retentionDays + 1
  }

  private prune(now: number) {
    const minimumDay = this.minimumDay(now)
    for (const [storedEventId, retainedDay] of this.eventDays) {
      if (retainedDay < minimumDay) this.eventDays.delete(storedEventId)
    }
    for (const [key, aggregate] of this.funnelAggregates) {
      if (aggregate.dayNumber < minimumDay) this.funnelAggregates.delete(key)
    }
    for (const [key, aggregate] of this.clickAggregates) {
      if (aggregate.dayNumber < minimumDay) this.clickAggregates.delete(key)
    }
  }
}
