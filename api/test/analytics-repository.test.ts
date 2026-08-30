import { describe, expect, it } from 'vitest'
import {
  AnalyticsRepository,
  type AnalyticsRateIdentity,
  type FunnelAnalyticsEvent
} from '../src/analytics-repository.js'
import {
  Database,
  type DatabaseClient,
  type DatabasePool,
  type DatabaseQueryResult,
  type DatabaseValue
} from '../src/database.js'

const DAY = 24 * 60 * 60 * 1_000
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const CATALYST = 'https://peer.decentraland.org'
const RATE: AnalyticsRateIdentity = Object.freeze({
  scope: 'analytics-wallet',
  bucketHash: Buffer.alloc(32, 7)
})

type QueryCall = Readonly<{ text: string; values: readonly DatabaseValue[] }>
type QueryStep = Readonly<{ result?: DatabaseQueryResult; error?: Error }>

const emptyResult = (rowCount = 0): DatabaseQueryResult => ({ rowCount, rows: [] })
const oneRow = (row: Readonly<Record<string, DatabaseValue>> = {}): DatabaseQueryResult => ({
  rowCount: 1,
  rows: [row]
})

class ScriptedClient implements DatabaseClient {
  readonly calls: QueryCall[] = []
  readonly releases: (Error | boolean | undefined)[] = []

  constructor(private readonly steps: QueryStep[]) {}

  async query(text: string, values: readonly DatabaseValue[] = []) {
    this.calls.push({ text, values: [...values] })
    const step = this.steps.shift()
    if (!step) throw new Error(`Unexpected query: ${text}`)
    if (step.error) throw step.error
    return step.result ?? emptyResult()
  }

  release(error?: Error | boolean) {
    this.releases.push(error)
  }

  assertComplete() {
    expect(this.steps).toEqual([])
  }
}

class ScriptedPool implements DatabasePool {
  readonly calls: QueryCall[] = []
  connectCount = 0
  endCount = 0

  constructor(
    private readonly clients: ScriptedClient[] = [],
    private readonly steps: QueryStep[] = []
  ) {}

  async connect() {
    const client = this.clients[this.connectCount]
    this.connectCount += 1
    if (!client) throw new Error('Unexpected database connection')
    return client
  }

  async query(text: string, values: readonly DatabaseValue[] = []) {
    this.calls.push({ text, values: [...values] })
    const step = this.steps.shift()
    if (!step) throw new Error(`Unexpected pool query: ${text}`)
    if (step.error) throw step.error
    return step.result ?? emptyResult()
  }

  async end() {
    this.endCount += 1
  }

  assertComplete() {
    expect(this.clients).toHaveLength(this.connectCount)
    expect(this.steps).toEqual([])
  }
}

function event(value: number, occurredAt = NOW, name: FunnelAnalyticsEvent['event'] = 'wake'): FunnelAnalyticsEvent {
  return Object.freeze({
    eventId: `evt_${value.toString(16).padStart(32, '0')}`,
    event: name,
    occurredAt,
    kind: 'funnel'
  })
}

function repository(pool: DatabasePool, allowedSceneIds: readonly string[] = ['scene-a']) {
  return new AnalyticsRepository(pool, {
    allowedSceneIds,
    trustedCatalystUrl: CATALYST,
    retentionDays: 2,
    analyticsWalletPerMinute: 2,
    analyticsGuestPerMinute: 1
  })
}

function successfulClient(aggregateResult = oneRow()) {
  return new ScriptedClient([
    { result: emptyResult() },
    { result: oneRow() },
    { result: oneRow() },
    { result: aggregateResult },
    { result: emptyResult() }
  ])
}

