import type { ModerationAction, ReportReason } from './contracts.js'
import type { DatabaseClient, DatabaseConnectionSource, DatabaseRow } from './database.js'

export type ModerationAuditPublishedItem = Readonly<{
  sequence: string
  action: 'published'
  moderatorAddress: null
  subjectId: string
  createdAt: number
  details: Readonly<{ clientCreatedAt: number }>
}>

export type ModerationAuditPublishRejectedItem = Readonly<{
  sequence: string
  action: 'publish-rejected'
  moderatorAddress: null
  subjectId: null
  createdAt: number
  details:
    | Readonly<{
        clientCreatedAt: number
        reason: 'id-conflict'
        requestedSubjectId: string
      }>
    | Readonly<{
        clientCreatedAt: number
        reason: 'duplicate'
        requestedSubjectId: string
        duplicateOf: string
      }>
}>

export type ModerationAuditReportedItem = Readonly<{
  sequence: string
  action: 'reported'
  moderatorAddress: null
  subjectId: string
  createdAt: number
  details: Readonly<{
    clientCreatedAt: number
    reason: ReportReason
    reportId: string
    reportingSceneId: string
  }>
}>

export type ModerationAuditDecisionItem = Readonly<{
  sequence: string
  action: ModerationAction
  moderatorAddress: string
  subjectId: string
  createdAt: number
  details: Readonly<{
    clientCreatedAt: number
    decisionId: string
    reason: string
  }>
}>

export type ModerationAuditExportItem =
  | ModerationAuditPublishedItem
  | ModerationAuditPublishRejectedItem
  | ModerationAuditReportedItem
  | ModerationAuditDecisionItem

export type ModerationAuditExportResult =
  | Readonly<{ status: 'unauthorized' }>
  | Readonly<{ status: 'rate-limited' }>
  | Readonly<{
      status: 'data'
      afterSequence: string
      nextCursor: string | null
      items: readonly ModerationAuditExportItem[]
    }>

export type ModerationAuditExportRepositoryOptions = Readonly<{
  auditExportPerHour: number
}>

const MAX_TIMESTAMP = 8_640_000_000_000_000
const MAX_RATE = 100_000
const MAX_ID_BYTES = 128
const MAX_REASON_BYTES = 1_024
const MAX_SCENE_ID_BYTES = 128
const PAGE_SIZE = 50
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n
const CANONICAL_BIGINT_PATTERN = /^(?:0|[1-9]\d*)$/u
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u
const REPORT_REASONS = new Set<ReportReason>(['unsafe-name', 'duplicate', 'abuse', 'copyright', 'other'])
const MODERATION_ACTIONS = new Set<ModerationAction>(['quarantined', 'shadow-hidden', 'tombstoned'])

const UNAUTHORIZED_RESULT: ModerationAuditExportResult = Object.freeze({ status: 'unauthorized' })
const RATE_LIMITED_RESULT: ModerationAuditExportResult = Object.freeze({ status: 'rate-limited' })

const ROLE_SQL = `SELECT 1
FROM actor_roles
WHERE actor_address = $1
  AND role = 'moderator'
  AND revoked_at IS NULL
FOR SHARE`

const RATE_SQL = `WITH rate_window AS (
  SELECT date_trunc('hour', $3::timestamptz) AS window_start
)
INSERT INTO rate_buckets AS buckets (
  scope,
  bucket_hash,
  window_start,
  request_count,
  expires_at
)
SELECT
  'moderation-audit-export',
  $1,
  rate_window.window_start,
  1,
  rate_window.window_start + INTERVAL '1 hour'
FROM rate_window
ON CONFLICT (scope, bucket_hash, window_start)
DO UPDATE SET
  request_count = buckets.request_count + 1,
  expires_at = EXCLUDED.expires_at
WHERE buckets.request_count < $2
RETURNING request_count`

const AUDIT_SQL = `SELECT
  sequence::text AS sequence,
  action,
  actor_address AS "moderatorAddress",
  subject_id AS "subjectId",
  created_at AS "createdAt",
  details
FROM moderation_audit
WHERE sequence > $1::bigint
ORDER BY sequence ASC
LIMIT 51`

