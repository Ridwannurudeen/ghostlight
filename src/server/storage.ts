import { Storage } from '@dcl/sdk/server'
import { FLUSH_SECONDS } from '../shared/config'

export const RECENT_VISITORS_KEY = 'gc:v1:recentVisitors'
export const PLAYER_STATS_KEY = 'gc:v1:stats'

export function charadeKey(id: string) {
  return `gc:v1:charade:${id}`
}

export function indexKey(day: string) {
  return `gc:v1:index:${day}`
}

export function boardsKey(day: string) {
  return `gc:v1:boards:${day}`
}

export function decoderAggregateKey(day: string) {
  return `gc:v1:decoders:${day}`
}

type GetValuesResult = {
  data: Array<{ key: string; value: unknown }>
  pagination: { offset: number; total: number }
}

export type StoragePort = {
  get(key: string, options?: { fresh?: boolean }): Promise<unknown | null>
  getValues(options?: { prefix?: string; limit?: number; offset?: number }): Promise<GetValuesResult>
  set(key: string, value: unknown): Promise<boolean>
  player: {
    get(address: string, key: string, options?: { fresh?: boolean }): Promise<unknown | null>
    getValues(
      address: string,
      options?: { prefix?: string; limit?: number; offset?: number }
    ): Promise<GetValuesResult>
    set(address: string, key: string, value: unknown): Promise<boolean>
  }
}

type DirtySceneWrite = {
  scope: 'scene'
  key: string
  serialized: string
}

type DirtyPlayerWrite = {
  scope: 'player'
  address: string
  key: string
  serialized: string
}

type DirtyWrite = DirtySceneWrite | DirtyPlayerWrite

export type FlushResult = {
  attempted: number
  saved: number
  failed: number
  remaining: number
}

export type StorageRepository = ReturnType<typeof createStorageRepository>

export class StorageUnavailableError extends Error {
  constructor(readonly keys: string[]) {
    super(`Storage unavailable for: ${keys.join(', ')}`)
    this.name = 'StorageUnavailableError'
  }
}

const MAX_CONCURRENT_WRITES = 8
const MAX_CONCURRENT_HOST_CALLS = 32
const MAX_READ_ATTEMPTS = 3
const MAX_CHECKPOINT_ATTEMPTS = 3

function hasValidVersion(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('v' in value)) return true
  return typeof (value as { v?: unknown }).v === 'number'
}

