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

export type StoragePort = {
  get(key: string, options?: { fresh?: boolean }): Promise<unknown | null>
  set(key: string, value: unknown): Promise<boolean>
  player: {
    get(address: string, key: string, options?: { fresh?: boolean }): Promise<unknown | null>
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

const MAX_CONCURRENT_WRITES = 8

function hasValidVersion(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('v' in value)) return true
  return typeof (value as { v?: unknown }).v === 'number'
}

function parseStoredJSON<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback

  try {
    const value: unknown = JSON.parse(raw)
    return hasValidVersion(value) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

export function createStorageRepository(storage: StoragePort = Storage) {
  const dirty = new Map<string, DirtyWrite>()
  let flushPromise: Promise<FlushResult> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null

  async function loadJSON<T>(key: string, fallback: T): Promise<T> {
    try {
      return parseStoredJSON(await storage.get(key), fallback)
    } catch {
      return fallback
    }
  }

  async function loadPlayerJSON<T>(address: string, key: string, fallback: T): Promise<T> {
    try {
      return parseStoredJSON(await storage.player.get(address, key), fallback)
    } catch {
      return fallback
    }
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
      if (entry.scope === 'scene') return await storage.set(entry.key, entry.serialized)
      return await storage.player.set(entry.address, entry.key, entry.serialized)
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
    const joinedActiveFlush = flushPromise !== null
    const result = await flush()
    return joinedActiveFlush && dirty.size > 0 ? flush() : result
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
