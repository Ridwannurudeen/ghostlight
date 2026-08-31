import { describe, expect, it } from 'vitest'
import {
  ModerationAuditExportRepository,
  parseModerationAuditCursor
} from '../src/moderation-audit-export-repository.js'
import type {
  DatabaseClient,
  DatabaseConnectionSource,
  DatabaseQueryResult,
  DatabaseRow,
  DatabaseValue
} from '../src/database.js'

const NOW = Date.parse('2026-08-30T18:45:00.000Z')
const MODERATOR = `0x${'ab'.repeat(20)}`
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

function repository(database: DatabaseConnectionSource, auditExportPerHour = 2) {
  return new ModerationAuditExportRepository(database, { auditExportPerHour })
}

function publishedRow(sequence: string, overrides: DatabaseRow = {}): DatabaseRow {
  return {
    sequence,
    action: 'published',
    moderatorAddress: null,
    subjectId: `subject-${sequence}`,
    createdAt: new Date(NOW),
    details: { clientCreatedAt: NOW - 1_000 },
    ...overrides
  }
}

describe('moderation audit cursor parsing', () => {
  it('accepts only canonical PostgreSQL bigint cursors', () => {
    expect(parseModerationAuditCursor('0')).toBe('0')
    expect(parseModerationAuditCursor('9223372036854775807')).toBe('9223372036854775807')

    for (const invalid of [
      '',
      '00',
      '01',
      '-1',
      '+1',
      '1.0',
      ' 1',
      '1 ',
      '9223372036854775808',
      '1'.repeat(10_000),
      1,
      null
    ]) {
      expect(() => parseModerationAuditCursor(invalid)).toThrow('Invalid moderation audit cursor')
    }
  })
})

