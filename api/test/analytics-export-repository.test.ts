import { describe, expect, it } from 'vitest'
import {
  AnalyticsExportRepository,
  parseAnalyticsExportRange,
  parseCanonicalUtcDay
} from '../src/analytics-export-repository.js'
import type {
  DatabaseClient,
  DatabaseConnectionSource,
  DatabaseQueryResult,
  DatabaseRow,
  DatabaseValue
} from '../src/database.js'

const NOW = Date.parse('2026-08-30T18:45:00.000Z')
const ACTOR_ADDRESS = `0x${'ab'.repeat(20)}`
const BUCKET_HASH = Buffer.alloc(32, 7)

type QueryCall = Readonly<{ text: string; values: readonly DatabaseValue[] }>
type QueryStep = Readonly<{ result?: DatabaseQueryResult; error?: Error }>

const emptyResult = (): DatabaseQueryResult => ({ rowCount: 0, rows: [] })
const oneRow = (row: DatabaseRow = {}): DatabaseQueryResult => ({ rowCount: 1, rows: [row] })
const rowsResult = (rows: readonly DatabaseRow[]): DatabaseQueryResult => ({ rowCount: rows.length, rows })

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

class ScriptedDatabase implements DatabaseConnectionSource {
  connectCount = 0

  constructor(private readonly clients: readonly ScriptedClient[]) {}

  async connect() {
    const client = this.clients[this.connectCount]
    this.connectCount += 1
    if (!client) throw new Error('Unexpected database connection')
    return client
  }
}

function repository(database: DatabaseConnectionSource, allowedSceneIds: readonly string[] = ['scene-a']) {
  return new AnalyticsExportRepository(database, { allowedSceneIds, exportPerHour: 2 })
}

function aggregateRow(overrides: DatabaseRow = {}): DatabaseRow {
  return {
    day: '2026-08-30',
    sceneId: 'scene-a',
    wakeCount: '9007199254740993',
    readyCount: '2',
    decodeCount: '3',
    revealCount: '4',
    authorCount: '5',
    postCount: '6',
    inviteCount: '7',
    mailCount: '8',
    ...overrides
  }
}

describe('analytics export UTC range parsing', () => {
  it('accepts only canonical Gregorian UTC days', () => {
    expect(parseCanonicalUtcDay('2024-02-29')).toBe('2024-02-29')
    expect(parseCanonicalUtcDay('9999-12-31')).toBe('9999-12-31')

    for (const invalid of [
      '0000-01-01',
      '2023-02-29',
      '2024-13-01',
      '2024-04-31',
      '2026-8-30',
      ' 2026-08-30',
      '2026-08-30T00:00:00.000Z',
      20260830,
      null
    ]) {
      expect(() => parseCanonicalUtcDay(invalid)).toThrow('Invalid canonical UTC day')
    }
  })

  it('counts an inclusive range and rejects reversed or longer-than-31-day ranges', () => {
    const sameDay = parseAnalyticsExportRange('2026-08-30', '2026-08-30')
    const maximumRange = parseAnalyticsExportRange('2026-01-01', '2026-01-31')

    expect(sameDay).toEqual({ fromDay: '2026-08-30', toDay: '2026-08-30', dayCount: 1 })
    expect(maximumRange).toEqual({ fromDay: '2026-01-01', toDay: '2026-01-31', dayCount: 31 })
    expect(Object.isFrozen(maximumRange)).toBe(true)
    expect(() => parseAnalyticsExportRange('2026-08-31', '2026-08-30')).toThrow('Invalid analytics export range')
    expect(() => parseAnalyticsExportRange('2026-01-01', '2026-02-01')).toThrow(
      'Analytics export range cannot exceed 31 days'
    )
  })
})

