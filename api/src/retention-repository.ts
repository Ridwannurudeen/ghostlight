import type { DatabaseClient, DatabaseConnectionSource } from './database.js'

export type RetentionPruneTableResult = Readonly<{
  deleted: number
  possiblyBacklogged: boolean
}>

export type RetentionPruneResult = Readonly<{
  rateBuckets: RetentionPruneTableResult
  analyticsReceipts: RetentionPruneTableResult
}>

export type RetentionRepositoryOptions = Readonly<{
  analyticsRetentionDays: number
}>

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000
const MAX_TIMESTAMP = 8_640_000_000_000_000
const MAX_RETENTION_DAYS = 366
const BATCH_SIZE = 1_000
const MAX_BATCHES = 10

const DELETE_EXPIRED_RATE_BUCKETS_SQL = `WITH expired AS (
  SELECT ctid
  FROM rate_buckets
  WHERE expires_at <= $1::timestamptz
  ORDER BY expires_at ASC
  LIMIT $2
)
DELETE FROM rate_buckets AS buckets
USING expired
WHERE buckets.ctid = expired.ctid`

const DELETE_EXPIRED_ANALYTICS_RECEIPTS_SQL = `WITH expired AS (
  SELECT ctid
  FROM analytics_receipts
  WHERE received_at < $1::timestamptz
  ORDER BY received_at ASC
  LIMIT $2
)
DELETE FROM analytics_receipts AS receipts
USING expired
WHERE receipts.ctid = expired.ctid`

function requireRetentionDays(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETENTION_DAYS) {
    throw new RangeError(`analyticsRetentionDays must be between 1 and ${MAX_RETENTION_DAYS}`)
  }
}

function requireNow(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
    throw new RangeError('Invalid current timestamp')
  }
}

function requireDeletedRowCount(rowCount: number | null) {
  if (rowCount === null || !Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > BATCH_SIZE) {
    throw new Error('Invalid retention pruning result')
  }
  return rowCount
}

async function pruneTable(client: DatabaseClient, statement: string, cutoff: Date): Promise<RetentionPruneTableResult> {
  let deleted = 0

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const result = await client.query(statement, [cutoff, BATCH_SIZE])
    const batchDeleted = requireDeletedRowCount(result.rowCount)
    deleted += batchDeleted
    if (batchDeleted < BATCH_SIZE) return Object.freeze({ deleted, possiblyBacklogged: false })
  }

  return Object.freeze({ deleted, possiblyBacklogged: true })
}

export class RetentionRepository {
  private readonly analyticsRetentionMilliseconds: number

  constructor(
    private readonly database: DatabaseConnectionSource,
    options: RetentionRepositoryOptions
  ) {
    requireRetentionDays(options.analyticsRetentionDays)
    this.analyticsRetentionMilliseconds = options.analyticsRetentionDays * DAY_MILLISECONDS
  }

  async pruneExpired(now = Date.now()): Promise<RetentionPruneResult> {
    requireNow(now)
    const rateCutoff = new Date(now)
    const receiptCutoff = new Date(now - this.analyticsRetentionMilliseconds)
    const client = await this.database.connect()
    let releaseError: Error | undefined

    try {
      const rateBuckets = await pruneTable(client, DELETE_EXPIRED_RATE_BUCKETS_SQL, rateCutoff)
      const analyticsReceipts = await pruneTable(client, DELETE_EXPIRED_ANALYTICS_RECEIPTS_SQL, receiptCutoff)
      return Object.freeze({ rateBuckets, analyticsReceipts })
    } catch {
      releaseError = new Error('Retention pruning failed')
      throw releaseError
    } finally {
      client.release(releaseError)
    }
  }
}
