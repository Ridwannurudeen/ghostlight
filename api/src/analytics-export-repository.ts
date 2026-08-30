import type { DatabaseClient, DatabaseConnectionSource, DatabaseRow } from './database.js'

export type AnalyticsExportRange = Readonly<{
  fromDay: string
  toDay: string
  dayCount: number
}>

export type AnalyticsExportRow = Readonly<{
  day: string
  sceneId: string
  wakeCount: string
  readyCount: string
  decodeCount: string
  revealCount: string
  authorCount: string
  postCount: string
  inviteCount: string
  mailCount: string
}>

export type AnalyticsExportResult =
  | Readonly<{ status: 'unauthorized' }>
  | Readonly<{ status: 'rate-limited' }>
  | Readonly<{ status: 'data'; rows: readonly AnalyticsExportRow[] }>

export type AnalyticsExportRepositoryOptions = Readonly<{
  allowedSceneIds: readonly string[]
  exportPerHour: number
}>

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000
const MAX_TIMESTAMP = 8_640_000_000_000_000
const MAX_RATE = 100_000
const MAX_RANGE_DAYS = 31
const CANONICAL_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const DECIMAL_BIGINT_PATTERN = /^(?:0|[1-9]\d*)$/u
const ACTOR_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u

const UNAUTHORIZED_RESULT: AnalyticsExportResult = Object.freeze({ status: 'unauthorized' })
const RATE_LIMITED_RESULT: AnalyticsExportResult = Object.freeze({ status: 'rate-limited' })

const ROLE_SQL = `SELECT 1
FROM actor_roles
WHERE actor_address = $1
  AND role IN ('analyst', 'moderator')
ORDER BY role ASC
LIMIT 1
FOR KEY SHARE`

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
  'export',
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

const AGGREGATE_SQL = `SELECT
  to_char(day, 'YYYY-MM-DD') AS day,
  scene_id AS "sceneId",
  wake_count::text AS "wakeCount",
  ready_count::text AS "readyCount",
  decode_count::text AS "decodeCount",
  reveal_count::text AS "revealCount",
  author_count::text AS "authorCount",
  post_count::text AS "postCount",
  invite_count::text AS "inviteCount",
  mail_count::text AS "mailCount"
FROM daily_funnel_aggregates
WHERE day BETWEEN $1::date AND $2::date
  AND scene_id = ANY($3::text[])
ORDER BY day ASC, scene_id ASC`

type ParsedCanonicalDay = Readonly<{ day: string; epochDay: number }>

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  return 31
}

function parseDay(value: unknown): ParsedCanonicalDay {
  if (typeof value !== 'string') throw new RangeError('Invalid canonical UTC day')
  const match = CANONICAL_DAY_PATTERN.exec(value)
  if (!match) throw new RangeError('Invalid canonical UTC day')

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError('Invalid canonical UTC day')
  }

  const instant = new Date(0)
  instant.setUTCFullYear(year, month - 1, day)
  return Object.freeze({ day: value, epochDay: Math.floor(instant.getTime() / DAY_MILLISECONDS) })
}

export function parseCanonicalUtcDay(value: unknown) {
  return parseDay(value).day
}

export function parseAnalyticsExportRange(fromDay: unknown, toDay: unknown): AnalyticsExportRange {
  const from = parseDay(fromDay)
  const to = parseDay(toDay)
  const dayCount = to.epochDay - from.epochDay + 1

  if (dayCount < 1) throw new RangeError('Invalid analytics export range')
  if (dayCount > MAX_RANGE_DAYS) throw new RangeError('Analytics export range cannot exceed 31 days')
  return Object.freeze({ fromDay: from.day, toDay: to.day, dayCount })
}

