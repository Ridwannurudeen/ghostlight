import { createHash } from 'node:crypto'
import type {
  ModerationAction,
  ModerationDecisionInput,
  ModerationReportInput,
  PublishSubject,
  ReportReason
} from './contracts.js'
import type { DatabaseClient, DatabaseConnectionSource, DatabaseRow } from './database.js'

export type ModerationPublishIdentity = Readonly<{
  actorAddress: string
  bucketHash: Buffer
  auditDigest: Buffer
}>

export type ModerationReportIdentity = Readonly<{
  scope: 'report-wallet' | 'report-guest'
  bucketHash: Buffer
  reporterDigest: Buffer
  auditDigest: Buffer
}>

export type ModerationDecisionIdentity = Readonly<{
  actorAddress: string
  bucketHash: Buffer
  auditDigest: Buffer
}>

export type ModerationSubjectRow = Readonly<{
  id: string
  sceneId: string
  authorAddress: string
  content: string
  channel: 'untrusted' | 'curated' | 'trusted'
  status: 'published' | 'quarantined' | 'tombstoned'
  touringConsent: boolean
  createdAt: number
  deletedAt: number | null
}>

export type ModerationPublishResult =
  | Readonly<{ status: 'published' | 'replay'; subject: ModerationSubjectRow }>
  | Readonly<{ status: 'duplicate-content'; duplicateOf: string }>
  | Readonly<{
      status: 'id-conflict' | 'invalid-content' | 'timestamp-out-of-range' | 'rate-limited' | 'scene-not-allowed'
    }>

export type ModerationReportResult =
  | Readonly<{ status: 'reported' | 'replay' }>
  | Readonly<{ status: 'duplicate-report'; reportId: string }>
  | Readonly<{
      status:
        | 'report-id-conflict'
        | 'subject-not-found'
        | 'subject-unavailable'
        | 'timestamp-out-of-range'
        | 'rate-limited'
        | 'scene-not-allowed'
    }>

export type ModerationQueueRow = Readonly<{
  reportId: string
  subjectId: string
  sceneId: string
  authorAddress: string
  content: string
  channel: 'untrusted' | 'curated' | 'trusted'
  touringConsent: boolean
  subjectStatus: 'published' | 'quarantined' | 'tombstoned'
  reason: ReportReason
  reportedAt: number
}>

export type ModerationQueueResult =
  | Readonly<{ status: 'unauthorized' }>
  | Readonly<{ status: 'data'; rows: readonly ModerationQueueRow[] }>

export type ModerationEligibilityResult =
  | Readonly<{ status: 'eligible'; subject: ModerationSubjectRow }>
  | Readonly<{ status: 'unavailable' }>

export type ModerationDecisionResult =
  | Readonly<{
      status: 'applied'
      action: ModerationAction
      subjectStatus: ModerationSubjectRow['status']
      resolvedReports: number
    }>
  | Readonly<{
      status:
        | 'replay'
        | 'decision-id-conflict'
        | 'unauthorized'
        | 'subject-not-found'
        | 'subject-unavailable'
        | 'timestamp-out-of-range'
        | 'rate-limited'
    }>

export type ModerationRepositoryOptions = Readonly<{
  allowedSceneIds: readonly string[]
  trustedCatalystUrl: string
  publishPerHour: number
  reportWalletPerHour: number
  reportGuestPerHour: number
  decisionPerMinute: number
}>

const MAX_TIMESTAMP = 8_640_000_000_000_000
const MAX_RATE = 100_000
const MAX_ID_BYTES = 128
const MAX_CONTENT_BYTES = 4_096
const MAX_REASON_BYTES = 1_024
const MAX_SCENE_ID_BYTES = 128
const MAX_CATALYST_ORIGIN_BYTES = 2_048
const MAX_CLIENT_PAST_SKEW_MILLISECONDS = 5 * 60 * 1_000
const MAX_CLIENT_FUTURE_SKEW_MILLISECONDS = 60 * 1_000
const MODERATION_QUEUE_LIMIT = 50
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u
const DUPLICATE_SEPARATORS = /[^\p{L}\p{N}]+/gu
const SUBJECT_CHANNELS = new Set(['untrusted', 'curated', 'trusted'])
const SUBJECT_STATUSES = new Set(['published', 'quarantined', 'tombstoned'])
const REPORT_REASONS = new Set(['unsafe-name', 'duplicate', 'abuse', 'copyright', 'other'])
const MODERATION_ACTIONS = new Set(['quarantined', 'shadow-hidden', 'tombstoned'])

const SCENE_LOCK_SQL = `SELECT 1
FROM scene_allowlist
WHERE scene_id = $1
  AND catalyst_origin = $2
FOR KEY SHARE`

const MODERATOR_LOCK_SQL = `SELECT 1
FROM actor_roles
WHERE actor_address = $1
  AND role = 'moderator'
  AND revoked_at IS NULL
FOR SHARE`

const AUTHOR_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('ghostlight:shadow:' || $1, 0))`

const AUDIT_SEQUENCE_LOCK_SQL = `SELECT pg_advisory_xact_lock($1, $2)`
const AUDIT_SEQUENCE_LOCK_VALUES = [1_195_912_019, 2] as const

const ACTIVE_HIDE_SQL = `SELECT 1
FROM shadow_hides
WHERE author_address = $1
  AND lifted_at IS NULL
