import { beforeEach, describe, expect, it, vi } from 'vitest'

const postgres = vi.hoisted(() => ({
  constructPool: vi.fn(),
  endPool: vi.fn(async () => {})
}))

vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) {
      postgres.constructPool(options)
    }

    async end() {
      await postgres.endPool()
    }
  }
}))

import { createDatabase } from '../src/database.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PostgreSQL pool configuration', () => {
  it('bounds acquisition, server statement execution, and client query completion', async () => {
    const databaseUrl = 'postgresql://ghostlight:password@db.internal:5432/ghostlight'
    const database = createDatabase(databaseUrl)

    expect(postgres.constructPool).toHaveBeenCalledOnce()
    expect(postgres.constructPool).toHaveBeenCalledWith({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 4_000,
      query_timeout: 4_500
    })

    await database.close()
    expect(postgres.endPool).toHaveBeenCalledOnce()
  })
})
