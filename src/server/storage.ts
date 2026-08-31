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
    getValues(address: string, options?: { prefix?: string; limit?: number; offset?: number }): Promise<GetValuesResult>
    set(address: string, key: string, value: unknown): Promise<boolean>
  }
}

type DirtySceneWrite = {
  scope: 'scene'
  key: string
  serialized: string
  bytes: number
}

type DirtyPlayerWrite = {
  scope: 'player'
  address: string
  key: string
  serialized: string
  bytes: number
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

export class StorageCorruptError extends Error {
  constructor(readonly keys: string[]) {
    super(`Storage contains invalid data for: ${keys.join(', ')}`)
    this.name = 'StorageCorruptError'
  }
}

export class StorageCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageCapacityError'
  }
}

const MAX_CONCURRENT_WRITES = 8
const MAX_CONCURRENT_HOST_CALLS = 32
const RECOVERY_HOST_CALL_RESERVE = 8
const MAX_PRIMARY_HOST_CALLS = MAX_CONCURRENT_HOST_CALLS - RECOVERY_HOST_CALL_RESERVE
const MAX_WAITING_HOST_CALLS = 128
const MAX_READ_ATTEMPTS = 3
const MAX_CHECKPOINT_ATTEMPTS = 3
export const STORAGE_HOST_CALL_TIMEOUT_MILLISECONDS = 2_000
export const MAX_STORAGE_VALUE_BYTES = 128 * 1024
const MAX_DIRTY_BYTES = 512 * 1024
const STORAGE_HEALTH_KEY = 'gc:v1:health'
const STORAGE_HEALTH_VALUE = JSON.stringify({ v: 1 })
export const MAX_DIRTY_ENTRIES = 256
export const MAX_FLUSH_WRITES = 32
export const MAX_CHECKPOINT_FLUSHES = Math.ceil(MAX_DIRTY_ENTRIES / MAX_FLUSH_WRITES) + MAX_CHECKPOINT_ATTEMPTS

function hasValidVersion(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('v' in value)) return true
  return typeof (value as { v?: unknown }).v === 'number'
}

