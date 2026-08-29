import { normalizePlayerName } from '../shared/i18n'

export type ContentSource = 'curated' | 'creator'
export type ReportReason = 'unsafe-name' | 'duplicate' | 'abuse' | 'copyright' | 'other'
export type AuditAction = 'published' | 'publish-rejected' | 'reported' | 'quarantined' | 'shadow-hidden' | 'tombstoned'

export type ModerationReport = Readonly<{
  id: string
  contentId: string
  reporterAddress: string
  reason: ReportReason
  createdAt: number
  status: 'open'
}>

export type AuditEntry = Readonly<{
  sequence: number
  action: AuditAction
  actorAddress: string
  subjectId: string
  createdAt: number
}>

export type ContentRecord = Readonly<{
  id: string
  authorAddress: string
  fingerprint: string
  channel: 'curated' | 'trusted'
  status: 'published' | 'quarantined' | 'tombstoned'
  touringConsent: boolean
  createdAt: number
  deletedAt?: number
}>

export type PublishInput = {
  id: string
  authorAddress: string
  content: string
  source: ContentSource
  touringConsent?: boolean
  createdAt: number
}

export type PublishResult =
  | { accepted: true; record: ContentRecord }
  | {
      accepted: false
      reason:
        | 'unauthorized'
        | 'untrusted-creator'
        | 'duplicate'
        | 'content-capacity'
        | 'fingerprint-capacity'
        | 'rate-limited'
        | 'rate-capacity'
      duplicateOf?: string
    }

export type RateLimitOptions = {
  limit: number
  windowMs: number
  maxAddresses: number
}

export type ModerationRegistryOptions = {
  now: () => number
  moderators: ReadonlySet<string>
  trustedCreators: ReadonlySet<string>
  auditCapacity: number
  contentCapacity: number
  fingerprintCapacity: number
  reportCapacity: number
  shadowHiddenCapacity: number
  publishRate: RateLimitOptions
  reportRate: RateLimitOptions
}

export const MAX_MODERATION_CONTENT_BYTES = 4_096
const MAX_MODERATION_ID_BYTES = 128
const MAX_MODERATION_ADDRESS_BYTES = 128
const MAX_TIMESTAMP = 8_640_000_000_000_000
const MAX_CAPACITY = 100_000
const MAX_RATE_LIMIT = 10_000
const MAX_RATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000
const DUPLICATE_SEPARATORS = /[^\p{L}\p{N}]+/gu
const PROFILE_FALLBACK = ''
const REPORT_REASONS = new Set<ReportReason>(['unsafe-name', 'duplicate', 'abuse', 'copyright', 'other'])
const PUBLISH_KEYS = new Set(['id', 'authorAddress', 'content', 'source', 'touringConsent', 'createdAt'])
const REPORT_KEYS = new Set(['id', 'contentId', 'reason', 'createdAt', 'status'])

export class ModerationAuthorizationError extends Error {
  constructor() {
    super('Moderator authority required')
    this.name = 'ModerationAuthorizationError'
  }
}

export class ModerationCapacityError extends Error {
  constructor(scope: string) {
    super(`Moderation ${scope} capacity exceeded`)
    this.name = 'ModerationCapacityError'
  }
}

function utf8Bytes(value: string) {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

function requireBoundedText(value: unknown, label: string, maxBytes: number) {
  if (typeof value !== 'string') throw new Error(`${label} is required`)
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${label} is required`)
  if (utf8Bytes(normalized) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`)
  return normalized
}

function requireTimestamp(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
    throw new Error('Invalid timestamp')
  }
  return value
}

function normalizeAddress(value: unknown) {
  return requireBoundedText(value, 'Address', MAX_MODERATION_ADDRESS_BYTES).toLowerCase()
}

function validateCapacity(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CAPACITY) {
    throw new RangeError(`${label} must be between 1 and ${MAX_CAPACITY}`)
  }
  return value
}

function normalizeIdentitySet(values: ReadonlySet<string>, label: string) {
  if (!(values instanceof Set)) throw new TypeError(`${label} must be a Set`)
  const normalized = new Set<string>()
  for (const value of values) normalized.add(normalizeAddress(value))
  return normalized
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function normalizeDuplicateText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(DUPLICATE_SEPARATORS, ' ').trim()
}

export function filterProfileName(value: string): string | null {
  return normalizePlayerName(value, PROFILE_FALLBACK) || null
}

