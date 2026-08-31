import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLUSH_SECONDS } from '../src/shared/config'
import { GhostlightState } from '../src/server/state'
import {
  MAX_CHECKPOINT_FLUSHES,
  MAX_DIRTY_ENTRIES,
  MAX_FLUSH_WRITES,
  MAX_STORAGE_VALUE_BYTES,
  PLAYER_STATS_KEY,
  RECENT_VISITORS_KEY,
  StorageCapacityError,
  StorageCorruptError,
  StorageUnavailableError,
  boardsKey,
  charadeKey,
  createStorageRepository,
  indexKey
} from '../src/server/storage'
import type { StoragePort } from '../src/server/storage'
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
  it('treats SDK-style swallowed point and listing failures as unavailable', async () => {
    const empty = { data: [], pagination: { offset: 0, total: 0 } }
    const swallowedFailures: StoragePort = {
      get: async () => null,
      getValues: async () => empty,
      set: async () => false,
      player: {
        get: async () => null,
        getValues: async () => empty,
        set: async () => false
      }
    }
    const repository = createStorageRepository(swallowedFailures)

    await expect(repository.loadJSON('existing-but-unreadable', null)).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(repository.loadPlayerJSON('player', 'existing-but-unreadable', null)).rejects.toBeInstanceOf(
      StorageUnavailableError
    )
  })

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
    await expect(repository.loadJSON('malformed', fallback)).rejects.toBeInstanceOf(StorageCorruptError)
    await expect(repository.loadJSON('non-string', fallback)).rejects.toBeInstanceOf(StorageCorruptError)
    await expect(repository.loadJSON('invalid-version', fallback)).rejects.toBeInstanceOf(StorageCorruptError)
    await expect(repository.loadJSON('throws', fallback)).resolves.toBe(fallback)
  })

  it('uses the same defensive behavior for player storage', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    storage.putPlayerJSON('player', 'valid', { v: 1, score: 7 })
    storage.players.get('player')!.set('malformed', ']')
    storage.playerGetErrors.add('player:throws')

    await expect(repository.loadPlayerJSON('player', 'valid', null)).resolves.toEqual({ v: 1, score: 7 })
    await expect(repository.loadPlayerJSON('player', 'malformed', null)).rejects.toBeInstanceOf(StorageCorruptError)
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
    await vi.waitFor(() => expect(storage.activeHostCalls).toBe(24))
    expect(storage.maxActiveHostCalls).toBe(24)
    gate.resolve()

    await expect(Promise.all(reads)).resolves.toEqual(Array.from({ length: 41 }, () => null))
    expect(storage.maxActiveHostCalls).toBe(24)
  })

  it('reserves a released permit for the awakened waiter before admitting a new arrival', async () => {
    const calls: Array<ReturnType<typeof deferred<unknown | null>>> = []
    const callPromises: Array<Promise<unknown | null>> = []
    let releaseNewCalls = false
    let active = 0
    let maxActive = 0
    const storage: StoragePort = {
      get: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        if (releaseNewCalls) {
          active -= 1
          return JSON.stringify({ v: 1 })
        }
        const call = deferred<unknown | null>()
        calls.push(call)
        const promise = call.promise.then((value) => {
          active -= 1
          return value
        })
        callPromises.push(promise)
        return promise
      },
      getValues: async () => ({ data: [], pagination: { offset: 0, total: 0 } }),
      set: async () => true,
      player: {
        get: async () => null,
        getValues: async () => ({ data: [], pagination: { offset: 0, total: 0 } }),
        set: async () => true
      }
    }
    const repository = createStorageRepository(storage)
    const initial = Array.from({ length: 32 }, (_, index) => repository.loadJSON(`initial-${index}`, null))
    const waiting = repository.loadJSON('waiting', null)
    let newcomer: Promise<unknown> | null = null
    callPromises[0].then(() => {
      newcomer = repository.loadJSON('newcomer', null)
    })

    calls[0].resolve(JSON.stringify({ v: 1 }))
    await vi.waitFor(() => expect(newcomer).not.toBeNull())
    expect(maxActive).toBe(24)

    releaseNewCalls = true
    calls.slice(1).forEach((call) => call.resolve(JSON.stringify({ v: 1 })))
    await expect(Promise.all([...initial, waiting, newcomer!])).resolves.toHaveLength(34)
    expect(maxActive).toBe(24)
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

  it('distinguishes corrupt and oversized stored values from transport failures', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    storage.scene.set('malformed', '{')
    storage.scene.set('oversized', `"${'x'.repeat(140_000)}"`)

    await expect(repository.loadJSON('malformed', null)).rejects.toBeInstanceOf(StorageCorruptError)
    await expect(repository.loadJSON('oversized', null)).rejects.toBeInstanceOf(StorageCorruptError)
  })

  it('bounds scene and player reads when the host never settles', async () => {
    vi.useFakeTimers()
    try {
      const storage = new FakeStorage()
      const repository = createStorageRepository(storage)
      storage.readGate = new Promise<void>(() => undefined)
      const sceneRead = repository.loadJSON('hung-scene', null)
      const playerRead = repository.loadPlayerJSON('player', 'hung-player', null)
      const sceneFailure = expect(sceneRead).rejects.toBeInstanceOf(StorageUnavailableError)
      const playerFailure = expect(playerRead).rejects.toBeInstanceOf(StorageUnavailableError)

      await vi.advanceTimersByTimeAsync(10_000)

      await sceneFailure
      await playerFailure
    } finally {
      vi.useRealTimers()
    }
  })

  it('reserves bounded host capacity for recovery after primary host calls never settle', async () => {
    vi.useFakeTimers()
    try {
      const storage = new FakeStorage()
      const repository = createStorageRepository(storage)
      storage.readGate = new Promise<void>(() => undefined)
      const primary = Promise.allSettled(
        Array.from({ length: 24 }, (_, index) => repository.loadJSON(`primary-stuck-${index}`, null))
      )

      await vi.advanceTimersByTimeAsync(4_001)

      expect((await primary).every((result) => result.status === 'rejected')).toBe(true)
      expect(storage.activeHostCalls).toBe(24)
      expect(storage.maxActiveHostCalls).toBe(24)
      storage.readGate = null
      const restored = new GhostlightState(repository, () => 0)

      await restored.hydrate()

      expect(restored.isReadOnly).toBe(false)
      expect(storage.activeHostCalls).toBe(24)
      expect(storage.maxActiveHostCalls).toBe(32)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed at 32 unresolved host calls when the recovery reserve also saturates', async () => {
    vi.useFakeTimers()
    try {
      let recover = false
      let started = 0
      let active = 0
      let maxActive = 0
      const hostRead = () => {
        started += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        if (!recover) return new Promise<never>(() => undefined)
        return Promise.resolve(JSON.stringify({ v: 1 })).finally(() => {
          active -= 1
        })
      }
      const storage: StoragePort = {
        get: hostRead,
        getValues: hostRead,
        set: async () => true,
        player: {
          get: async () => null,
          getValues: async () => ({ data: [], pagination: { offset: 0, total: 0 } }),
          set: async () => true
        }
      }
      const repository = createStorageRepository(storage)
      const primary = Promise.allSettled(
        Array.from({ length: 24 }, (_, index) => repository.loadJSON(`circuit-primary-${index}`, null))
      )

      await vi.advanceTimersByTimeAsync(4_001)
      expect((await primary).every((result) => result.status === 'rejected')).toBe(true)
      const reserve = Promise.allSettled(
        Array.from({ length: 8 }, (_, index) => repository.loadJSON(`circuit-reserve-${index}`, null))
      )
      await vi.advanceTimersByTimeAsync(4_001)

      expect((await reserve).every((result) => result.status === 'rejected')).toBe(true)
      expect(started).toBe(32)
      expect(maxActive).toBe(32)

      recover = true
      const blockedRecovery = repository.loadJSON('circuit-open', null)
      const blockedFailure = expect(blockedRecovery).rejects.toBeInstanceOf(StorageUnavailableError)
      await vi.advanceTimersByTimeAsync(4_001)
      await blockedFailure
      expect(started).toBe(32)
      expect(maxActive).toBe(32)
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves directly from a timed-out point read to authoritative listing', async () => {
    vi.useFakeTimers()
    try {
      const pointRead = new Promise<never>(() => undefined)
      const get = vi.fn(async () => pointRead)
      const getValues = vi.fn(async () => ({
        data: [{ key: 'listed-after-timeout', value: JSON.stringify({ v: 1 }) }],
        pagination: { offset: 0, total: 1 }
      }))
      const storage: StoragePort = {
        get,
        getValues,
        set: async () => true,
        player: {
          get: async () => null,
          getValues: async () => ({ data: [], pagination: { offset: 0, total: 0 } }),
          set: async () => true
        }
      }
      const repository = createStorageRepository(storage)
      const read = repository.loadJSON('listed-after-timeout', null)
      const recovered = expect(read).resolves.toEqual({ v: 1 })

      await vi.advanceTimersByTimeAsync(8_000)

      await recovered
      expect(get).toHaveBeenCalledOnce()
      expect(getValues).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers a missing read by write-probing health when the SDK health get remains in flight', async () => {
    vi.useFakeTimers()
    try {
      const values = new Map<string, unknown>()
      const pending = new Promise<never>(() => undefined)
      const storage: StoragePort = {
        get: async (key) => (values.has(key) ? values.get(key)! : pending),
        getValues: async () => ({ data: [], pagination: { offset: 0, total: 0 } }),
        set: async (key, value) => {
          values.set(key, value)
          return true
        },
        player: {
          get: async () => null,
          getValues: async () => ({ data: [], pagination: { offset: 0, total: 0 } }),
          set: async () => true
        }
      }
      const repository = createStorageRepository(storage)
      const fallback = { v: 1 }
      const read = repository.loadJSON('missing-after-stall', fallback)
      const recovered = expect(read).resolves.toBe(fallback)

      await vi.advanceTimersByTimeAsync(9_000)

      await recovered
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('immediate durable writes', () => {
  it('persists a versioned value immediately and retries rejected host writes', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    storage.sceneWriteOutcomes.push(false, true)

    await repository.saveJSONNow('gc:v1:journal', { v: 1, active: null })

    expect(storage.writes.map((write) => write.key)).toEqual(['gc:v1:journal', 'gc:v1:journal'])
    expect(storage.readJSON('gc:v1:journal')).toEqual({ v: 1, active: null })
    expect(repository.getDirtyKeys()).toEqual([])
  })

  it('fails without staging an oversized immediate value', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)

    await expect(repository.saveJSONNow('too-large', 'x'.repeat(MAX_STORAGE_VALUE_BYTES))).rejects.toBeInstanceOf(
      StorageCapacityError
    )

    expect(storage.writes).toEqual([])
    expect(repository.getDirtyKeys()).toEqual([])
  })

  it('fails closed after three rejected immediate writes', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    storage.sceneWriteOutcomes.push(false, false, false)

    await expect(repository.saveJSONNow('required-journal', { v: 1 })).rejects.toMatchObject({
      keys: ['scene:required-journal']
    })
    expect(storage.writes).toHaveLength(3)
  })

  it('bounds an immediate durable write when the host never settles', async () => {
    vi.useFakeTimers()
    try {
      const storage = new FakeStorage()
      const repository = createStorageRepository(storage)
      storage.writeGate = new Promise<void>(() => undefined)
      const write = repository.saveJSONNow('hung-journal', { v: 1 })
      const failure = expect(write).rejects.toMatchObject({ keys: ['scene:hung-journal'] })

      await vi.advanceTimersByTimeAsync(7_000)

      await failure
      expect(storage.writes).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
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

  it('rejects dirty writes atomically before the entry budget is exceeded', () => {
    const repository = createStorageRepository(new FakeStorage())
    for (let index = 0; index < MAX_DIRTY_ENTRIES - 1; index += 1) {
      repository.markDirty(`key-${index}`, { index })
    }

    expect(() =>
      repository.markDirtyBatch([
        { key: 'last-valid', value: { valid: true } },
        { key: 'over-budget', value: { valid: false } }
      ])
    ).toThrow(StorageCapacityError)
    expect(repository.getDirtyKeys()).toHaveLength(MAX_DIRTY_ENTRIES - 1)
    expect(repository.getDirtyKeys()).not.toContain('scene:last-valid')
  })

  it('accounts for replacement bytes without consuming another dirty entry', () => {
    const repository = createStorageRepository(new FakeStorage())
    repository.markDirty('same', { revision: 1 })
    const firstBytes = repository.getDirtyBytes()

    repository.markDirty('same', { revision: 2 })

    expect(repository.getDirtyKeys()).toEqual(['scene:same'])
    expect(repository.getDirtyBytes()).toBe(firstBytes)
  })

  it('rejects a dirty value that the read path would later reject as oversized', () => {
    const repository = createStorageRepository(new FakeStorage())

    expect(() => repository.markDirty('oversized', 'x'.repeat(140_000))).toThrow(StorageCapacityError)
    expect(repository.getDirtyKeys()).toEqual([])
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

  it('bounds background flush work while preserving the remaining queue', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    for (let index = 0; index < MAX_FLUSH_WRITES + 5; index += 1) {
      repository.markDirty(`bounded-${index}`, { index })
    }

    await expect(repository.flush()).resolves.toMatchObject({
      attempted: MAX_FLUSH_WRITES,
      saved: MAX_FLUSH_WRITES,
      failed: 0,
      remaining: 5
    })
    expect(storage.writes).toHaveLength(MAX_FLUSH_WRITES)
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

  it('bounds checkpoint work even when each batch makes too little progress', async () => {
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    for (let index = 0; index < MAX_DIRTY_ENTRIES; index += 1) {
      repository.markDirty(`slow-${index}`, { index })
    }
    for (let batch = 0; batch < MAX_CHECKPOINT_FLUSHES + 2; batch += 1) {
      storage.sceneWriteOutcomes.push(true, ...Array.from({ length: MAX_FLUSH_WRITES - 1 }, () => false))
    }

    await expect(repository.flushNow()).rejects.toBeInstanceOf(StorageUnavailableError)
    expect(storage.writes.length).toBeLessThanOrEqual(MAX_CHECKPOINT_FLUSHES * MAX_FLUSH_WRITES)
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