function utf8Bytes(value: string) {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

export function createStorageRepository(storage: StoragePort = Storage) {
  const dirty = new Map<string, DirtyWrite>()
  let dirtyBytes = 0
  let flushPromise: Promise<FlushResult> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let activeHostCalls = 0
  let timedOutHostCalls = 0
  let waitingHostCallCount = 0
  const waitingHostCalls: Array<{ reserveEligible: boolean; grant: () => boolean }> = []

  function hasHostCallCapacity(reserveEligible: boolean) {
    return (
      activeHostCalls < MAX_PRIMARY_HOST_CALLS ||
      (reserveEligible && timedOutHostCalls >= MAX_PRIMARY_HOST_CALLS && activeHostCalls < MAX_CONCURRENT_HOST_CALLS)
    )
  }

  function grantWaitingHostCalls() {
    while (true) {
      const index = waitingHostCalls.findIndex((waiting) => hasHostCallCapacity(waiting.reserveEligible))
      if (index < 0) return
      const [waiting] = waitingHostCalls.splice(index, 1)
      if (!waiting.grant()) continue
      activeHostCalls += 1
    }
  }

  function acquireHostCall(reserveEligible: boolean): Promise<void> | null {
    if (hasHostCallCapacity(reserveEligible)) {
      activeHostCalls += 1
      return null
    }
    if (waitingHostCallCount >= MAX_WAITING_HOST_CALLS) {
      throw new StorageUnavailableError(['host-call-queue'])
    }
    return new Promise<void>((resolve, reject) => {
      let active = true
      waitingHostCallCount += 1
      let timeout: ReturnType<typeof setTimeout>
      const grant = () => {
        if (!active) return false
        active = false
        waitingHostCallCount -= 1
        clearTimeout(timeout)
        resolve()
        return true
      }
      timeout = setTimeout(() => {
        if (!active) return
        active = false
        waitingHostCallCount -= 1
        const waiting = waitingHostCalls.find((entry) => entry.grant === grant)
        const index = waiting ? waitingHostCalls.indexOf(waiting) : -1
        if (index >= 0) waitingHostCalls.splice(index, 1)
        reject(new StorageUnavailableError(['host-call-timeout']))
      }, STORAGE_HOST_CALL_TIMEOUT_MILLISECONDS)
      waitingHostCalls.push({ reserveEligible, grant })
    })
  }

  function releaseHostCall(timedOut: boolean) {
    activeHostCalls -= 1
    if (timedOut) timedOutHostCalls -= 1
    grantWaitingHostCalls()
  }

  async function hostCall<T>(call: () => Promise<T>, reserveEligible: boolean) {
    const permit = acquireHostCall(reserveEligible)
    if (permit) await permit
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      let timedOut = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        timedOut = true
        timedOutHostCalls += 1
        grantWaitingHostCalls()
        reject(new StorageUnavailableError(['host-call-timeout']))
      }, STORAGE_HOST_CALL_TIMEOUT_MILLISECONDS)

      let pending: Promise<T>
      try {
        pending = call()
      } catch (error) {
        settled = true
        clearTimeout(timeout)
        releaseHostCall(false)
        reject(error)
        return
      }
      pending.then(
        (value) => {
          releaseHostCall(timedOut)
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(value)
        },
        (error: unknown) => {
          releaseHostCall(timedOut)
          if (settled) return
          settled = true
          clearTimeout(timeout)
          reject(error)
        }
      )
    })
  }

  function scopedHostCall() {
    const reserveEligible = timedOutHostCalls >= MAX_PRIMARY_HOST_CALLS
    return <T>(call: () => Promise<T>) => hostCall(call, reserveEligible)
  }

  type ScopedHostCall = ReturnType<typeof scopedHostCall>

  async function confirmSceneValue(key: string, callHost: ScopedHostCall) {
    const result = await callHost(() => storage.getValues({ prefix: key, limit: 2 }))
    return result.data.find((entry) => entry.key === key)?.value ?? null
  }

  async function confirmPlayerValue(address: string, key: string, callHost: ScopedHostCall) {
    const result = await callHost(() => storage.player.getValues(address, { prefix: key, limit: 2 }))
    return result.data.find((entry) => entry.key === key)?.value ?? null
  }

  async function confirmSceneReadsAvailable(callHost: ScopedHostCall) {
    const current = await callHost(() => storage.get(STORAGE_HEALTH_KEY, { fresh: true })).catch(() => null)
    if (current === STORAGE_HEALTH_VALUE) return true
    const saved = await callHost(() => storage.set(STORAGE_HEALTH_KEY, STORAGE_HEALTH_VALUE))
    if (!saved) return false
    return (await callHost(() => storage.get(STORAGE_HEALTH_KEY, { fresh: true }))) === STORAGE_HEALTH_VALUE
  }

  async function confirmPlayerReadsAvailable(address: string, callHost: ScopedHostCall) {
    const current = await callHost(() => storage.player.get(address, STORAGE_HEALTH_KEY, { fresh: true })).catch(
      () => null
    )
    if (current === STORAGE_HEALTH_VALUE) return true
    const saved = await callHost(() => storage.player.set(address, STORAGE_HEALTH_KEY, STORAGE_HEALTH_VALUE))
    if (!saved) return false
    return (
      (await callHost(() => storage.player.get(address, STORAGE_HEALTH_KEY, { fresh: true }))) === STORAGE_HEALTH_VALUE
    )
  }

  async function readRaw(
    read: (fresh: boolean) => Promise<unknown | null>,
    confirm: (callHost: ScopedHostCall) => Promise<unknown | null>,
    confirmReadsAvailable: (callHost: ScopedHostCall) => Promise<boolean>
  ) {
    const callHost = scopedHostCall()
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      try {
        const raw = await callHost(() => read(attempt > 0))
        if (raw !== null) return { status: 'found' as const, raw }
      } catch (error) {
        if (error instanceof StorageUnavailableError && error.keys.includes('host-call-timeout')) break
        // A separate authoritative listing below decides missing versus unavailable.
      }
    }

    try {
      const raw = await confirm(callHost)
      if (raw !== null) return { status: 'found' as const, raw }
      return (await confirmReadsAvailable(callHost))
        ? { status: 'missing' as const }
        : { status: 'unavailable' as const }
    } catch {
      return { status: 'unavailable' as const }
    }
  }

  function parseRead<T>(key: string, result: Awaited<ReturnType<typeof readRaw>>, fallback: T): T {
    if (result.status === 'missing') return fallback
    if (result.status === 'unavailable') throw new StorageUnavailableError([key])
    if (typeof result.raw !== 'string') throw new StorageCorruptError([key])
    if (utf8Bytes(result.raw) > MAX_STORAGE_VALUE_BYTES) {
      throw new StorageCorruptError([key])
    }

    try {
      const value: unknown = JSON.parse(result.raw)
      if (!hasValidVersion(value)) throw new StorageCorruptError([key])
      return value as T
    } catch (error) {
      if (error instanceof StorageCorruptError) throw error
      throw new StorageCorruptError([key])
    }
  }

  async function loadJSON<T>(key: string, fallback: T): Promise<T> {
    const result = await readRaw(
      (fresh) => storage.get(key, fresh ? { fresh: true } : undefined),
      (callHost) => confirmSceneValue(key, callHost),
      confirmSceneReadsAvailable
    )
    return parseRead(key, result, fallback)
  }

  async function loadPlayerJSON<T>(address: string, key: string, fallback: T): Promise<T> {
    const result = await readRaw(
      (fresh) => storage.player.get(address, key, fresh ? { fresh: true } : undefined),
      (callHost) => confirmPlayerValue(address, key, callHost),
      (callHost) => confirmPlayerReadsAvailable(address, callHost)
    )
    return parseRead(`player:${address}:${key}`, result, fallback)
  }

  function serialize(value: unknown) {
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string') throw new StorageCapacityError('Storage values must be JSON serializable')
    const bytes = utf8Bytes(serialized)
    if (bytes > MAX_STORAGE_VALUE_BYTES) throw new StorageCapacityError('Storage value capacity exceeded')
    return { serialized, bytes }
  }

  function stageDirty(entries: Array<[string, DirtyWrite]>) {
    const staged = new Map(entries)
    let nextBytes = dirtyBytes
    let added = 0
    for (const [dirtyKey, entry] of staged) {
      const current = dirty.get(dirtyKey)
      if (current) nextBytes -= current.bytes
      else added += 1
      nextBytes += entry.bytes
    }
    if (dirty.size + added > MAX_DIRTY_ENTRIES || nextBytes > MAX_DIRTY_BYTES) {
      throw new StorageCapacityError('Storage write queue capacity exceeded')
    }
    for (const [dirtyKey, entry] of staged) dirty.set(dirtyKey, entry)
    dirtyBytes = nextBytes
  }

  function sceneEntry(key: string, value: unknown): [string, DirtyWrite] {
    const encoded = serialize(value)
    return [`scene:${key}`, { scope: 'scene', key, ...encoded }]
  }

  function markDirty(key: string, value: unknown) {
    stageDirty([sceneEntry(key, value)])
  }

  function markDirtyBatch(entries: ReadonlyArray<{ key: string; value: unknown }>) {
    stageDirty(entries.map((entry) => sceneEntry(entry.key, entry.value)))
  }

  function markPlayerDirty(address: string, key: string, value: unknown) {
    const encoded = serialize(value)
    stageDirty([
      [
        `player:${address}:${key}`,
        {
          scope: 'player',
          address,
          key,
          ...encoded
        }
      ]
    ])
  }

  async function saveJSONNow(key: string, value: unknown) {
    const { serialized } = serialize(value)
    const callHost = scopedHostCall()
    for (let attempt = 0; attempt < MAX_CHECKPOINT_ATTEMPTS; attempt += 1) {
      try {
        if (await callHost(() => storage.set(key, serialized))) return
      } catch {
        // Retry the bounded immediate write below.
      }
    }
    throw new StorageUnavailableError([`scene:${key}`])
  }

  async function write(entry: DirtyWrite, callHost: ScopedHostCall) {
    try {
      if (entry.scope === 'scene') return await callHost(() => storage.set(entry.key, entry.serialized))
      return await callHost(() => storage.player.set(entry.address, entry.key, entry.serialized))
    } catch {
      return false
    }
  }

  async function runFlush(): Promise<FlushResult> {
    const pending = [...dirty.entries()].slice(0, MAX_FLUSH_WRITES)
    const callHost = scopedHostCall()
    let saved = 0
    let failed = 0

    for (let offset = 0; offset < pending.length; offset += MAX_CONCURRENT_WRITES) {
      const batch = pending.slice(offset, offset + MAX_CONCURRENT_WRITES)
      const results = await Promise.all(batch.map(([, entry]) => write(entry, callHost)))

      results.forEach((ok, index) => {
        const [dirtyKey, attempted] = batch[index]
        if (ok) {
          saved += 1
          const current = dirty.get(dirtyKey)
          if (current?.serialized === attempted.serialized) {
            dirty.delete(dirtyKey)
            dirtyBytes -= current.bytes
          }
        } else {
          failed += 1
          const current = dirty.get(dirtyKey)
          if (current?.serialized === attempted.serialized) {
            dirty.delete(dirtyKey)
            dirty.set(dirtyKey, current)
          }
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
    let failedAttempts = 0
    let flushes = 0
    while (dirty.size > 0 && failedAttempts < MAX_CHECKPOINT_ATTEMPTS && flushes < MAX_CHECKPOINT_FLUSHES) {
      result = await flush()
      flushes += 1
      failedAttempts = result.saved > 0 ? 0 : failedAttempts + 1
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
    saveJSONNow,
    markDirty,
    markDirtyBatch,
    markPlayerDirty,
    flush,
    flushNow,
    startFlushLoop,
    stopFlushLoop,
    getDirtyKeys: () => [...dirty.keys()],
    getDirtyBytes: () => dirtyBytes
  }
}

const repository = createStorageRepository()

export const loadJSON = repository.loadJSON
export const loadPlayerJSON = repository.loadPlayerJSON
export const saveJSONNow = repository.saveJSONNow
export const markDirty = repository.markDirty
export const markDirtyBatch = repository.markDirtyBatch
export const markPlayerDirty = repository.markPlayerDirty
export const flushNow = repository.flushNow
export const startFlushLoop = repository.startFlushLoop