function parsePublishInput(value: unknown): PublishInput {
  const input = asObject(value)
  if (!input) throw new Error('Invalid publish input')
  const keys = Object.keys(input)
  if (keys.length < 5 || keys.length > 6 || keys.some((key) => !PUBLISH_KEYS.has(key))) {
    throw new Error('Invalid publish input')
  }
  if (!keys.includes('id') || !keys.includes('authorAddress') || !keys.includes('content')) {
    throw new Error('Invalid publish input')
  }
  if (!keys.includes('source') || !keys.includes('createdAt')) throw new Error('Invalid publish input')
  if (input.source !== 'curated' && input.source !== 'creator') throw new Error('Invalid publish input')
  if (keys.includes('touringConsent') && typeof input.touringConsent !== 'boolean') {
    throw new Error('Invalid publish input')
  }
  return {
    id: requireBoundedText(input.id, 'Content id', MAX_MODERATION_ID_BYTES),
    authorAddress: normalizeAddress(input.authorAddress),
    content: requireBoundedText(input.content, 'Content', MAX_MODERATION_CONTENT_BYTES),
    source: input.source,
    touringConsent: input.touringConsent === true,
    createdAt: requireTimestamp(input.createdAt)
  }
}

export function createReport(principalAddress: string, value: unknown): ModerationReport {
  try {
    const reporterAddress = normalizeAddress(principalAddress)
    const input = asObject(value)
    if (!input) throw new Error()
    const keys = Object.keys(input)
    if (keys.length < 4 || keys.length > 5 || keys.some((key) => !REPORT_KEYS.has(key))) throw new Error()
    if (!keys.includes('id') || !keys.includes('contentId')) throw new Error()
    if (!keys.includes('reason') || !keys.includes('createdAt')) throw new Error()
    if (keys.includes('status') && input.status !== 'open') throw new Error()
    if (typeof input.reason !== 'string' || !REPORT_REASONS.has(input.reason as ReportReason)) throw new Error()
    return Object.freeze({
      id: requireBoundedText(input.id, 'Report id', MAX_MODERATION_ID_BYTES),
      contentId: requireBoundedText(input.contentId, 'Content id', MAX_MODERATION_ID_BYTES),
      reporterAddress,
      reason: input.reason as ReportReason,
      createdAt: requireTimestamp(input.createdAt),
      status: 'open' as const
    })
  } catch {
    throw new Error('Invalid moderation report')
  }
}

type AuditInput = Omit<AuditEntry, 'sequence'>

export class BoundedAuditLog {
  private readonly log: AuditEntry[] = []
  private nextSequence = 1

  constructor(private readonly capacity: number) {
    validateCapacity(capacity, 'auditCapacity')
  }

  private prepare(input: AuditInput): AuditEntry {
    return Object.freeze({
      sequence: this.nextSequence,
      action: input.action,
      actorAddress: normalizeAddress(input.actorAddress),
      subjectId: requireBoundedText(input.subjectId, 'Audit subject id', MAX_MODERATION_ID_BYTES),
      createdAt: requireTimestamp(input.createdAt)
    })
  }

  private commit(entry: AuditEntry) {
    if (entry.sequence !== this.nextSequence) throw new Error('Stale prepared audit entry')
    this.nextSequence += 1
    this.log.push(entry)
    if (this.log.length > this.capacity) this.log.shift()
    return entry
  }

  append(input: AuditInput) {
    return this.commit(this.prepare(input))
  }

  transaction<T>(input: AuditInput, mutate: () => T) {
    const entry = this.prepare(input)
    const result = mutate()
    this.commit(entry)
    return result
  }

  entries() {
    return [...this.log]
  }
}

type RateDecision =
  | { allowed: false; reason: 'rate-limited' | 'rate-capacity' }
  | { allowed: true; address: string; timestamps: number[]; expiredAddresses: string[] }

class AddressRateLimiter {
  private readonly events = new Map<string, number[]>()