describe('transactional analytics export repository', () => {
  it('checks role, atomically admits the hourly bucket, then returns only configured-scene aggregates', async () => {
    const configuredScenes = ['scene-a']
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { result: oneRow(aggregateRow()) },
      { result: emptyResult() }
    ])
    const analytics = repository(new ScriptedDatabase([client]), configuredScenes)
    configuredScenes.push('scene-b')

    const result = await analytics.exportFunnel(
      ACTOR_ADDRESS,
      parseAnalyticsExportRange('2026-08-01', '2026-08-30'),
      BUCKET_HASH,
      NOW
    )

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      expect.stringContaining('FROM daily_funnel_aggregates'),
      'COMMIT'
    ])

    const roleCall = client.calls[1]
    expect(roleCall?.text).toContain("role IN ('analyst', 'moderator')")
    expect(roleCall?.text).toContain('revoked_at IS NULL')
    expect(roleCall?.text).not.toContain('trusted-creator')
    expect(roleCall?.text).toMatch(/ORDER BY role ASC\s+LIMIT 1\s+FOR SHARE/u)
    expect(roleCall?.values).toEqual([ACTOR_ADDRESS])

    const rateCall = client.calls[2]
    expect(rateCall?.text).toContain("date_trunc('hour'")
    expect(rateCall?.text).toContain("'export'")
    expect(rateCall?.text).toContain('ON CONFLICT (scope, bucket_hash, window_start)')
    expect(rateCall?.text).toContain('buckets.request_count < $2')
    expect(rateCall?.values).toEqual([BUCKET_HASH, 2, new Date(NOW)])
    expect(rateCall?.values[0]).not.toBe(BUCKET_HASH)

    const aggregateCall = client.calls[3]
    expect(aggregateCall?.text).toContain('scene_id = ANY($3::text[])')
    expect(aggregateCall?.text).toContain('wake_count::text AS "wakeCount"')
    expect(aggregateCall?.text).not.toContain('analytics_receipts')
    expect(aggregateCall?.text).not.toContain('actor_address')
    expect(aggregateCall?.values).toEqual(['2026-08-01', '2026-08-30', ['scene-a']])

    expect(result).toEqual({
      status: 'data',
      rows: [
        {
          day: '2026-08-30',
          sceneId: 'scene-a',
          wakeCount: '9007199254740993',
          readyCount: '2',
          decodeCount: '3',
          revealCount: '4',
          authorCount: '5',
          postCount: '6',
          inviteCount: '7',
          mailCount: '8'
        }
      ]
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.status === 'data' && Object.isFrozen(result.rows)).toBe(true)
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('denies callers without an analyst or moderator role before consuming rate', async () => {
    const client = new ScriptedClient([{ result: emptyResult() }, { result: emptyResult() }, { result: emptyResult() }])
    const analytics = repository(new ScriptedDatabase([client]))

    await expect(
      analytics.exportFunnel(ACTOR_ADDRESS, parseAnalyticsExportRange('2026-08-30', '2026-08-30'), BUCKET_HASH, NOW)
    ).resolves.toEqual({ status: 'unauthorized' })

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      'ROLLBACK'
    ])
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('authorizes a dual-role actor through the single locked qualifying-role row', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const analytics = repository(new ScriptedDatabase([client]))

    await expect(
      analytics.exportFunnel(ACTOR_ADDRESS, parseAnalyticsExportRange('2026-08-30', '2026-08-30'), BUCKET_HASH, NOW)
    ).resolves.toEqual({ status: 'data', rows: [] })

    expect(client.calls[1]?.text).toMatch(
      /role IN \('analyst', 'moderator'\)\s+AND revoked_at IS NULL\s+ORDER BY role ASC\s+LIMIT 1\s+FOR SHARE/u
    )
    expect(client.calls[2]?.text).toContain('INSERT INTO rate_buckets')
    expect(client.calls[3]?.text).toContain('FROM daily_funnel_aggregates')
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('rolls back without querying aggregate data when the atomic hourly bucket is full', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])
    const analytics = repository(new ScriptedDatabase([client]))

    await expect(
      analytics.exportFunnel(ACTOR_ADDRESS, parseAnalyticsExportRange('2026-08-30', '2026-08-30'), BUCKET_HASH, NOW)
    ).resolves.toEqual({ status: 'rate-limited' })

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      'ROLLBACK'
    ])
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('validates the actor, range, digest, and rate configuration before connecting', async () => {
    const database = new ScriptedDatabase([])
    const analytics = repository(database)
    const range = parseAnalyticsExportRange('2026-08-30', '2026-08-30')

    expect(() => new AnalyticsExportRepository(database, { allowedSceneIds: ['scene-a'], exportPerHour: 0 })).toThrow(
      'exportPerHour must be between 1 and 100000'
    )
    await expect(analytics.exportFunnel('0xABC', range, BUCKET_HASH, NOW)).rejects.toThrow(
      'Invalid analytics export actor address'
    )
    await expect(analytics.exportFunnel(ACTOR_ADDRESS, range, Buffer.alloc(31), NOW)).rejects.toThrow(
      'Analytics export bucket hash must be 32 bytes'
    )
    await expect(
      analytics.exportFunnel(
        ACTOR_ADDRESS,
        { fromDay: '2026-08-30', toDay: '2026-09-30', dayCount: 1 },
        BUCKET_HASH,
        NOW
      )
    ).rejects.toThrow('Analytics export range cannot exceed 31 days')
    expect(database.connectCount).toBe(0)
  })

  it('rejects malformed database counts and rolls back a consumed rate admission', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { result: oneRow(aggregateRow({ wakeCount: 9_007_199_254_740_993 })) },
      { result: emptyResult() }
    ])
    const analytics = repository(new ScriptedDatabase([client]))

    await expect(
      analytics.exportFunnel(ACTOR_ADDRESS, parseAnalyticsExportRange('2026-08-30', '2026-08-30'), BUCKET_HASH, NOW)
    ).rejects.toThrow('Invalid analytics export row')

    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('rejects aggregate results above the configured scene-by-day response bound before mapping', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { result: rowsResult([aggregateRow(), aggregateRow()]) },
      { result: emptyResult() }
    ])
    const analytics = repository(new ScriptedDatabase([client]))

    await expect(
      analytics.exportFunnel(ACTOR_ADDRESS, parseAnalyticsExportRange('2026-08-30', '2026-08-30'), BUCKET_HASH, NOW)
    ).rejects.toThrow('Invalid analytics export row count')

    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('rolls back query failures and releases a reusable client', async () => {
    const queryFailure = new Error('aggregate failed')
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { error: queryFailure },
      { result: emptyResult() }
    ])
    const analytics = repository(new ScriptedDatabase([client]))

    await expect(
      analytics.exportFunnel(ACTOR_ADDRESS, parseAnalyticsExportRange('2026-08-30', '2026-08-30'), BUCKET_HASH, NOW)
    ).rejects.toBe(queryFailure)

    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('destroys the client and preserves both failures when rollback fails', async () => {
    const queryFailure = new Error('aggregate failed')
    const rollbackFailure = new Error('rollback failed')
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { error: queryFailure },
      { error: rollbackFailure }
    ])
    const analytics = repository(new ScriptedDatabase([client]))

    const failure = await analytics
      .exportFunnel(ACTOR_ADDRESS, parseAnalyticsExportRange('2026-08-30', '2026-08-30'), BUCKET_HASH, NOW)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([queryFailure, rollbackFailure])
    expect(client.releases).toEqual([rollbackFailure])
    client.assertComplete()
  })
})
