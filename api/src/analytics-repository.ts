import type { AnalyticsEvent } from './contracts.js'
import type { DatabaseClient, DatabaseConnectionSource } from './database.js'

export type FunnelAnalyticsEvent = Extract<AnalyticsEvent, { kind: 'funnel' }>
export type AnalyticsRateIdentity = Readonly<{
  scope: 'analytics-wallet' | 'analytics-guest'
  bucketHash: Buffer
}>
export type FunnelIngestResult =
  | 'recorded'
  | 'duplicate'
  | 'event-id-conflict'
  | 'future'
  | 'expired'
  | 'rate-limited'
  | 'scene-not-allowed'

export type AnalyticsRepositoryOptions = Readonly<{
  allowedSceneIds: readonly string[]
  trustedCatalystUrl: string
  retentionDays: number
  analyticsWalletPerMinute: number
  analyticsGuestPerMinute: number
}>

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000
const MAX_TIMESTAMP = 8_640_000_000_000_000
const MAX_RETENTION_DAYS = 366
const MAX_RATE = 100_000

const RATE_SQL = `WITH rate_window AS (
  SELECT date_trunc('minute', $4::timestamptz) AS window_start
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
  rate_window.window_start + INTERVAL '1 minute'
FROM rate_window
ON CONFLICT (scope, bucket_hash, window_start)
DO UPDATE SET
  request_count = buckets.request_count + 1,
  expires_at = EXCLUDED.expires_at
WHERE buckets.request_count < $3
RETURNING request_count`

const INSERT_FUNNEL_SQL = `WITH inserted_receipt AS (
  INSERT INTO analytics_receipts (
    event_id,
    kind,
    event_name,
    scene_id,
    campaign,
    source,
    occurred_at,
    received_at
  )
  VALUES ($1, 'funnel', $2, $3, NULL, NULL, $4, $5)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_name, scene_id, occurred_at
)
INSERT INTO daily_funnel_aggregates AS totals (
  day,
  scene_id,
  wake_count,
  ready_count,
  decode_count,
  reveal_count,
  author_count,
  post_count,
  invite_count,
  mail_count
)
SELECT
  (occurred_at AT TIME ZONE 'UTC')::date,
  scene_id,
  CASE WHEN event_name = 'wake' THEN 1 ELSE 0 END,
  CASE WHEN event_name = 'ready' THEN 1 ELSE 0 END,
  CASE WHEN event_name = 'decode' THEN 1 ELSE 0 END,
  CASE WHEN event_name = 'reveal' THEN 1 ELSE 0 END,
  CASE WHEN event_name = 'author' THEN 1 ELSE 0 END,
  CASE WHEN event_name = 'post' THEN 1 ELSE 0 END,
  CASE WHEN event_name = 'invite' THEN 1 ELSE 0 END,
  CASE WHEN event_name = 'mail' THEN 1 ELSE 0 END
FROM inserted_receipt
ON CONFLICT (day, scene_id)
DO UPDATE SET
  wake_count = totals.wake_count + EXCLUDED.wake_count,
  ready_count = totals.ready_count + EXCLUDED.ready_count,
  decode_count = totals.decode_count + EXCLUDED.decode_count,
  reveal_count = totals.reveal_count + EXCLUDED.reveal_count,
  author_count = totals.author_count + EXCLUDED.author_count,
  post_count = totals.post_count + EXCLUDED.post_count,
  invite_count = totals.invite_count + EXCLUDED.invite_count,
  mail_count = totals.mail_count + EXCLUDED.mail_count
RETURNING 1 AS recorded`

const EXISTING_RECEIPT_SQL = `SELECT (
  kind = 'funnel'
  AND event_name = $2
  AND scene_id = $3
  AND occurred_at = $4::timestamptz
  AND campaign IS NULL
  AND source IS NULL
) AS identical
FROM analytics_receipts
WHERE event_id = $1`

function requireBoundedInteger(value: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`)
  }
}

async function finishTransaction(client: DatabaseClient, command: 'COMMIT' | 'ROLLBACK') {
  await client.query(command)
}

export class AnalyticsRepository {
  private readonly allowedSceneIds: ReadonlySet<string>

  constructor(
    private readonly database: DatabaseConnectionSource,
    private readonly options: AnalyticsRepositoryOptions
  ) {
    requireBoundedInteger(options.retentionDays, MAX_RETENTION_DAYS, 'retentionDays')
    requireBoundedInteger(options.analyticsWalletPerMinute, MAX_RATE, 'analyticsWalletPerMinute')
    requireBoundedInteger(options.analyticsGuestPerMinute, MAX_RATE, 'analyticsGuestPerMinute')
    this.allowedSceneIds = new Set(options.allowedSceneIds)
  }

  async recordFunnel(
    sceneId: string,
    event: FunnelAnalyticsEvent,
    rate: AnalyticsRateIdentity,
    now = Date.now()
  ): Promise<FunnelIngestResult> {
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIMESTAMP) throw new RangeError('Invalid current timestamp')
    if (event.occurredAt > now) return 'future'
    const eventDay = Math.floor(event.occurredAt / DAY_MILLISECONDS)
    const minimumDay = Math.floor(now / DAY_MILLISECONDS) - this.options.retentionDays + 1
    if (eventDay < minimumDay) return 'expired'
    if (!this.allowedSceneIds.has(sceneId)) return 'scene-not-allowed'
    if (rate.bucketHash.length !== 32) throw new Error('Analytics rate bucket hash must be 32 bytes')

    const limit =
      rate.scope === 'analytics-wallet' ? this.options.analyticsWalletPerMinute : this.options.analyticsGuestPerMinute
    const bucketHash = Buffer.from(rate.bucketHash)
    const receivedAt = new Date(now)
    const occurredAt = new Date(event.occurredAt)
    const client = await this.database.connect()
    let transactionOpen = false
    let releaseError: Error | undefined

    try {
      await client.query('BEGIN')
      transactionOpen = true

      const allowed = await client.query(
        `SELECT 1
         FROM scene_allowlist
         WHERE scene_id = $1
           AND catalyst_origin = $2
         FOR KEY SHARE`,
        [sceneId, this.options.trustedCatalystUrl]
      )
      if (allowed.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return 'scene-not-allowed'
      }

      const rateResult = await client.query(RATE_SQL, [rate.scope, bucketHash, limit, receivedAt])
      if (rateResult.rowCount !== 1) {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
        return 'rate-limited'
      }

      const inserted = await client.query(INSERT_FUNNEL_SQL, [
        event.eventId,
        event.event,
        sceneId,
        occurredAt,
        receivedAt
      ])
      if (inserted.rowCount === 1) {
        await finishTransaction(client, 'COMMIT')
        transactionOpen = false
        return 'recorded'
      }

      const existing = await client.query(EXISTING_RECEIPT_SQL, [event.eventId, event.event, sceneId, occurredAt])
      const identical = existing.rowCount === 1 && existing.rows[0]?.identical === true
      await finishTransaction(client, 'COMMIT')
      transactionOpen = false
      return identical ? 'duplicate' : 'event-id-conflict'
    } catch (error) {
      if (!transactionOpen) throw error
      try {
        await finishTransaction(client, 'ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('Analytics rollback failed')
        throw new AggregateError([error, rollbackError], 'Analytics write and rollback failed')
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }
}