describe('database lifecycle', () => {
  it('serializes the ordered rerunnable migrations behind a session advisory lock', async () => {
    const client = new ScriptedClient([
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() },
      { result: oneRow({ unlocked: true }) }
    ])
    const database = new Database(new ScriptedPool([client]))

    await database.migrate()

    expect(client.calls).toHaveLength(4)
    expect(client.calls[0]?.text).toContain('pg_advisory_lock')
    expect(client.calls[1]?.text.trimStart()).toMatch(/^BEGIN;/u)
    expect(client.calls[1]?.text).toContain('CREATE TABLE IF NOT EXISTS analytics_receipts')
    expect(client.calls[2]?.text.trimStart()).toMatch(/^BEGIN;/u)
    expect(client.calls[2]?.text).toContain('ADD COLUMN IF NOT EXISTS revoked_at')
    expect(client.calls[3]?.text).toContain('pg_advisory_unlock')
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('rolls back a failed migration before unlocking and releasing the connection', async () => {
    const migrationFailure = new Error('migration failed')
    const client = new ScriptedClient([
      { result: oneRow() },
      { result: emptyResult() },
      { error: migrationFailure },
      { result: emptyResult() },
      { result: oneRow({ unlocked: true }) }
    ])
    const database = new Database(new ScriptedPool([client]))

    await expect(database.migrate()).rejects.toBe(migrationFailure)

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      expect.stringContaining('pg_advisory_lock'),
      expect.stringMatching(/^BEGIN;/u),
      expect.stringMatching(/^BEGIN;/u),
      'ROLLBACK',
      expect.stringContaining('pg_advisory_unlock')
    ])
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('seeds current configured scenes without deleting history, and supports ping and close', async () => {
    const pool = new ScriptedPool([], [{ result: emptyResult(2) }, { result: oneRow() }])
    const database = new Database(pool)

    await database.seedSceneAllowlist(['scene-a', 'scene-b'], CATALYST)
    await database.ping()
    await database.close()

    expect(pool.calls[0]?.text).toContain('INSERT INTO scene_allowlist')
    expect(pool.calls[0]?.text).toContain('unnest($1::text[])')
    expect(pool.calls[0]?.text).toContain('ON CONFLICT (scene_id)')
    expect(pool.calls[0]?.text).not.toMatch(/DELETE/iu)
    expect(pool.calls[0]?.values).toEqual([['scene-a', 'scene-b'], CATALYST])
    expect(pool.calls[1]).toEqual({ text: 'SELECT 1', values: [] })
    expect(pool.endCount).toBe(1)
    pool.assertComplete()
  })
})

describe('transactional funnel analytics repository', () => {
  it('uses immutable configured-scene membership and validates the persisted Catalyst row', async () => {
    const configuredScenes = ['scene-a']
    const missingRowClient = new ScriptedClient([
      { result: emptyResult() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const pool = new ScriptedPool([missingRowClient])
    const analytics = repository(pool, configuredScenes)
    configuredScenes.push('scene-b')

    await expect(analytics.recordFunnel('scene-b', event(1), RATE, NOW)).resolves.toBe('scene-not-allowed')
    await expect(analytics.recordFunnel('scene-a', event(2), RATE, NOW)).resolves.toBe('scene-not-allowed')

    expect(pool.connectCount).toBe(1)
    expect(missingRowClient.calls[1]?.text).toContain('FROM scene_allowlist')
    expect(missingRowClient.calls[1]?.values).toEqual(['scene-a', CATALYST])
    expect(missingRowClient.calls[2]?.text).toBe('ROLLBACK')
    expect(missingRowClient.releases).toEqual([undefined])
    missingRowClient.assertComplete()
  })

  it('matches the existing future and retained UTC-day boundaries before opening a transaction', async () => {
    const acceptedClient = successfulClient()
    const pool = new ScriptedPool([acceptedClient])
    const analytics = repository(pool)
    const earliestRetainedDay = Math.floor(NOW / DAY) * DAY - DAY

    await expect(analytics.recordFunnel('scene-a', event(1, NOW + 1), RATE, NOW)).resolves.toBe('future')
    await expect(analytics.recordFunnel('scene-a', event(2, earliestRetainedDay - 1), RATE, NOW)).resolves.toBe(
      'expired'
    )
    await expect(analytics.recordFunnel('scene-a', event(3, earliestRetainedDay), RATE, NOW)).resolves.toBe('recorded')

    expect(pool.connectCount).toBe(1)
    acceptedClient.assertComplete()
  })

  it('atomically consumes the minute bucket before inserting the receipt and aggregate', async () => {
    const client = successfulClient()
    const analytics = repository(new ScriptedPool([client]))

    await expect(analytics.recordFunnel('scene-a', event(1), RATE, NOW)).resolves.toBe('recorded')

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM scene_allowlist'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      expect.stringContaining('WITH inserted_receipt AS'),
      'COMMIT'
    ])
    expect(client.calls[2]?.text).toContain('buckets.request_count < $3')
    expect(client.calls[2]?.values).toEqual(['analytics-wallet', RATE.bucketHash, 2, new Date(NOW)])
    expect(client.calls[3]?.text).toContain('INSERT INTO analytics_receipts')
    expect(client.calls[3]?.text).toContain('received_at')
    expect(client.calls[3]?.text).toContain('INSERT INTO daily_funnel_aggregates')
    expect(client.calls[3]?.text).toContain("AT TIME ZONE 'UTC'")
    expect(client.calls[3]?.values).toEqual([event(1).eventId, 'wake', 'scene-a', new Date(NOW), new Date(NOW)])
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('rolls back before receipt insertion when the atomic rate limit returns no row', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const analytics = repository(new ScriptedPool([client]))

    await expect(analytics.recordFunnel('scene-a', event(1), RATE, NOW)).resolves.toBe('rate-limited')

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM scene_allowlist'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      'ROLLBACK'
    ])
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('commits consumed rate for an identical duplicate and rejects changed event-id reuse', async () => {
    const duplicateClient = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ identical: true }) },
      { result: emptyResult() }
    ])
    const conflictClient = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: oneRow({ identical: false }) },
      { result: emptyResult() }
    ])
    const analytics = repository(new ScriptedPool([duplicateClient, conflictClient]))

    await expect(analytics.recordFunnel('scene-a', event(1), RATE, NOW)).resolves.toBe('duplicate')
    await expect(analytics.recordFunnel('scene-a', event(1, NOW, 'ready'), RATE, NOW)).resolves.toBe(
      'event-id-conflict'
    )

    for (const client of [duplicateClient, conflictClient]) {
      expect(client.calls.at(-2)?.text).toContain('FROM analytics_receipts')
      expect(client.calls.at(-2)?.text).toContain("kind = 'funnel'")
      expect(client.calls.at(-2)?.text).toContain('event_name = $2')
      expect(client.calls.at(-2)?.text).toContain('scene_id = $3')
      expect(client.calls.at(-2)?.text).toContain('occurred_at = $4::timestamptz')
      expect(client.calls.at(-1)?.text).toBe('COMMIT')
      expect(client.releases).toEqual([undefined])
      client.assertComplete()
    }
  })

  it('rolls back all mutations after an aggregate failure and releases a reusable client', async () => {
    const aggregateFailure = new Error('aggregate failed')
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { error: aggregateFailure },
      { result: emptyResult() }
    ])
    const analytics = repository(new ScriptedPool([client]))

    await expect(analytics.recordFunnel('scene-a', event(1), RATE, NOW)).rejects.toBe(aggregateFailure)

    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('destroys the client and reports both failures when rollback itself fails', async () => {
    const aggregateFailure = new Error('aggregate failed')
    const rollbackFailure = new Error('rollback failed')
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow() },
      { error: aggregateFailure },
      { error: rollbackFailure }
    ])
    const analytics = repository(new ScriptedPool([client]))

    const failure = await analytics.recordFunnel('scene-a', event(1), RATE, NOW).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([aggregateFailure, rollbackFailure])
    expect(client.releases).toEqual([rollbackFailure])
    client.assertComplete()
  })
})
