import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLUSH_SECONDS } from '../src/shared/config'
import {
  PLAYER_STATS_KEY,
  RECENT_VISITORS_KEY,
  StorageUnavailableError,
  boardsKey,
  charadeKey,
  createStorageRepository,
  indexKey
} from '../src/server/storage'
import { FakeStorage, deferred } from './test-helpers'

vi.mock('@dcl/sdk/server', () => ({
  Storage: {
    get: async () => null,
    set: async () => true,
    player: {
      get: async () => null,
      set: async () => true
    }
  }
}))

describe('storage keys', () => {
  it('uses the versioned key schema', () => {
    expect(charadeKey('abc')).toBe('gc:v1:charade:abc')
    expect(indexKey('2026-08-23')).toBe('gc:v1:index:2026-08-23')
    expect(boardsKey('2026-08-23')).toBe('gc:v1:boards:2026-08-23')
    expect(RECENT_VISITORS_KEY).toBe('gc:v1:recentVisitors')
    expect(PLAYER_STATS_KEY).toBe('gc:v1:stats')
  })
})

describe('storage reads', () => {
  it('parses confirmed values, falls back only for confirmed missing keys, and fails closed on corrupt data', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const fallback = { v: 1, answer: 0 }
    storage.putJSON('valid', { v: 1, answer: 42 })
    storage.scene.set('malformed', '{')
    storage.scene.set('non-string', { v: 1, answer: 3 })
    storage.putJSON('invalid-version', { v: 'one', answer: 4 })
    storage.getErrors.add('throws')

    await expect(repository.loadJSON('valid', fallback)).resolves.toEqual({ v: 1, answer: 42 })
    await expect(repository.loadJSON('missing', fallback)).resolves.toBe(fallback)
    await expect(repository.loadJSON('malformed', fallback)).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(repository.loadJSON('non-string', fallback)).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(repository.loadJSON('invalid-version', fallback)).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(repository.loadJSON('throws', fallback)).resolves.toBe(fallback)
  })

  it('uses the same defensive behavior for player storage', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    storage.putPlayerJSON('player', 'valid', { v: 1, score: 7 })
    storage.players.get('player')!.set('malformed', ']')
    storage.playerGetErrors.add('player:throws')

    await expect(repository.loadPlayerJSON('player', 'valid', null)).resolves.toEqual({ v: 1, score: 7 })
    await expect(repository.loadPlayerJSON('player', 'malformed', null)).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(repository.loadPlayerJSON('player', 'throws', null)).resolves.toBeNull()
  })

  it('shares one below-40 host-call semaphore across concurrent player reads', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const gate = deferred<void>()
    storage.readGate = gate.promise

    const reads = Array.from({ length: 41 }, (_, index) =>
      repository.loadPlayerJSON(`player-${index}`, PLAYER_STATS_KEY, null)
    )
    await vi.waitFor(() => expect(storage.activeHostCalls).toBe(32))
    expect(storage.maxActiveHostCalls).toBe(32)
    gate.resolve()

    await expect(Promise.all(reads)).resolves.toEqual(Array.from({ length: 41 }, () => null))
    expect(storage.maxActiveHostCalls).toBe(32)
  })

  it('fails closed when both point reads and authoritative listings are unavailable', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    storage.getErrors.add('ambiguous')
    storage.getValuesErrors.add('ambiguous')
    storage.playerGetErrors.add('player:ambiguous')
    storage.playerGetValuesErrors.add('player')

    await expect(repository.loadJSON('ambiguous', null)).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(repository.loadPlayerJSON('player', 'ambiguous', null)).rejects.toBeInstanceOf(StorageUnavailableError)
    expect(storage.sceneGets.filter((key) => key === 'ambiguous')).toHaveLength(3)
    expect(storage.playerGets.filter((call) => call.key === 'ambiguous')).toHaveLength(3)
  })
})