describe('transactional moderation audit export repository', () => {
  it('checks an active moderator, consumes its dedicated rate bucket, and projects safe exact rows', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      {
        result: rowsResult([
          publishedRow('8', { actorDigest: Buffer.alloc(32), content: 'secret' }),
          {
            sequence: '9',
            action: 'publish-rejected',
            moderatorAddress: null,
            subjectId: null,
            createdAt: new Date(NOW + 1),
            details: {
              clientCreatedAt: NOW - 999,
              duplicateOf: 'subject-8',
              reason: 'duplicate-content',
              requestedSubjectId: 'subject-9'
            }
          },
          {
            sequence: '10',
            action: 'reported',
            moderatorAddress: null,
            subjectId: 'subject-8',
            createdAt: new Date(NOW + 2),
            details: {
              clientCreatedAt: NOW - 998,
              reason: 'abuse',
              reportId: 'report-1',
              reportingSceneId: 'scene-a'
            }
          },
          {
            sequence: '11',
            action: 'quarantined',
            moderatorAddress: MODERATOR,
            subjectId: 'subject-8',
            createdAt: new Date(NOW + 3),
            details: { clientCreatedAt: NOW - 997, decisionId: 'decision-1', reason: 'Confirmed abuse' }
          }
        ])
      },
      { result: emptyResult() }
    ])
    const audit = repository(new ScriptedDatabase([client]))

    const result = await audit.exportAudit(MODERATOR, '7', BUCKET_HASH, NOW)

    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      expect.stringContaining('FROM moderation_audit'),
      'COMMIT'
    ])
    expect(client.calls[1]?.text).toMatch(/role = 'moderator'\s+AND revoked_at IS NULL\s+FOR SHARE/u)
    expect(client.calls[1]?.values).toEqual([MODERATOR])
    expect(client.calls[2]?.text).toContain("'moderation-audit-export'")
    expect(client.calls[2]?.values).toEqual([BUCKET_HASH, 2, new Date(NOW)])
    expect(client.calls[2]?.values[0]).not.toBe(BUCKET_HASH)
    expect(client.calls[3]?.text).toContain('sequence > $1::bigint')
    expect(client.calls[3]?.text).toContain('ORDER BY moderation_audit.sequence ASC')
    expect(client.calls[3]?.text).toContain('LIMIT 51')
    expect(client.calls[3]?.text).not.toContain('actor_digest')
    expect(client.calls[3]?.values).toEqual(['7'])
    expect(result).toEqual({
      status: 'data',
      afterSequence: '7',
      nextCursor: null,
      items: [
        {
          sequence: '8',
          action: 'published',
          moderatorAddress: null,
          subjectId: 'subject-8',
          createdAt: NOW,
          details: { clientCreatedAt: NOW - 1_000 }
        },
        {
          sequence: '9',
          action: 'publish-rejected',
          moderatorAddress: null,
          subjectId: null,
          createdAt: NOW + 1,
          details: {
            clientCreatedAt: NOW - 999,
            reason: 'duplicate',
            requestedSubjectId: 'subject-9',
            duplicateOf: 'subject-8'
          }
        },
        {
          sequence: '10',
          action: 'reported',
          moderatorAddress: null,
          subjectId: 'subject-8',
          createdAt: NOW + 2,
          details: {
            clientCreatedAt: NOW - 998,
            reason: 'abuse',
            reportId: 'report-1',
            reportingSceneId: 'scene-a'
          }
        },
        {
          sequence: '11',
          action: 'quarantined',
          moderatorAddress: MODERATOR,
          subjectId: 'subject-8',
          createdAt: NOW + 3,
          details: { clientCreatedAt: NOW - 997, decisionId: 'decision-1', reason: 'Confirmed abuse' }
        }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('actorDigest')
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.status === 'data' && Object.isFrozen(result.items)).toBe(true)
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('uses the fifty-first row only as proof that another page exists', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => publishedRow(String(index + 1)))
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { result: rowsResult(rows) },
      { result: emptyResult() }
    ])

    const result = await repository(new ScriptedDatabase([client])).exportAudit(MODERATOR, '0', BUCKET_HASH, NOW)

    expect(result.status).toBe('data')
    if (result.status !== 'data') throw new Error('Expected audit data')
    expect(result.items).toHaveLength(50)
    expect(result.items.at(-1)?.sequence).toBe('50')
    expect(result.nextCursor).toBe('50')
    client.assertComplete()
  })

  it('does not return a continuation cursor for an exact fifty-row final page', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { result: rowsResult(Array.from({ length: 50 }, (_, index) => publishedRow(String(index + 1)))) },
      { result: emptyResult() }
    ])

    const result = await repository(new ScriptedDatabase([client])).exportAudit(MODERATOR, '0', BUCKET_HASH, NOW)

    expect(result.status).toBe('data')
    if (result.status !== 'data') throw new Error('Expected audit data')
    expect(result.items).toHaveLength(50)
    expect(result.nextCursor).toBeNull()
    client.assertComplete()
  })

  it('denies absent, analyst, and revoked roles before consuming rate', async () => {
    for (const rowCount of [0, 2]) {
      const roleResult = rowCount === 0 ? emptyResult() : rowsResult([{}, {}])
      const client = new ScriptedClient([{ result: emptyResult() }, { result: roleResult }, { result: emptyResult() }])

      await expect(
        repository(new ScriptedDatabase([client])).exportAudit(MODERATOR, '0', BUCKET_HASH, NOW)
      ).resolves.toEqual({ status: 'unauthorized' })
      expect(client.calls.map(({ text }) => text.trim())).toEqual([
        'BEGIN',
        expect.stringContaining('FROM actor_roles'),
        'ROLLBACK'
      ])
      client.assertComplete()
    }
  })

  it('rolls back without reading audit data when the dedicated bucket is full', async () => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: emptyResult() },
      { result: emptyResult() }
    ])

    await expect(
      repository(new ScriptedDatabase([client])).exportAudit(MODERATOR, '0', BUCKET_HASH, NOW)
    ).resolves.toEqual({ status: 'rate-limited' })
    expect(client.calls.map(({ text }) => text.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('FROM actor_roles'),
      expect.stringContaining('INSERT INTO rate_buckets'),
      'ROLLBACK'
    ])
    client.assertComplete()
  })

  it('validates actor, digest, timestamp, cursor, and configuration before connecting', async () => {
    const database = new ScriptedDatabase([])
    const audit = repository(database)

    expect(() => new ModerationAuditExportRepository(database, { auditExportPerHour: 0 })).toThrow(
      'auditExportPerHour must be between 1 and 100000'
    )
    await expect(audit.exportAudit('0xABC', '0', BUCKET_HASH, NOW)).rejects.toThrow(
      'Invalid moderation audit export actor address'
    )
    await expect(audit.exportAudit(MODERATOR, '0', Buffer.alloc(31), NOW)).rejects.toThrow(
      'Moderation audit export bucket hash must be 32 bytes'
    )
    await expect(audit.exportAudit(MODERATOR, '01', BUCKET_HASH, NOW)).rejects.toThrow(
      'Invalid moderation audit cursor'
    )
    await expect(audit.exportAudit(MODERATOR, '0', BUCKET_HASH, -1)).rejects.toThrow('Invalid current timestamp')
    expect(database.connectCount).toBe(0)
  })

  it.each([
    ['unexpected details', publishedRow('1', { details: { clientCreatedAt: NOW, extra: true } })],
    ['invalid sequence', publishedRow('01')],
    ['non-increasing sequence', publishedRow('0')],
    ['wrong actor shape', publishedRow('1', { moderatorAddress: MODERATOR })],
    ['wrong subject shape', publishedRow('1', { subjectId: null })],
    ['invalid timestamp', publishedRow('1', { createdAt: NOW })],
    [
      'invalid report reason',
      publishedRow('1', {
        action: 'reported',
        moderatorAddress: null,
        details: { clientCreatedAt: NOW, reason: 'spam', reportId: 'report-1', reportingSceneId: 'scene-a' }
      })
    ],
    ['unexpected action', publishedRow('1', { action: 'approved', details: { clientCreatedAt: NOW } })]
  ])('fails closed and rolls back malformed rows: %s', async (_label, row) => {
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { result: oneRow(row as DatabaseRow) },
      { result: emptyResult() }
    ])

    await expect(
      repository(new ScriptedDatabase([client])).exportAudit(MODERATOR, '0', BUCKET_HASH, NOW)
    ).rejects.toThrow('Invalid moderation audit export row')
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.releases).toEqual([undefined])
    client.assertComplete()
  })

  it('rolls back read failures and preserves both failures when rollback also fails', async () => {
    const readFailure = new Error('audit read failed')
    const rollbackFailure = new Error('rollback failed')
    const client = new ScriptedClient([
      { result: emptyResult() },
      { result: oneRow() },
      { result: oneRow({ request_count: 1 }) },
      { error: readFailure },
      { error: rollbackFailure }
    ])

    const failure = await repository(new ScriptedDatabase([client]))
      .exportAudit(MODERATOR, '0', BUCKET_HASH, NOW)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([readFailure, rollbackFailure])
    expect(client.releases).toEqual([rollbackFailure])
    client.assertComplete()
  })
})
