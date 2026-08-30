import { describe, expect, it } from 'vitest'
import { RetentionRepository } from '../src/retention-repository.js'
import type { DatabaseClient, DatabaseConnectionSource, DatabaseQueryResult, DatabaseValue } from '../src/database.js'

const DAY = 24 * 60 * 60 * 1_000
const NOW = Date.parse('2026-08-30T18:45:00.000Z')

type QueryCall = Readonly<{ text: string; values: readonly DatabaseValue[] }>
type QueryStep = Readonly<{ result?: DatabaseQueryResult; error?: Error }>

const deleted = (rowCount: number | null): DatabaseQueryResult => ({ rowCount, rows: [] })

class ScriptedClient implements DatabaseClient {
  readonly calls: QueryCall[] = []
  readonly releases: (Error | boolean | undefined)[] = []

  constructor(private readonly steps: QueryStep[]) {}

  async query(text: string, values: readonly DatabaseValue[] = []) {
    this.calls.push({ text, values: [...values] })
    const step = this.steps.shift()
    if (!step) throw new Error(`Unexpected query: ${text}`)
    if (step.error) throw step.error
    return step.result ?? deleted(0)
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

  constructor(private readonly client: ScriptedClient) {}

  async connect() {
    this.connectCount += 1
    if (this.connectCount > 1) throw new Error('Unexpected database connection')
    return this.client
  }
}

function repository(client: ScriptedClient, analyticsRetentionDays = 31) {
  return new RetentionRepository(new ScriptedDatabase(client), { analyticsRetentionDays })
}

describe('bounded retention repository', () => {
  it('validates retention and timestamp bounds before connecting', async () => {
    const client = new ScriptedClient([])
    const database = new ScriptedDatabase(client)

    for (const analyticsRetentionDays of [0, 367, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new RetentionRepository(database, { analyticsRetentionDays })).toThrow(
        'analyticsRetentionDays must be between 1 and 366'
      )
    }

    const retention = new RetentionRepository(database, { analyticsRetentionDays: 1 })
    for (const now of [-1, 1.5, 8_640_000_000_000_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(retention.pruneExpired(now)).rejects.toThrow('Invalid current timestamp')
    }
    expect(database.connectCount).toBe(0)

    for (const [analyticsRetentionDays, now] of [
      [1, 0],
      [366, 8_640_000_000_000_000]
    ] as const) {
      const boundaryClient = new ScriptedClient([{ result: deleted(0) }, { result: deleted(0) }])
      await expect(repository(boundaryClient, analyticsRetentionDays).pruneExpired(now)).resolves.toEqual({
        rateBuckets: { deleted: 0, possiblyBacklogged: false },
        analyticsReceipts: { deleted: 0, possiblyBacklogged: false }
      })
      boundaryClient.assertComplete()
    }
  })

  it('uses the exact inclusive rate and exclusive received-at cutoffs in indexed bounded deletes', async () => {
    const client = new ScriptedClient([{ result: deleted(0) }, { result: deleted(0) }])
    const result = await repository(client, 31).pruneExpired(NOW)

    expect(client.calls).toHaveLength(2)
    expect(client.calls[0]?.text).toMatch(/FROM rate_buckets\s+WHERE expires_at <= \$1::timestamptz/u)
    expect(client.calls[0]?.text).toContain('ORDER BY expires_at ASC')
    expect(client.calls[0]?.text).toContain('SELECT ctid')
    expect(client.calls[0]?.text).toContain('LIMIT $2')
    expect(client.calls[0]?.values).toEqual([new Date(NOW), 1_000])
    expect(client.calls[1]?.text).toMatch(/FROM analytics_receipts\s+WHERE received_at < \$1::timestamptz/u)
    expect(client.calls[1]?.text).toContain('ORDER BY received_at ASC')
    expect(client.calls[1]?.text).toContain('SELECT ctid')
    expect(client.calls[1]?.text).toContain('LIMIT $2')
    expect(client.calls[1]?.values).toEqual([new Date(NOW - 31 * DAY), 1_000])
    expect(client.calls.every(({ text }) => text.includes('USING expired'))).toBe(true)
    expect(client.calls.map(({ text }) => text).join('\n')).not.toMatch(
      /daily_(?:funnel|click)_aggregates|moderation_|actor_roles|scene_allowlist/iu
    )
    expect(result).toEqual({
      rateBuckets: { deleted: 0, possiblyBacklogged: false },
      analyticsReceipts: { deleted: 0, possiblyBacklogged: false }
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.rateBuckets)).toBe(true)
    expect(Object.isFrozen(result.analyticsReceipts)).toBe(true)
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('stops each table independently after a partial batch and totals every deleted row', async () => {
    const client = new ScriptedClient([
      { result: deleted(1_000) },
      { result: deleted(25) },
      { result: deleted(1_000) },
      { result: deleted(1_000) },
      { result: deleted(9) }
    ])

    await expect(repository(client).pruneExpired(NOW)).resolves.toEqual({
      rateBuckets: { deleted: 1_025, possiblyBacklogged: false },
      analyticsReceipts: { deleted: 2_009, possiblyBacklogged: false }
    })
    expect(client.calls.filter(({ text }) => text.includes('rate_buckets'))).toHaveLength(2)
    expect(client.calls.filter(({ text }) => text.includes('analytics_receipts'))).toHaveLength(3)
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('caps both tables at ten full batches and conservatively reports possible backlog', async () => {
    const client = new ScriptedClient(Array.from({ length: 20 }, () => ({ result: deleted(1_000) })))

    await expect(repository(client).pruneExpired(NOW)).resolves.toEqual({
      rateBuckets: { deleted: 10_000, possiblyBacklogged: true },
      analyticsReceipts: { deleted: 10_000, possiblyBacklogged: true }
    })
    expect(client.calls.filter(({ text }) => text.includes('rate_buckets'))).toHaveLength(10)
    expect(client.calls.filter(({ text }) => text.includes('analytics_receipts'))).toHaveLength(10)
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('destroys the client with a sanitized failure when a delete query fails', async () => {
    const databaseFailure = new Error('password leaked by database')
    const client = new ScriptedClient([{ result: deleted(0) }, { error: databaseFailure }])

    const failure = await repository(client)
      .pruneExpired(NOW)
      .catch((error: unknown) => error)

    expect(failure).toEqual(new Error('Retention pruning failed'))
    expect(failure).not.toBe(databaseFailure)
    expect(client.releases).toEqual([failure])
    client.assertComplete()
  })

  it.each([null, -1, 1_001, 1.5])('fails closed and destroys the client for invalid rowCount %s', async (rowCount) => {
    const client = new ScriptedClient([{ result: deleted(rowCount) }])

    const failure = await repository(client)
      .pruneExpired(NOW)
      .catch((error: unknown) => error)

    expect(failure).toEqual(new Error('Retention pruning failed'))
    expect(client.releases).toEqual([failure])
    client.assertComplete()
  })
})