describe('storage flushes', () => {
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    log.mockRestore()
  })

  it('keeps false and throwing writes dirty, then saves both on retry', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    storage.sceneWriteOutcomes.push(false, new Error('host rejected'))
    repository.markDirty('false-key', { value: 1 })
    repository.markDirty('throw-key', { value: 2 })

    await expect(repository.flush()).resolves.toEqual({ attempted: 2, saved: 0, failed: 2, remaining: 2 })
    expect(repository.getDirtyKeys()).toEqual(['scene:false-key', 'scene:throw-key'])

    await expect(repository.flush()).resolves.toEqual({ attempted: 2, saved: 2, failed: 0, remaining: 0 })
    expect(storage.readJSON('false-key')).toEqual({ value: 1 })
    expect(storage.readJSON('throw-key')).toEqual({ value: 2 })
  })

  it('retains a newer value marked while the older value is in flight', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const gate = deferred<void>()
    storage.writeGate = gate.promise
    repository.markDirty('shared-key', { revision: 1 })

    const firstFlush = repository.flush()
    expect(storage.writes).toHaveLength(1)
    repository.markDirty('shared-key', { revision: 2 })
    gate.resolve()

    await expect(firstFlush).resolves.toEqual({ attempted: 1, saved: 1, failed: 0, remaining: 1 })
    expect(storage.readJSON('shared-key')).toEqual({ revision: 1 })
    expect(repository.getDirtyKeys()).toEqual(['scene:shared-key'])

    await repository.flush()
    expect(storage.readJSON('shared-key')).toEqual({ revision: 2 })
    expect(repository.getDirtyKeys()).toEqual([])
  })

  it('coalesces concurrent flush calls and flushNow retries dirt left by the joined flush', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const gate = deferred<void>()
    storage.writeGate = gate.promise
    storage.sceneWriteOutcomes.push(false, true)
    repository.markDirty('retry-key', { saved: true })

    const activeFlush = repository.flush()
    const sameFlush = repository.flush()
    const checkpoint = repository.flushNow()
    expect(sameFlush).toBe(activeFlush)
    expect(storage.writes).toHaveLength(1)
    gate.resolve()

    await activeFlush
    await checkpoint
    expect(storage.writes).toHaveLength(2)
    expect(storage.readJSON('retry-key')).toEqual({ saved: true })
    expect(repository.getDirtyKeys()).toEqual([])
  })

  it('runs no more than eight writes concurrently', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const gate = deferred<void>()
    storage.writeGate = gate.promise
    for (let index = 0; index < 19; index += 1) repository.markDirty(`key-${index}`, { index })

    const flush = repository.flush()
    expect(storage.writes).toHaveLength(8)
    expect(storage.activeWrites).toBe(8)
    gate.resolve()

    await expect(flush).resolves.toEqual({ attempted: 19, saved: 19, failed: 0, remaining: 0 })
    expect(storage.maxActiveWrites).toBe(8)
  })

  it('serializes and flushes player-scoped writes', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    repository.markPlayerDirty('0xplayer', PLAYER_STATS_KEY, { v: 1, decoded: 3 })

    await repository.flush()

    expect(storage.readPlayerJSON('0xplayer', PLAYER_STATS_KEY)).toEqual({ v: 1, decoded: 3 })
    expect(storage.writes[0]).toMatchObject({ scope: 'player', address: '0xplayer', key: PLAYER_STATS_KEY })
  })

  it('retries a checkpoint three times and rejects while required writes remain dirty', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    storage.sceneWriteOutcomes.push(false, false, false)
    repository.markDirty('required', { value: 1 })

    await expect(repository.flushNow()).rejects.toMatchObject({ keys: ['scene:required'] })
    expect(storage.writes).toHaveLength(3)
    expect(repository.getDirtyKeys()).toEqual(['scene:required'])
  })
})

describe('storage flush loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('flushes on the configured interval and does not create duplicate timers', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    repository.markDirty('timed', { value: 1 })
    const stopFirst = repository.startFlushLoop()
    const stopSecond = repository.startFlushLoop()

    await vi.advanceTimersByTimeAsync(FLUSH_SECONDS * 1000)

    expect(storage.writes).toHaveLength(1)
    expect(storage.readJSON('timed')).toEqual({ value: 1 })
    stopSecond()
    repository.markDirty('after-stop', { value: 2 })
    await vi.advanceTimersByTimeAsync(FLUSH_SECONDS * 1000)
    expect(storage.writes).toHaveLength(1)
    stopFirst()
  })
})