FOR UPDATE`

const RESOLVE_AUTHOR_REPORTS_SQL = `UPDATE moderation_reports AS reports
SET status = 'resolved', resolved_at = $2
FROM moderation_subjects AS subjects
WHERE reports.subject_id = subjects.id
  AND subjects.author_address = $1
  AND reports.status = 'open'`

const HOURLY_RATE_SQL = `WITH rate_window AS (
  SELECT date_trunc('hour', $4::timestamptz) AS window_start
)
INSERT INTO rate_buckets AS buckets (
  scope,
  bucket_hash,
  window_start,
  request_count,
  expires_at
)
SELECT
  $1,
  $2,
  rate_window.window_start,
  1,
  rate_window.window_start + INTERVAL '1 hour'
FROM rate_window
ON CONFLICT (scope, bucket_hash, window_start)
DO UPDATE SET
  request_count = buckets.request_count + 1,
  expires_at = EXCLUDED.expires_at
WHERE buckets.request_count < $3
RETURNING request_count`

const MINUTE_RATE_SQL = `WITH rate_window AS (
  SELECT date_trunc('minute', $3::timestamptz) AS window_start
)
INSERT INTO rate_buckets AS buckets (
  scope,
  bucket_hash,
  window_start,
  request_count,
  expires_at
)
SELECT
  'decision',
  $1,
  rate_window.window_start,
  1,
  rate_window.window_start + INTERVAL '1 minute'
FROM rate_window
ON CONFLICT (scope, bucket_hash, window_start)
DO UPDATE SET
  request_count = buckets.request_count + 1,
  expires_at = EXCLUDED.expires_at
WHERE buckets.request_count < $2
RETURNING request_count`

const SUBJECT_COLUMNS = `id,
  scene_id AS "sceneId",
  author_address AS "authorAddress",
  content,
  channel,
  status,
  touring_consent AS "touringConsent",
  created_at AS "createdAt",
  deleted_at AS "deletedAt"`

const INSERT_SUBJECT_SQL = `INSERT INTO moderation_subjects (
  id,
  scene_id,
  author_address,
  content,
  fingerprint,
  channel,
  status,
  touring_consent,
  created_at,
  deleted_at
)
VALUES ($1, $2, $3, $4, $5, 'untrusted', 'published', $6, $7, NULL)
ON CONFLICT DO NOTHING
RETURNING ${SUBJECT_COLUMNS}`

const EXISTING_SUBJECT_SQL = `SELECT
  ${SUBJECT_COLUMNS},
  fingerprint,
  EXISTS (
    SELECT 1
    FROM moderation_audit AS audit
    WHERE audit.action = 'published'
      AND audit.subject_id = moderation_subjects.id
      AND audit.details->>'clientCreatedAt' = $2
  ) AS "exactClientTimestamp"
FROM moderation_subjects
WHERE id = $1`

const LIVE_DUPLICATE_SQL = `SELECT id
FROM moderation_subjects
WHERE fingerprint = $1
  AND status <> 'tombstoned'
ORDER BY created_at ASC, id ASC
LIMIT 1
FOR KEY SHARE`

const INSERT_REPORT_SQL = `INSERT INTO moderation_reports (
  id,
  subject_id,
  reporter_digest,
  reason,
  status,
  created_at,
  resolved_at
)
VALUES ($1, $2, $3, $4, 'open', $5, NULL)
ON CONFLICT DO NOTHING
RETURNING id`

const EXISTING_REPORT_SQL = `SELECT
  reports.id,
  reports.subject_id AS "subjectId",
  reports.reporter_digest AS "reporterDigest",
  reports.reason,
  EXISTS (
    SELECT 1
    FROM moderation_audit AS audit
    WHERE audit.action = 'reported'
      AND audit.subject_id = reports.subject_id
      AND audit.details->>'reportId' = reports.id
      AND audit.details->>'clientCreatedAt' = $2
  ) AS "exactClientTimestamp"
FROM moderation_reports AS reports
WHERE reports.id = $1`

const DUPLICATE_REPORT_SQL = `SELECT id
FROM moderation_reports
WHERE subject_id = $1
  AND reporter_digest = $2
  AND reason = $3
ORDER BY created_at ASC, id ASC
LIMIT 1
FOR KEY SHARE`

const QUEUE_SQL = `SELECT
  reports.id AS "reportId",
  reports.subject_id AS "subjectId",
  subjects.scene_id AS "sceneId",
  subjects.author_address AS "authorAddress",
  subjects.content,
  subjects.channel,
  subjects.touring_consent AS "touringConsent",
  subjects.status AS "subjectStatus",
  reports.reason,
  reports.created_at AS "reportedAt"
FROM moderation_reports AS reports
JOIN moderation_subjects AS subjects ON subjects.id = reports.subject_id
WHERE reports.status = 'open'
  AND NOT EXISTS (
    SELECT 1
    FROM shadow_hides AS hides
    WHERE hides.author_address = subjects.author_address
      AND hides.lifted_at IS NULL
  )