export function createStorageRepository(storage: StoragePort = Storage) {
  const dirty = new Map<string, DirtyWrite>()
  let flushPromise: Promise<FlushResult> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let activeHostCalls = 0
  const waitingHostCalls: Array<() => void> = []

  async function hostCall<T>(call: () => Promise<T>) {
    if (activeHostCalls >= MAX_CONCURRENT_HOST_CALLS) {
      await new Promise<void>((resolve) => waitingHostCalls.push(resolve))
    }
    activeHostCalls += 1
    try {
      return await call()
    } finally {
      activeHostCalls -= 1
      waitingHostCalls.shift()?.()
    }
  }

  async function confirmSceneValue(key: string) {
    const result = await hostCall(() => storage.getValues({ prefix: key, limit: 2 }))
    return result.data.find((entry) => entry.key === key)?.value ?? null
  }

  async function confirmPlayerValue(address: string, key: string) {
    const result = await hostCall(() => storage.player.getValues(address, { prefix: key, limit: 2 }))
    return result.data.find((entry) => entry.key === key)?.value ?? null
  }

  async function readRaw(read: (fresh: boolean) => Promise<unknown | null>, confirm: () => Promise<unknown | null>) {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      try {
        const raw = await hostCall(() => read(attempt > 0))
        if (raw !== null) return { status: 'found' as const, raw }
      } catch {
        // A separate authoritative listing below decides missing versus unavailable.
      }
    }

    try {
      const raw = await confirm()
      return raw === null ? { status: 'missing' as const } : { status: 'found' as const, raw }
    } catch {
      return { status: 'unavailable' as const }
    }
  }

  function parseRead<T>(key: string, result: Awaited<ReturnType<typeof readRaw>>, fallback: T): T {
    if (result.status === 'missing') return fallback
    if (result.status === 'unavailable') throw new StorageUnavailableError([key])
    if (typeof result.raw !== 'string') throw new StorageUnavailableError([key])

    try {
      const value: unknown = JSON.parse(result.raw)
      if (!hasValidVersion(value)) throw new StorageUnavailableError([key])
      return value as T
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw error
      throw new StorageUnavailableError([key])
    }
  }

  async function loadJSON<T>(key: string, fallback: T): Promise<T> {
    const result = await readRaw(
      (fresh) => storage.get(key, fresh ? { fresh: true } : undefined),
      () => confirmSceneValue(key)
    )
    return parseRead(key, result, fallback)
  }

  async function loadPlayerJSON<T>(address: string, key: string, fallback: T): Promise<T> {
    const result = await readRaw(
      (fresh) => storage.player.get(address, key, fresh ? { fresh: true } : undefined),
      () => confirmPlayerValue(address, key)
    )
    return parseRead(`player:${address}:${key}`, result, fallback)
  }

  function markDirty(key: string, value: unknown) {
    dirty.set(`scene:${key}`, { scope: 'scene', key, serialized: JSON.stringify(value) })
  }

  function markPlayerDirty(address: string, key: string, value: unknown) {
    dirty.set(`player:${address}:${key}`, {
      scope: 'player',
      address,
      key,
      serialized: JSON.stringify(value)
    })
  }

  async function write(entry: DirtyWrite) {
    try {
      if (entry.scope === 'scene') return await hostCall(() => storage.set(entry.key, entry.serialized))
      return await hostCall(() => storage.player.set(entry.address, entry.key, entry.serialized))
    } catch {
      return false
    }
  }

  async function runFlush(): Promise<FlushResult> {
    const pending = [...dirty.entries()]
    let saved = 0
    let failed = 0

    for (let offset = 0; offset < pending.length; offset += MAX_CONCURRENT_WRITES) {
      const batch = pending.slice(offset, offset + MAX_CONCURRENT_WRITES)
      const results = await Promise.all(batch.map(([, entry]) => write(entry)))

      results.forEach((ok, index) => {
        const [dirtyKey, attempted] = batch[index]
        if (ok) {
          saved += 1
          const current = dirty.get(dirtyKey)
          if (current?.serialized === attempted.serialized) dirty.delete(dirtyKey)
        } else {
          failed += 1
        }
      })
    }

    const result = { attempted: pending.length, saved, failed, remaining: dirty.size }
    console.log(
      `[storage] flush attempted=${result.attempted} saved=${result.saved} failed=${result.failed} remaining=${result.remaining}`
    )
    return result
  }

  function flush(): Promise<FlushResult> {
    if (flushPromise) return flushPromise
    flushPromise = runFlush().finally(() => {
      flushPromise = null
    })
    return flushPromise
  }

  async function flushNow() {
    let result: FlushResult = { attempted: 0, saved: 0, failed: 0, remaining: dirty.size }
    for (let attempt = 0; attempt < MAX_CHECKPOINT_ATTEMPTS && dirty.size > 0; attempt += 1) {
      result = await flush()
    }
    if (dirty.size > 0) throw new StorageUnavailableError([...dirty.keys()])
    return result
  }

  function startFlushLoop() {
    if (flushTimer !== null) return () => stopFlushLoop()
    flushTimer = setInterval(() => void flush(), FLUSH_SECONDS * 1000)
    return () => stopFlushLoop()
  }

  function stopFlushLoop() {
    if (flushTimer === null) return
    clearInterval(flushTimer)
    flushTimer = null
  }

  return {
    loadJSON,
    loadPlayerJSON,
    markDirty,
    markPlayerDirty,
    flush,
    flushNow,
    startFlushLoop,
    stopFlushLoop,
    getDirtyKeys: () => [...dirty.keys()]
  }
}

const repository = createStorageRepository()

export const loadJSON = repository.loadJSON
export const loadPlayerJSON = repository.loadPlayerJSON
export const markDirty = repository.markDirty
export const markPlayerDirty = repository.markPlayerDirty
export const flushNow = repository.flushNow
export const startFlushLoop = repository.startFlushLoop