  constructor(private readonly options: RateLimitOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_RATE_LIMIT) {
      throw new RangeError(`rate limit must be between 1 and ${MAX_RATE_LIMIT}`)
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1 || options.windowMs > MAX_RATE_WINDOW_MS) {
      throw new RangeError(`rate window must be between 1 and ${MAX_RATE_WINDOW_MS}`)
    }
    validateCapacity(options.maxAddresses, 'rate maxAddresses')
  }

  evaluate(address: string, now: number): RateDecision {
    const cutoff = now - this.options.windowMs
    const current = this.events.get(address) ?? []
    const last = current[current.length - 1]
    if (last !== undefined && now < last) throw new Error('Invalid timestamp')
    const active = current.filter((timestamp) => timestamp > cutoff)
    if (active.length >= this.options.limit) return { allowed: false, reason: 'rate-limited' }

    const expiredAddresses: string[] = []
    if (!this.events.has(address)) {
      for (const [candidate, timestamps] of this.events) {
        if (timestamps[timestamps.length - 1] <= cutoff) expiredAddresses.push(candidate)
      }
      if (this.events.size - expiredAddresses.length >= this.options.maxAddresses) {
        return { allowed: false, reason: 'rate-capacity' }
      }
    }
    return { allowed: true, address, timestamps: [...active, now], expiredAddresses }
  }

  commit(decision: Extract<RateDecision, { allowed: true }>) {
    for (const address of decision.expiredAddresses) this.events.delete(address)
    this.events.set(decision.address, decision.timestamps)
  }
}

export class ModerationRegistry {
  private readonly content = new Map<string, ContentRecord>()
  private readonly fingerprintIndex = new Map<string, string>()
  private readonly reportRecords = new Map<string, ModerationReport>()
  private readonly shadowHiddenAddresses = new Set<string>()
  private readonly moderators: ReadonlySet<string>
  private readonly trustedCreators: ReadonlySet<string>
  private readonly audit: BoundedAuditLog
  private readonly publishRate: AddressRateLimiter
  private readonly reportRate: AddressRateLimiter
  private readonly contentCapacity: number
  private readonly fingerprintCapacity: number
  private readonly reportCapacity: number
  private readonly shadowHiddenCapacity: number
  private readonly now: () => number

  constructor(options: ModerationRegistryOptions) {
    if (typeof options.now !== 'function') throw new TypeError('now must be a function')
    this.now = options.now
    this.moderators = normalizeIdentitySet(options.moderators, 'moderators')
    this.trustedCreators = normalizeIdentitySet(options.trustedCreators, 'trustedCreators')
    this.contentCapacity = validateCapacity(options.contentCapacity, 'contentCapacity')
    this.fingerprintCapacity = validateCapacity(options.fingerprintCapacity, 'fingerprintCapacity')
    this.reportCapacity = validateCapacity(options.reportCapacity, 'reportCapacity')
    this.shadowHiddenCapacity = validateCapacity(options.shadowHiddenCapacity, 'shadowHiddenCapacity')
    this.audit = new BoundedAuditLog(options.auditCapacity)
    this.publishRate = new AddressRateLimiter(options.publishRate)
    this.reportRate = new AddressRateLimiter(options.reportRate)
  }

  publish(principalAddress: string, value: PublishInput): PublishResult {
    const principal = normalizeAddress(principalAddress)
    const rate = this.publishRate.evaluate(principal, requireTimestamp(this.now()))
    if (!rate.allowed) return { accepted: false, reason: rate.reason }
    this.publishRate.commit(rate)

    const input = parsePublishInput(value)
    const { id, authorAddress, content, createdAt } = input
    if (this.content.has(id)) throw new Error(`Content already exists: ${id}`)

    const authorized =
      input.source === 'curated'
        ? this.moderators.has(principal)
        : principal === authorAddress && this.trustedCreators.has(principal)
    if (!authorized) {
      const reason = input.source === 'creator' && principal === authorAddress ? 'untrusted-creator' : 'unauthorized'
      this.audit.append({ action: 'publish-rejected', actorAddress: principal, subjectId: id, createdAt })
      return { accepted: false, reason }
    }

    const fingerprint = normalizeDuplicateText(content)
    if (fingerprint === '') throw new Error('Content must contain letters or numbers')
    const duplicateOf = this.fingerprintIndex.get(fingerprint)
    if (duplicateOf) {
      this.audit.append({ action: 'publish-rejected', actorAddress: principal, subjectId: id, createdAt })
      return { accepted: false, reason: 'duplicate', duplicateOf }
    }
    if (this.content.size >= this.contentCapacity) {
      this.audit.append({ action: 'publish-rejected', actorAddress: principal, subjectId: id, createdAt })
      return { accepted: false, reason: 'content-capacity' }
    }
    if (this.fingerprintIndex.size >= this.fingerprintCapacity) {
      this.audit.append({ action: 'publish-rejected', actorAddress: principal, subjectId: id, createdAt })
      return { accepted: false, reason: 'fingerprint-capacity' }
    }

    const record: ContentRecord = Object.freeze({
      id,
      authorAddress,
      fingerprint,
      channel: input.source === 'curated' ? 'curated' : 'trusted',
      status: 'published',
      touringConsent: input.touringConsent === true,
      createdAt
    })
    this.audit.transaction({ action: 'published', actorAddress: principal, subjectId: id, createdAt }, () => {
      this.content.set(id, record)
      this.fingerprintIndex.set(fingerprint, id)
    })
    return { accepted: true, record }
  }