ORDER BY reports.created_at ASC, reports.id ASC
LIMIT ${MODERATION_QUEUE_LIMIT}`

const ELIGIBLE_SUBJECT_SQL = `SELECT
  subjects.id,
  subjects.scene_id AS "sceneId",
  subjects.author_address AS "authorAddress",
  subjects.content,
  subjects.channel,
  subjects.status,
  subjects.touring_consent AS "touringConsent",
  subjects.created_at AS "createdAt",
  subjects.deleted_at AS "deletedAt"
FROM moderation_subjects AS subjects
WHERE subjects.id = $1
  AND subjects.status = 'published'
  AND subjects.channel IN ('curated', 'trusted')
  AND subjects.touring_consent = TRUE
  AND NOT EXISTS (
    SELECT 1
    FROM shadow_hides AS hides
    WHERE hides.author_address = subjects.author_address
      AND hides.lifted_at IS NULL
  )`

const EXISTING_DECISION_SQL = `SELECT
  decisions.id,
  decisions.subject_id AS "subjectId",
  decisions.action,
  decisions.reason,
  decisions.moderator_address AS "moderatorAddress",
  EXISTS (
    SELECT 1
    FROM moderation_audit AS audit
    WHERE audit.action = decisions.action
      AND audit.subject_id = decisions.subject_id
      AND audit.details->>'decisionId' = decisions.id
      AND audit.details->>'clientCreatedAt' = $2
  ) AS "exactClientTimestamp"