function requireBoundedInteger(value: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`)
  }
}

function requireNow(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
    throw new RangeError('Invalid current timestamp')
  }
}

function requireCanonicalAddress(value: unknown) {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    throw new Error('Invalid moderation audit export row')
  }
  return value
}

function requireBoundedText(value: unknown, maximumBytes: number) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\0') ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new Error('Invalid moderation audit export row')
  }
  return value
}

function requireTimestamp(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
    throw new Error('Invalid moderation audit export row')
  }
  return value
}

function requireDate(value: unknown) {
  if (!(value instanceof Date)) throw new Error('Invalid moderation audit export row')
  return requireTimestamp(value.getTime())
}

function exactObject(value: unknown, keys: readonly string[]) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid moderation audit export row')
  }
  const object = value as Record<string, unknown>
  const actualKeys = Object.keys(object)
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) {
    throw new Error('Invalid moderation audit export row')
  }
  return object
}

export function parseModerationAuditCursor(value: unknown) {
  if (typeof value !== 'string' || value.length > 19 || !CANONICAL_BIGINT_PATTERN.test(value)) {
    throw new RangeError('Invalid moderation audit cursor')
  }
  const cursor = BigInt(value)
  if (cursor > MAX_POSTGRES_BIGINT) throw new RangeError('Invalid moderation audit cursor')
  return value
}

function parseSequence(value: unknown, previousSequence: bigint) {
  let sequence: string
  try {
    sequence = parseModerationAuditCursor(value)
  } catch {
    throw new Error('Invalid moderation audit export row')
  }
  if (BigInt(sequence) <= previousSequence) throw new Error('Invalid moderation audit export row')
  return sequence
}

function requireNull(value: unknown) {
  if (value !== null) throw new Error('Invalid moderation audit export row')
  return null
}

function publishedItem(sequence: string, row: DatabaseRow, createdAt: number): ModerationAuditPublishedItem {
  requireNull(row.moderatorAddress)
  const subjectId = requireBoundedText(row.subjectId, MAX_ID_BYTES)
  const details = exactObject(row.details, ['clientCreatedAt'])
  return Object.freeze({
    sequence,
    action: 'published',
    moderatorAddress: null,
    subjectId,
    createdAt,
    details: Object.freeze({ clientCreatedAt: requireTimestamp(details.clientCreatedAt) })
  })
}

function publishRejectedItem(
  sequence: string,
  row: DatabaseRow,
  createdAt: number
): ModerationAuditPublishRejectedItem {
  requireNull(row.moderatorAddress)
  requireNull(row.subjectId)
  if (typeof row.details !== 'object' || row.details === null || Array.isArray(row.details)) {
    throw new Error('Invalid moderation audit export row')
  }
  const rawDetails = row.details as Record<string, unknown>
  const reason = rawDetails.reason

  if (reason === 'id-conflict') {
    const details = exactObject(rawDetails, ['clientCreatedAt', 'reason', 'requestedSubjectId'])
    return Object.freeze({
      sequence,
      action: 'publish-rejected',
      moderatorAddress: null,
      subjectId: null,
      createdAt,
      details: Object.freeze({
        clientCreatedAt: requireTimestamp(details.clientCreatedAt),
        reason: 'id-conflict',
        requestedSubjectId: requireBoundedText(details.requestedSubjectId, MAX_ID_BYTES)
      })
    })
  }

  if (reason !== 'duplicate-content') throw new Error('Invalid moderation audit export row')
  const details = exactObject(rawDetails, ['clientCreatedAt', 'duplicateOf', 'reason', 'requestedSubjectId'])
  return Object.freeze({
    sequence,
    action: 'publish-rejected',
    moderatorAddress: null,
    subjectId: null,
    createdAt,
    details: Object.freeze({
      clientCreatedAt: requireTimestamp(details.clientCreatedAt),
      reason: 'duplicate',
      requestedSubjectId: requireBoundedText(details.requestedSubjectId, MAX_ID_BYTES),
      duplicateOf: requireBoundedText(details.duplicateOf, MAX_ID_BYTES)
    })
  })
}

function reportedItem(sequence: string, row: DatabaseRow, createdAt: number): ModerationAuditReportedItem {
  requireNull(row.moderatorAddress)
  const subjectId = requireBoundedText(row.subjectId, MAX_ID_BYTES)
  const details = exactObject(row.details, ['clientCreatedAt', 'reason', 'reportId', 'reportingSceneId'])
  const reason = details.reason
  if (typeof reason !== 'string' || !REPORT_REASONS.has(reason as ReportReason)) {
    throw new Error('Invalid moderation audit export row')
  }
  return Object.freeze({
    sequence,
    action: 'reported',
    moderatorAddress: null,
    subjectId,
    createdAt,
    details: Object.freeze({
      clientCreatedAt: requireTimestamp(details.clientCreatedAt),
      reason: reason as ReportReason,
      reportId: requireBoundedText(details.reportId, MAX_ID_BYTES),
      reportingSceneId: requireBoundedText(details.reportingSceneId, MAX_SCENE_ID_BYTES)
    })
  })
}

function decisionItem(
  sequence: string,
  action: ModerationAction,
  row: DatabaseRow,
  createdAt: number
): ModerationAuditDecisionItem {
  const details = exactObject(row.details, ['clientCreatedAt', 'decisionId', 'reason'])
  return Object.freeze({
    sequence,
    action,
    moderatorAddress: requireCanonicalAddress(row.moderatorAddress),
    subjectId: requireBoundedText(row.subjectId, MAX_ID_BYTES),
    createdAt,
    details: Object.freeze({
      clientCreatedAt: requireTimestamp(details.clientCreatedAt),
      decisionId: requireBoundedText(details.decisionId, MAX_ID_BYTES),
      reason: requireBoundedText(details.reason, MAX_REASON_BYTES)
    })
  })
}

function sanitizeRow(row: DatabaseRow, previousSequence: bigint): ModerationAuditExportItem {
  const sequence = parseSequence(row.sequence, previousSequence)
  const createdAt = requireDate(row.createdAt)
  const action = row.action
  if (action === 'published') return publishedItem(sequence, row, createdAt)
  if (action === 'publish-rejected') return publishRejectedItem(sequence, row, createdAt)
  if (action === 'reported') return reportedItem(sequence, row, createdAt)
  if (typeof action === 'string' && MODERATION_ACTIONS.has(action as ModerationAction)) {
    return decisionItem(sequence, action as ModerationAction, row, createdAt)
  }
  throw new Error('Invalid moderation audit export row')
}

async function finishTransaction(client: DatabaseClient, command: 'COMMIT' | 'ROLLBACK') {
  await client.query(command)
}

export class ModerationAuditExportRepository {
  private readonly auditExportPerHour: number

  constructor(
    private readonly database: DatabaseConnectionSource,
    options: ModerationAuditExportRepositoryOptions
  ) {
    requireBoundedInteger(options.auditExportPerHour, MAX_RATE, 'auditExportPerHour')
    this.auditExportPerHour = options.auditExportPerHour
  }

  async exportAudit(
    actorAddress: string,
    afterSequence: string,
    bucketHash: Buffer,
    now = Date.now()
  ): Promise<ModerationAuditExportResult> {
    if (!ADDRESS_PATTERN.test(actorAddress)) throw new Error('Invalid moderation audit export actor address')
    const canonicalCursor = parseModerationAuditCursor(afterSequence)
    if (!Buffer.isBuffer(bucketHash) || bucketHash.length !== 32) {
      throw new Error('Moderation audit export bucket hash must be 32 bytes')
    }
    requireNow(now)

    const immutableBucketHash = Buffer.from(bucketHash)
    const receivedAt = new Date(now)
    const client = await this.database.connect()
    let transactionOpen = false
    let releaseError: Error | undefined

    try {
      await client.query('BEGIN')
      transactionOpen = true

      const role = await client.query(ROLE_SQL, [actorAddress])
      if (role.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return UNAUTHORIZED_RESULT
      }

      const rate = await client.query(RATE_SQL, [immutableBucketHash, this.auditExportPerHour, receivedAt])
      if (rate.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return RATE_LIMITED_RESULT
      }

      const audit = await client.query(AUDIT_SQL, [canonicalCursor])
      if (audit.rows.length > PAGE_SIZE + 1) throw new Error('Invalid moderation audit export row count')

      let previousSequence = BigInt(canonicalCursor)
      const sanitizedRows = audit.rows.map((row) => {
        const item = sanitizeRow(row, previousSequence)
        previousSequence = BigInt(item.sequence)
        return item
      })
      const hasNextPage = sanitizedRows.length > PAGE_SIZE
      const items = Object.freeze(sanitizedRows.slice(0, PAGE_SIZE))
      const nextCursor = hasNextPage ? (items.at(-1)?.sequence ?? null) : null

      await finishTransaction(client, 'COMMIT')
      transactionOpen = false
      return Object.freeze({
        status: 'data',
        afterSequence: canonicalCursor,
        nextCursor,
        items
      })
    } catch (error) {
      if (!transactionOpen) throw error
      try {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error('Moderation audit export rollback failed')
        throw new AggregateError([error, rollbackError], 'Moderation audit export and rollback failed')
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }
}