  get(contentId: string) {
    return this.content.get(contentId) ?? null
  }

  report(principalAddress: string, input: unknown): 'reported' | 'duplicate' | 'rate-limited' | 'capacity' {
    const report = createReport(principalAddress, input)
    if (!this.content.has(report.contentId)) throw new Error(`Unknown content: ${report.contentId}`)
    if (this.reportRecords.has(report.id)) return 'duplicate'
    if (this.reportRecords.size >= this.reportCapacity) return 'capacity'
    const rate = this.reportRate.evaluate(report.reporterAddress, requireTimestamp(this.now()))
    if (!rate.allowed) return rate.reason === 'rate-limited' ? 'rate-limited' : 'capacity'
    this.audit.transaction(
      {
        action: 'reported',
        actorAddress: report.reporterAddress,
        subjectId: report.contentId,
        createdAt: report.createdAt
      },
      () => {
        this.reportRate.commit(rate)
        this.reportRecords.set(report.id, report)
      }
    )
    return 'reported'
  }

  reports() {
    return [...this.reportRecords.values()]
  }

  quarantine(principalAddress: string, contentId: string, createdAt: number) {
    const action = this.prepareModerationAction('quarantined', contentId, principalAddress, createdAt)
    const record = this.requireContent(action.subjectId)
    if (record.status === 'tombstoned') throw new Error(`Content is tombstoned: ${action.subjectId}`)
    if (record.status === 'quarantined') return record
    const quarantined: ContentRecord = Object.freeze({ ...record, status: 'quarantined' })
    this.audit.transaction(action, () => this.content.set(record.id, quarantined))
    return quarantined
  }

  shadowHide(principalAddress: string, authorAddress: string, createdAt: number) {
    const hiddenAddress = normalizeAddress(authorAddress)
    const action = this.prepareModerationAction('shadow-hidden', hiddenAddress, principalAddress, createdAt)
    if (this.shadowHiddenAddresses.has(hiddenAddress)) return
    if (this.shadowHiddenAddresses.size >= this.shadowHiddenCapacity) throw new ModerationCapacityError('shadow-hidden')
    this.audit.transaction(action, () => this.shadowHiddenAddresses.add(hiddenAddress))
  }

  tombstone(principalAddress: string, contentId: string, createdAt: number) {
    const action = this.prepareModerationAction('tombstoned', contentId, principalAddress, createdAt)
    const record = this.requireContent(action.subjectId)
    if (record.status === 'tombstoned') return record
    const tombstoned: ContentRecord = Object.freeze({ ...record, status: 'tombstoned', deletedAt: action.createdAt })
    this.audit.transaction(action, () => {
      this.content.set(record.id, tombstoned)
      this.fingerprintIndex.delete(record.fingerprint)
    })
    return tombstoned
  }

  isVisible(contentId: string, viewerAddress: string) {
    const record = this.content.get(contentId)
    if (!record || record.status !== 'published') return false
    if (!this.shadowHiddenAddresses.has(record.authorAddress)) return true
    return normalizeAddress(viewerAddress) === record.authorAddress
  }

  canTour(contentId: string) {
    const record = this.content.get(contentId)
    return (
      record?.status === 'published' && record.touringConsent && !this.shadowHiddenAddresses.has(record.authorAddress)
    )
  }

  auditEntries() {
    return this.audit.entries()
  }

  private prepareModerationAction(
    action: Extract<AuditAction, 'quarantined' | 'shadow-hidden' | 'tombstoned'>,
    subjectId: string,
    actorAddress: string,
    createdAt: number
  ): AuditInput {
    const normalizedActor = normalizeAddress(actorAddress)
    const normalizedSubject = requireBoundedText(subjectId, 'Audit subject id', MAX_MODERATION_ID_BYTES)
    const timestamp = requireTimestamp(createdAt)
    if (!this.moderators.has(normalizedActor)) throw new ModerationAuthorizationError()
    return { action, actorAddress: normalizedActor, subjectId: normalizedSubject, createdAt: timestamp }
  }

  private requireContent(contentId: string) {
    const record = this.content.get(contentId)
    if (!record) throw new Error(`Unknown content: ${contentId}`)
    return record
  }
}