FROM moderation_decisions AS decisions
WHERE decisions.id = $1`

const INSERT_DECISION_SQL = `INSERT INTO moderation_decisions (
  id,
  subject_id,
  report_id,
  action,
  reason,
  moderator_address,
  moderator_role,
  created_at
)
VALUES ($1, $2, NULL, $3, $4, $5, 'moderator', $6)
ON CONFLICT (id) DO NOTHING
RETURNING id`

const INSERT_AUDIT_SQL = `INSERT INTO moderation_audit (
  action,
  actor_address,
  actor_digest,
  subject_id,
  created_at,
  details
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)`

const TIMESTAMP_OUT_OF_RANGE = Object.freeze({ status: 'timestamp-out-of-range' as const })
const SCENE_NOT_ALLOWED = Object.freeze({ status: 'scene-not-allowed' as const })
const RATE_LIMITED = Object.freeze({ status: 'rate-limited' as const })
const UNAUTHORIZED = Object.freeze({ status: 'unauthorized' as const })
const SUBJECT_NOT_FOUND = Object.freeze({ status: 'subject-not-found' as const })
const SUBJECT_UNAVAILABLE = Object.freeze({ status: 'subject-unavailable' as const })

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

function timestampInRange(clientTimestamp: number, now: number) {
  return (
    Number.isSafeInteger(clientTimestamp) &&
    clientTimestamp >= 0 &&
    clientTimestamp <= MAX_TIMESTAMP &&
    clientTimestamp >= now - MAX_CLIENT_PAST_SKEW_MILLISECONDS &&
    clientTimestamp <= now + MAX_CLIENT_FUTURE_SKEW_MILLISECONDS
  )
}

function requireCanonicalAddress(value: unknown, label: string) {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function requireDigest(value: unknown, label: string) {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error(`${label} must be 32 bytes`)
  return Buffer.from(value)
}

function requireBoundedText(value: unknown, label: string, maximumBytes: number) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\0') ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function normalizeDuplicateText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(DUPLICATE_SEPARATORS, ' ').trim()
}

function fingerprintContent(value: string) {
  if (value.includes('\0')) return null
  const normalized = normalizeDuplicateText(value)
  if (normalized === '') return null
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

function requirePublishSubject(subject: PublishSubject) {
  requireBoundedText(subject.id, 'publish subject id', MAX_ID_BYTES)
  requireBoundedText(subject.content, 'publish subject content', MAX_CONTENT_BYTES)
  if (subject.channel !== 'untrusted' || typeof subject.touringConsent !== 'boolean') {
    throw new Error('Invalid publish subject')
  }
}

function requireReportInput(report: ModerationReportInput) {
  requireBoundedText(report.id, 'moderation report id', MAX_ID_BYTES)
  requireBoundedText(report.contentId, 'moderation report subject id', MAX_ID_BYTES)
  if (!REPORT_REASONS.has(report.reason) || report.status !== 'open') throw new Error('Invalid moderation report')
}

function requireDecisionInput(decision: ModerationDecisionInput) {
  requireBoundedText(decision.id, 'moderation decision id', MAX_ID_BYTES)
  requireBoundedText(decision.subjectId, 'moderation decision subject id', MAX_ID_BYTES)
  requireBoundedText(decision.reason, 'moderation decision reason', MAX_REASON_BYTES)
  if (!MODERATION_ACTIONS.has(decision.action)) {
    throw new Error('Invalid moderation decision')
  }
}

function requireDate(value: unknown, label: string) {
  if (!(value instanceof Date)) throw new Error(`Invalid ${label}`)
  const timestamp = value.getTime()
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
    throw new Error(`Invalid ${label}`)
  }
  return timestamp
}

function requireRowText(row: DatabaseRow, key: string, maximumBytes: number) {
  return requireBoundedText(row[key], `moderation row ${key}`, maximumBytes)
}

function mapSubjectRow(row: DatabaseRow): ModerationSubjectRow {
  const channel = row.channel
  const status = row.status
  const touringConsent = row.touringConsent
  const deletedAtValue = row.deletedAt
  if (
    typeof channel !== 'string' ||
    !SUBJECT_CHANNELS.has(channel) ||
    typeof status !== 'string' ||
    !SUBJECT_STATUSES.has(status) ||
    typeof touringConsent !== 'boolean' ||
    (deletedAtValue !== null && !(deletedAtValue instanceof Date))
  ) {
    throw new Error('Invalid moderation subject row')
  }

  const deletedAt = deletedAtValue === null ? null : requireDate(deletedAtValue, 'moderation subject deletedAt')
  if ((status === 'tombstoned') !== (deletedAt !== null)) throw new Error('Invalid moderation subject row')

  return Object.freeze({
    id: requireRowText(row, 'id', MAX_ID_BYTES),
    sceneId: requireRowText(row, 'sceneId', MAX_SCENE_ID_BYTES),
    authorAddress: requireCanonicalAddress(row.authorAddress, 'moderation subject author address'),
    content: requireRowText(row, 'content', MAX_CONTENT_BYTES),
    channel: channel as ModerationSubjectRow['channel'],
    status: status as ModerationSubjectRow['status'],
    touringConsent,
    createdAt: requireDate(row.createdAt, 'moderation subject createdAt'),
    deletedAt
  })
}

function mapQueueRow(row: DatabaseRow): ModerationQueueRow {
  const channel = row.channel
  const subjectStatus = row.subjectStatus
  const touringConsent = row.touringConsent
  const reason = row.reason
  if (
    typeof channel !== 'string' ||
    !SUBJECT_CHANNELS.has(channel) ||
    typeof subjectStatus !== 'string' ||
    !SUBJECT_STATUSES.has(subjectStatus) ||
    typeof touringConsent !== 'boolean' ||
    typeof reason !== 'string' ||
    !REPORT_REASONS.has(reason)
  ) {
    throw new Error('Invalid moderation queue row')
  }

  return Object.freeze({
    reportId: requireRowText(row, 'reportId', MAX_ID_BYTES),
    subjectId: requireRowText(row, 'subjectId', MAX_ID_BYTES),
    sceneId: requireRowText(row, 'sceneId', MAX_SCENE_ID_BYTES),
    authorAddress: requireCanonicalAddress(row.authorAddress, 'moderation queue author address'),
    content: requireRowText(row, 'content', MAX_CONTENT_BYTES),
    channel: channel as ModerationQueueRow['channel'],
    touringConsent,
    subjectStatus: subjectStatus as ModerationQueueRow['subjectStatus'],
    reason: reason as ReportReason,
    reportedAt: requireDate(row.reportedAt, 'moderation queue reportedAt')
  })
}

function isExactSubject(
  row: DatabaseRow,
  sceneId: string,
  actorAddress: string,
  subject: PublishSubject,
  fingerprint: string
) {
  return (
    row.sceneId === sceneId &&
    row.authorAddress === actorAddress &&
    row.content === subject.content &&
    row.fingerprint === fingerprint &&
    row.channel === 'untrusted' &&
    row.touringConsent === subject.touringConsent &&
    row.exactClientTimestamp === true
  )
}

function isExactReport(row: DatabaseRow, report: ModerationReportInput, reporterDigest: Buffer) {
  return (
    row.subjectId === report.contentId &&
    Buffer.isBuffer(row.reporterDigest) &&
    row.reporterDigest.equals(reporterDigest) &&
    row.reason === report.reason &&
    row.exactClientTimestamp === true
  )
}

function isExactDecision(row: DatabaseRow, decision: ModerationDecisionInput, actorAddress: string) {
  return (
    row.subjectId === decision.subjectId &&
    row.action === decision.action &&
    row.reason === decision.reason &&
    row.moderatorAddress === actorAddress &&
    row.exactClientTimestamp === true
  )
}

function auditDetails(value: Readonly<Record<string, string | number>>) {
  return JSON.stringify(value)
}

async function finishTransaction(client: DatabaseClient, command: 'COMMIT' | 'ROLLBACK') {
  await client.query(command)
}

export class ModerationRepository {
  private readonly allowedSceneIds: ReadonlySet<string>

  constructor(
    private readonly database: DatabaseConnectionSource,
    private readonly options: ModerationRepositoryOptions
  ) {
    if (
      options.allowedSceneIds.length === 0 ||
      options.allowedSceneIds.some(
        (sceneId) =>
          typeof sceneId !== 'string' ||
          sceneId === '' ||
          sceneId.trim() !== sceneId ||
          Buffer.byteLength(sceneId, 'utf8') > MAX_SCENE_ID_BYTES
      ) ||
      new Set(options.allowedSceneIds).size !== options.allowedSceneIds.length
    ) {
      throw new Error('Invalid moderation scene configuration')
    }
    if (
      typeof options.trustedCatalystUrl !== 'string' ||
      options.trustedCatalystUrl === '' ||
      options.trustedCatalystUrl.trim() !== options.trustedCatalystUrl ||
      Buffer.byteLength(options.trustedCatalystUrl, 'utf8') > MAX_CATALYST_ORIGIN_BYTES
    ) {
      throw new Error('Invalid moderation Catalyst configuration')
    }
    requireBoundedInteger(options.publishPerHour, MAX_RATE, 'publishPerHour')
    requireBoundedInteger(options.reportWalletPerHour, MAX_RATE, 'reportWalletPerHour')
    requireBoundedInteger(options.reportGuestPerHour, MAX_RATE, 'reportGuestPerHour')
    requireBoundedInteger(options.decisionPerMinute, MAX_RATE, 'decisionPerMinute')
    this.allowedSceneIds = new Set(options.allowedSceneIds)
  }

  async publish(
    sceneId: string,
    subject: PublishSubject,
    identity: ModerationPublishIdentity,
    now = Date.now()
  ): Promise<ModerationPublishResult> {
    requireNow(now)
    requireBoundedText(sceneId, 'moderation scene id', MAX_SCENE_ID_BYTES)
    if (typeof subject.content === 'string' && subject.content.includes('\0')) {
      return Object.freeze({ status: 'invalid-content' })
    }
    requirePublishSubject(subject)
    const actorAddress = requireCanonicalAddress(identity.actorAddress, 'moderation publish actor address')
    const bucketHash = requireDigest(identity.bucketHash, 'Moderation publish bucket hash')
    const auditDigest = requireDigest(identity.auditDigest, 'Moderation publish audit digest')
    const fingerprint = fingerprintContent(subject.content)
    if (fingerprint === null) return Object.freeze({ status: 'invalid-content' })
    if (!timestampInRange(subject.createdAt, now)) return TIMESTAMP_OUT_OF_RANGE
    if (!this.allowedSceneIds.has(sceneId)) return SCENE_NOT_ALLOWED

    const receivedAt = new Date(now)
    const client = await this.database.connect()
    let transactionOpen = false
    let releaseError: Error | undefined

    try {
      await client.query('BEGIN')
      transactionOpen = true

      const scene = await client.query(SCENE_LOCK_SQL, [sceneId, this.options.trustedCatalystUrl])
      if (scene.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return SCENE_NOT_ALLOWED
      }

      const rate = await client.query(HOURLY_RATE_SQL, ['publish', bucketHash, this.options.publishPerHour, receivedAt])
      if (rate.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return RATE_LIMITED
      }

      const inserted = await client.query(INSERT_SUBJECT_SQL, [
        subject.id,
        sceneId,
        actorAddress,
        subject.content,
        fingerprint,
        subject.touringConsent,
        receivedAt
      ])
      if (inserted.rowCount === 1) {
        await client.query(AUDIT_SEQUENCE_LOCK_SQL, AUDIT_SEQUENCE_LOCK_VALUES)
        await client.query(INSERT_AUDIT_SQL, [
          'published',
          null,
          auditDigest,
          subject.id,
          receivedAt,
          auditDetails({ clientCreatedAt: subject.createdAt })
        ])
        const row = inserted.rows[0]
        if (!row) throw new Error('Invalid moderation subject insert result')
        const published = mapSubjectRow(row)
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return Object.freeze({ status: 'published', subject: published })
      }

      const existing = await client.query(EXISTING_SUBJECT_SQL, [subject.id, String(subject.createdAt)])
      const existingRow = existing.rows[0]
      if (existing.rowCount === 1 && existingRow) {
        if (isExactSubject(existingRow, sceneId, actorAddress, subject, fingerprint)) {
          const replayed = mapSubjectRow(existingRow)
          await finishTransaction(client, 'COMMIT')
          transactionOpen = false
          return Object.freeze({ status: 'replay', subject: replayed })
        }
        await client.query(AUDIT_SEQUENCE_LOCK_SQL, AUDIT_SEQUENCE_LOCK_VALUES)
        await client.query(INSERT_AUDIT_SQL, [
          'publish-rejected',
          null,
          auditDigest,
          null,
          receivedAt,
          auditDetails({ clientCreatedAt: subject.createdAt, reason: 'id-conflict', requestedSubjectId: subject.id })
        ])
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return Object.freeze({ status: 'id-conflict' })
      }

      const duplicate = await client.query(LIVE_DUPLICATE_SQL, [fingerprint])
      const duplicateOf = duplicate.rows[0]?.id
      if (duplicate.rowCount !== 1 || typeof duplicateOf !== 'string') {
        throw new Error('Moderation subject insert conflict was not recoverable')
      }
      requireBoundedText(duplicateOf, 'duplicate moderation subject id', MAX_ID_BYTES)
      await client.query(AUDIT_SEQUENCE_LOCK_SQL, AUDIT_SEQUENCE_LOCK_VALUES)
      await client.query(INSERT_AUDIT_SQL, [
        'publish-rejected',
        null,
        auditDigest,
        null,
        receivedAt,
        auditDetails({
          clientCreatedAt: subject.createdAt,
          duplicateOf,
          reason: 'duplicate-content',
          requestedSubjectId: subject.id
        })
      ])
      await finishTransaction(client, 'COMMIT')
      transactionOpen = false
      return Object.freeze({ status: 'duplicate-content', duplicateOf })
    } catch (error) {
      if (!transactionOpen) throw error
      try {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('Moderation publish rollback failed')
        throw new AggregateError([error, rollbackError], 'Moderation publish and rollback failed')
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }

  async report(
    sceneId: string,
    report: ModerationReportInput,
    identity: ModerationReportIdentity,
    now = Date.now()
  ): Promise<ModerationReportResult> {
    requireNow(now)
    requireBoundedText(sceneId, 'moderation scene id', MAX_SCENE_ID_BYTES)
    requireReportInput(report)
    if (identity.scope !== 'report-wallet' && identity.scope !== 'report-guest') {
      throw new Error('Invalid moderation report rate scope')
    }
    const bucketHash = requireDigest(identity.bucketHash, 'Moderation report bucket hash')
    const reporterDigest = requireDigest(identity.reporterDigest, 'Moderation reporter digest')
    const auditDigest = requireDigest(identity.auditDigest, 'Moderation report audit digest')
    if (!timestampInRange(report.createdAt, now)) return TIMESTAMP_OUT_OF_RANGE
    if (!this.allowedSceneIds.has(sceneId)) return SCENE_NOT_ALLOWED

    const receivedAt = new Date(now)
    const client = await this.database.connect()
    let transactionOpen = false
    let releaseError: Error | undefined

    try {
      await client.query('BEGIN')
      transactionOpen = true

      const scene = await client.query(SCENE_LOCK_SQL, [sceneId, this.options.trustedCatalystUrl])
      if (scene.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return SCENE_NOT_ALLOWED
      }

      const limit =
        identity.scope === 'report-wallet' ? this.options.reportWalletPerHour : this.options.reportGuestPerHour
      const rate = await client.query(HOURLY_RATE_SQL, [identity.scope, bucketHash, limit, receivedAt])
      if (rate.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return RATE_LIMITED
      }

      const readExistingReport = async () => {
        const existing = await client.query(EXISTING_REPORT_SQL, [report.id, String(report.createdAt)])
        const row = existing.rows[0]
        if (existing.rowCount === 0) return null
        if (existing.rowCount !== 1 || !row) throw new Error('Invalid moderation report lookup result')
        return row
      }

      const classifyExistingReport = (row: DatabaseRow) =>
        isExactReport(row, report, reporterDigest)
          ? Object.freeze({ status: 'replay' as const })
          : Object.freeze({ status: 'report-id-conflict' as const })

      const subject = await client.query(
        `SELECT author_address AS "authorAddress", status
         FROM moderation_subjects
         WHERE id = $1
         FOR UPDATE`,
        [report.contentId]
      )
      if (subject.rowCount !== 1) {
        const existingWithoutSubject = await readExistingReport()
        if (existingWithoutSubject) {
          const result = classifyExistingReport(existingWithoutSubject)
          await finishTransaction(client, 'COMMIT')
          transactionOpen = false
          return result
        }
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return SUBJECT_NOT_FOUND
      }

      const existingBeforeAvailability = await readExistingReport()
      if (existingBeforeAvailability) {
        const result = classifyExistingReport(existingBeforeAvailability)
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return result
      }

      const subjectRow = subject.rows[0]
      if (!subjectRow || typeof subjectRow.status !== 'string' || !SUBJECT_STATUSES.has(subjectRow.status)) {
        throw new Error('Invalid moderation report subject row')
      }
      if (subjectRow.status !== 'published') {
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return SUBJECT_UNAVAILABLE
      }

      const authorAddress = requireCanonicalAddress(
        subjectRow.authorAddress,
        'moderation report subject author address'
      )
      await client.query(AUTHOR_LOCK_SQL, [authorAddress])
      const activeHide = await client.query(ACTIVE_HIDE_SQL, [authorAddress])
      if (activeHide.rowCount === 1) {
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return SUBJECT_UNAVAILABLE
      }
      if (activeHide.rowCount !== 0) throw new Error('Invalid moderation report shadow-hide lookup result')

      const inserted = await client.query(INSERT_REPORT_SQL, [
        report.id,
        report.contentId,
        reporterDigest,
        report.reason,
        receivedAt
      ])
      if (inserted.rowCount === 1) {
        await client.query(AUDIT_SEQUENCE_LOCK_SQL, AUDIT_SEQUENCE_LOCK_VALUES)
        await client.query(INSERT_AUDIT_SQL, [
          'reported',
          null,
          auditDigest,
          report.contentId,
          receivedAt,
          auditDetails({
            clientCreatedAt: report.createdAt,
            reason: report.reason,
            reportId: report.id,
            reportingSceneId: sceneId
          })
        ])
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return Object.freeze({ status: 'reported' })
      }

      const existingAfterConflict = await readExistingReport()
      if (existingAfterConflict) {
        const result = classifyExistingReport(existingAfterConflict)
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return result
      }

      const duplicate = await client.query(DUPLICATE_REPORT_SQL, [report.contentId, reporterDigest, report.reason])
      const reportId = duplicate.rows[0]?.id
      if (duplicate.rowCount !== 1 || typeof reportId !== 'string') {
        throw new Error('Moderation report insert conflict was not recoverable')
      }
      requireBoundedText(reportId, 'duplicate moderation report id', MAX_ID_BYTES)
      await finishTransaction(client, 'COMMIT')
      transactionOpen = false
      return Object.freeze({ status: 'duplicate-report', reportId })
    } catch (error) {
      if (!transactionOpen) throw error
      try {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('Moderation report rollback failed')
        throw new AggregateError([error, rollbackError], 'Moderation report and rollback failed')
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }

  async queue(moderatorAddress: string): Promise<ModerationQueueResult> {
    const actorAddress = requireCanonicalAddress(moderatorAddress, 'moderation queue actor address')
    const client = await this.database.connect()
    let transactionOpen = false
    let releaseError: Error | undefined

    try {
      await client.query('BEGIN')
      transactionOpen = true

      const role = await client.query(MODERATOR_LOCK_SQL, [actorAddress])
      if (role.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return UNAUTHORIZED
      }

      const queue = await client.query(QUEUE_SQL)
      if (queue.rows.length > MODERATION_QUEUE_LIMIT) throw new Error('Invalid moderation queue row count')
      const rows = Object.freeze(queue.rows.map(mapQueueRow))

      await finishTransaction(client, 'COMMIT')
      transactionOpen = false
      return Object.freeze({ status: 'data', rows })
    } catch (error) {
      if (!transactionOpen) throw error
      try {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('Moderation queue rollback failed')
        throw new AggregateError([error, rollbackError], 'Moderation queue and rollback failed')
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }

  async eligible(subjectId: string): Promise<ModerationEligibilityResult> {
    requireBoundedText(subjectId, 'moderation eligibility subject id', MAX_ID_BYTES)
    const client = await this.database.connect()

    try {
      const result = await client.query(ELIGIBLE_SUBJECT_SQL, [subjectId])
      if (result.rowCount === 0) return Object.freeze({ status: 'unavailable' })
      if (result.rowCount !== 1 || !result.rows[0]) throw new Error('Invalid moderation eligibility result')
      return Object.freeze({ status: 'eligible', subject: mapSubjectRow(result.rows[0]) })
    } finally {
      client.release()
    }
  }

  async decide(
    decision: ModerationDecisionInput,
    identity: ModerationDecisionIdentity,
    now = Date.now()
  ): Promise<ModerationDecisionResult> {
    requireNow(now)
    requireDecisionInput(decision)
    const actorAddress = requireCanonicalAddress(identity.actorAddress, 'moderation decision actor address')
    const bucketHash = requireDigest(identity.bucketHash, 'Moderation decision bucket hash')
    const auditDigest = requireDigest(identity.auditDigest, 'Moderation decision audit digest')
    if (!timestampInRange(decision.createdAt, now)) return TIMESTAMP_OUT_OF_RANGE

    const receivedAt = new Date(now)
    const client = await this.database.connect()
    let transactionOpen = false
    let releaseError: Error | undefined

    try {
      await client.query('BEGIN')
      transactionOpen = true

      const role = await client.query(MODERATOR_LOCK_SQL, [actorAddress])
      if (role.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return UNAUTHORIZED
      }

      const rate = await client.query(MINUTE_RATE_SQL, [bucketHash, this.options.decisionPerMinute, receivedAt])
      if (rate.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return RATE_LIMITED
      }

      const readExistingDecision = async () => {
        const existing = await client.query(EXISTING_DECISION_SQL, [decision.id, String(decision.createdAt)])
        const row = existing.rows[0]
        if (existing.rowCount === 0) return null
        if (existing.rowCount !== 1 || !row) throw new Error('Invalid moderation decision lookup result')
        return row
      }

      const classifyExistingDecision = (row: DatabaseRow) =>
        isExactDecision(row, decision, actorAddress)
          ? Object.freeze({ status: 'replay' as const })
          : Object.freeze({ status: 'decision-id-conflict' as const })

      const existingBeforeLock = await readExistingDecision()
      const lockedSubjectId =
        existingBeforeLock === null
          ? decision.subjectId
          : requireBoundedText(existingBeforeLock.subjectId, 'existing moderation decision subject id', MAX_ID_BYTES)

      const subject = await client.query(
        `SELECT author_address AS "authorAddress", status
         FROM moderation_subjects
         WHERE id = $1
         FOR UPDATE`,
        [lockedSubjectId]
      )
      if (existingBeforeLock !== null) {
        if (subject.rowCount !== 1) throw new Error('Existing moderation decision subject is missing')
        const existingResult = classifyExistingDecision(existingBeforeLock)
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return existingResult
      }
      if (subject.rowCount !== 1) {
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return SUBJECT_NOT_FOUND
      }

      const existingAfterLock = await readExistingDecision()
      if (existingAfterLock) {
        const existingResult = classifyExistingDecision(existingAfterLock)
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return existingResult
      }

      const subjectRow = subject.rows[0]
      if (!subjectRow) throw new Error('Invalid moderation decision subject row')
      const currentStatus = subjectRow.status
      if (currentStatus !== 'published' && currentStatus !== 'quarantined' && currentStatus !== 'tombstoned') {
        throw new Error('Invalid moderation decision subject row')
      }
      const authorAddress = requireCanonicalAddress(
        subjectRow.authorAddress,
        'moderation decision subject author address'
      )

      if (
        (decision.action === 'quarantined' && currentStatus !== 'published') ||
        (decision.action === 'tombstoned' && currentStatus === 'tombstoned')
      ) {
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return SUBJECT_UNAVAILABLE
      }

      if (decision.action === 'shadow-hidden') {
        await client.query(AUTHOR_LOCK_SQL, [authorAddress])
        const existingAfterAuthorLock = await readExistingDecision()
        if (existingAfterAuthorLock) {
          const existingResult = classifyExistingDecision(existingAfterAuthorLock)
          await finishTransaction(client, 'COMMIT')
          transactionOpen = false
          return existingResult
        }
        const activeHide = await client.query(ACTIVE_HIDE_SQL, [authorAddress])
        if (activeHide.rowCount === 1) {
          await client.query(RESOLVE_AUTHOR_REPORTS_SQL, [authorAddress, receivedAt])
          await finishTransaction(client, 'COMMIT')
          transactionOpen = false
          return SUBJECT_UNAVAILABLE
        }
        if (activeHide.rowCount !== 0) throw new Error('Invalid shadow-hide lookup result')
      }

      const inserted = await client.query(INSERT_DECISION_SQL, [
        decision.id,
        decision.subjectId,
        decision.action,
        decision.reason,
        actorAddress,
        receivedAt
      ])
      if (inserted.rowCount !== 1) {
        const racedDecision = await readExistingDecision()
        if (!racedDecision) throw new Error('Moderation decision insert conflict was not recoverable')
        const racedResult = classifyExistingDecision(racedDecision)
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return racedResult
      }

      let subjectStatus: ModerationSubjectRow['status'] = currentStatus
      if (decision.action === 'quarantined') {
        const updated = await client.query(
          `UPDATE moderation_subjects
           SET status = 'quarantined', deleted_at = NULL
           WHERE id = $1
             AND status <> 'tombstoned'
           RETURNING status`,
          [decision.subjectId]
        )
        if (updated.rowCount !== 1 || updated.rows[0]?.status !== 'quarantined') {
          throw new Error('Moderation quarantine transition failed')
        }
        subjectStatus = 'quarantined'
      } else if (decision.action === 'tombstoned') {
        const updated = await client.query(
          `UPDATE moderation_subjects
           SET status = 'tombstoned', deleted_at = $2
           WHERE id = $1
             AND status <> 'tombstoned'
           RETURNING status`,
          [decision.subjectId, receivedAt]
        )
        if (updated.rowCount !== 1 || updated.rows[0]?.status !== 'tombstoned') {
          throw new Error('Moderation tombstone transition failed')
        }
        subjectStatus = 'tombstoned'
      } else {
        const hidden = await client.query(
          `INSERT INTO shadow_hides (
             author_address,
             moderator_address,
             moderator_role,
             reason,
             created_at,
             lifted_at
           )
           VALUES ($1, $2, 'moderator', $3, $4, NULL)
           ON CONFLICT (author_address)
           DO UPDATE SET
             moderator_address = EXCLUDED.moderator_address,
             moderator_role = EXCLUDED.moderator_role,
             reason = EXCLUDED.reason,
             created_at = EXCLUDED.created_at,
             lifted_at = NULL
           WHERE shadow_hides.lifted_at IS NOT NULL
           RETURNING author_address`,
          [authorAddress, actorAddress, decision.reason, receivedAt]
        )
        if (hidden.rowCount !== 1 || hidden.rows[0]?.author_address !== authorAddress) {
          throw new Error('Moderation shadow-hide transition failed')
        }
      }

      const resolved =
        decision.action === 'shadow-hidden'
          ? await client.query(RESOLVE_AUTHOR_REPORTS_SQL, [authorAddress, receivedAt])
          : await client.query(
              `UPDATE moderation_reports
               SET status = 'resolved', resolved_at = $2
               WHERE subject_id = $1
                 AND status = 'open'`,
              [decision.subjectId, receivedAt]
            )
      if (resolved.rowCount === null || !Number.isSafeInteger(resolved.rowCount) || resolved.rowCount < 0) {
        throw new Error('Invalid moderation report resolution count')
      }

      await client.query(AUDIT_SEQUENCE_LOCK_SQL, AUDIT_SEQUENCE_LOCK_VALUES)
      await client.query(INSERT_AUDIT_SQL, [
        decision.action,
        actorAddress,
        auditDigest,
        decision.subjectId,
        receivedAt,
        auditDetails({
          clientCreatedAt: decision.createdAt,
          decisionId: decision.id,
          reason: decision.reason
        })
      ])
      await finishTransaction(client, 'COMMIT')
      transactionOpen = false
      return Object.freeze({
        status: 'applied',
        action: decision.action,
        subjectStatus,
        resolvedReports: resolved.rowCount
      })
    } catch (error) {
      if (!transactionOpen) throw error
      try {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('Moderation decision rollback failed')
        throw new AggregateError([error, rollbackError], 'Moderation decision and rollback failed')
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }
}