function requireBoundedInteger(value: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`)
  }
}

function requireDecimalBigint(row: DatabaseRow, key: keyof AnalyticsExportRow) {
  const value = row[key]
  if (typeof value !== 'string' || !DECIMAL_BIGINT_PATTERN.test(value)) {
    throw new Error('Invalid analytics export row')
  }
  return value
}

function sanitizeRow(
  row: DatabaseRow,
  range: AnalyticsExportRange,
  allowedSceneIds: ReadonlySet<string>
): AnalyticsExportRow {
  let day: string
  try {
    day = parseCanonicalUtcDay(row.day)
  } catch {
    throw new Error('Invalid analytics export row')
  }

  const sceneId = row.sceneId
  if (
    day < range.fromDay ||
    day > range.toDay ||
    typeof sceneId !== 'string' ||
    !allowedSceneIds.has(sceneId)
  ) {
    throw new Error('Invalid analytics export row')
  }

  return Object.freeze({
    day,
    sceneId,
    wakeCount: requireDecimalBigint(row, 'wakeCount'),
    readyCount: requireDecimalBigint(row, 'readyCount'),
    decodeCount: requireDecimalBigint(row, 'decodeCount'),
    revealCount: requireDecimalBigint(row, 'revealCount'),
    authorCount: requireDecimalBigint(row, 'authorCount'),
    postCount: requireDecimalBigint(row, 'postCount'),
    inviteCount: requireDecimalBigint(row, 'inviteCount'),
    mailCount: requireDecimalBigint(row, 'mailCount')
  })
}

async function finishTransaction(client: DatabaseClient, command: 'COMMIT' | 'ROLLBACK') {
  await client.query(command)
}

export class AnalyticsExportRepository {
  private readonly allowedSceneIds: readonly string[]
  private readonly allowedSceneIdSet: ReadonlySet<string>
  private readonly exportPerHour: number

  constructor(
    private readonly database: DatabaseConnectionSource,
    options: AnalyticsExportRepositoryOptions
  ) {
    requireBoundedInteger(options.exportPerHour, MAX_RATE, 'exportPerHour')
    if (
      options.allowedSceneIds.length === 0 ||
      options.allowedSceneIds.some(
        (sceneId) => typeof sceneId !== 'string' || sceneId.length === 0 || sceneId.trim() !== sceneId
      )
    ) {
      throw new Error('Invalid analytics export scene configuration')
    }

    this.allowedSceneIds = Object.freeze([...new Set(options.allowedSceneIds)])
    this.allowedSceneIdSet = new Set(this.allowedSceneIds)
    this.exportPerHour = options.exportPerHour
  }

  async exportFunnel(
    actorAddress: string,
    range: AnalyticsExportRange,
    bucketHash: Buffer,
    now = Date.now()
  ): Promise<AnalyticsExportResult> {
    if (!ACTOR_ADDRESS_PATTERN.test(actorAddress)) throw new Error('Invalid analytics export actor address')
    if (!Buffer.isBuffer(bucketHash) || bucketHash.length !== 32) {
      throw new Error('Analytics export bucket hash must be 32 bytes')
    }
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
      throw new RangeError('Invalid current timestamp')
    }

    const canonicalRange = parseAnalyticsExportRange(range.fromDay, range.toDay)
    if (range.dayCount !== canonicalRange.dayCount) throw new RangeError('Invalid analytics export range')

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

      const rate = await client.query(RATE_SQL, [immutableBucketHash, this.exportPerHour, receivedAt])
      if (rate.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return RATE_LIMITED_RESULT
      }

      const aggregate = await client.query(AGGREGATE_SQL, [
        canonicalRange.fromDay,
        canonicalRange.toDay,
        this.allowedSceneIds
      ])
      if (aggregate.rows.length > canonicalRange.dayCount * this.allowedSceneIds.length) {
        throw new Error('Invalid analytics export row count')
      }
      const rows = Object.freeze(
        aggregate.rows.map((row) => sanitizeRow(row, canonicalRange, this.allowedSceneIdSet))
      )

      await finishTransaction(client, 'COMMIT')
      transactionOpen = false
      return Object.freeze({ status: 'data', rows })
    } catch (error) {
      if (!transactionOpen) throw error
      try {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('Analytics export rollback failed')
        throw new AggregateError([error, rollbackError], 'Analytics export and rollback failed')
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }
}
