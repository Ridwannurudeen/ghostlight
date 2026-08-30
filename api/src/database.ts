import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'

export type DatabaseValue = string | number | boolean | Date | Buffer | null | readonly DatabaseValue[]
export type DatabaseRow = Readonly<Record<string, unknown>>
export type DatabaseQueryResult = Readonly<{
  rowCount: number | null
  rows: readonly DatabaseRow[]
}>

export interface DatabaseClient {
  query(text: string, values?: readonly DatabaseValue[]): Promise<DatabaseQueryResult>
  release(error?: Error | boolean): void
}

export interface DatabaseConnectionSource {
  connect(): Promise<DatabaseClient>
}

export interface DatabasePool extends DatabaseConnectionSource {
  query(text: string, values?: readonly DatabaseValue[]): Promise<DatabaseQueryResult>
  end(): Promise<void>
}

const MIGRATION_LOCK_NAMESPACE = 1_195_912_019
const MIGRATION_LOCK_ID = 1
const CONNECTION_TIMEOUT_MILLISECONDS = 5_000
const STATEMENT_TIMEOUT_MILLISECONDS = 4_000
const QUERY_TIMEOUT_MILLISECONDS = 4_500
const migrationPaths = Object.freeze([
  fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url)),
  fileURLToPath(new URL('../migrations/002_audit_export.sql', import.meta.url))
])

function resultOf(result: Readonly<{ rowCount: number | null; rows: readonly QueryResultRow[] }>): DatabaseQueryResult {
  return { rowCount: result.rowCount, rows: result.rows as readonly DatabaseRow[] }
}

class PostgresClientAdapter implements DatabaseClient {
  constructor(private readonly client: PoolClient) {}

  async query(text: string, values: readonly DatabaseValue[] = []) {
    return resultOf(await this.client.query(text, [...values]))
  }

  release(error?: Error | boolean) {
    this.client.release(error)
  }
}

class PostgresPoolAdapter implements DatabasePool {
  constructor(private readonly pool: Pool) {}

  async connect() {
    return new PostgresClientAdapter(await this.pool.connect())
  }

  async query(text: string, values: readonly DatabaseValue[] = []) {
    return resultOf(await this.pool.query(text, [...values]))
  }

  async end() {
    await this.pool.end()
  }
}

function combineFailures(primary: unknown, secondary: unknown, message: string) {
  return new AggregateError([primary, secondary], message)
}

export class Database implements DatabaseConnectionSource {
  constructor(private readonly pool: DatabasePool) {}

  async connect() {
    return this.pool.connect()
  }

  async migrate() {
    const migrations = await Promise.all(migrationPaths.map((migrationPath) => readFile(migrationPath, 'utf8')))
    const client = await this.pool.connect()
    let locked = false
    let failure: unknown
    let releaseError: Error | undefined

    try {
      await client.query('SELECT pg_advisory_lock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID])
      locked = true
      try {
        for (const migration of migrations) await client.query(migration)
      } catch (migrationError) {
        failure = migrationError
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : new Error('Migration rollback failed')
          failure = combineFailures(migrationError, rollbackError, 'Migration and rollback failed')
        }
      }
    } catch (lockError) {
      failure = lockError
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID])
        } catch (unlockError) {
          releaseError = unlockError instanceof Error ? unlockError : new Error('Migration advisory unlock failed')
          failure =
            failure === undefined
              ? unlockError
              : combineFailures(failure, unlockError, 'Migration and advisory unlock failed')
        }
      }
      client.release(releaseError)
    }

    if (failure !== undefined) throw failure
  }

  async seedSceneAllowlist(sceneIds: readonly string[], catalystOrigin: string) {
    await this.pool.query(
      `INSERT INTO scene_allowlist (scene_id, catalyst_origin)
       SELECT configured.scene_id, $2
       FROM unnest($1::text[]) AS configured(scene_id)
       ON CONFLICT (scene_id)
       DO UPDATE SET catalyst_origin = EXCLUDED.catalyst_origin`,
      [sceneIds, catalystOrigin]
    )
  }

  async ping() {
    await this.pool.query('SELECT 1')
  }

  async close() {
    await this.pool.end()
  }
}

export function createDatabase(databaseUrl: string) {
  return new Database(
    new PostgresPoolAdapter(
      new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
        statement_timeout: STATEMENT_TIMEOUT_MILLISECONDS,
        query_timeout: QUERY_TIMEOUT_MILLISECONDS
      })
    )
  )
}
