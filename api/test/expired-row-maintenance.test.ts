import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EXPIRED_ROW_MAINTENANCE_INTERVAL_MILLISECONDS,
  ExpiredRowMaintenance,
  type ExpiredRowMaintenanceRepository
} from '../src/expired-row-maintenance.js'
import type { RetentionPruneResult } from '../src/retention-repository.js'

const EMPTY_RESULT: RetentionPruneResult = Object.freeze({
  rateBuckets: Object.freeze({ deleted: 0, possiblyBacklogged: false }),
  analyticsReceipts: Object.freeze({ deleted: 0, possiblyBacklogged: false })
})

function result(
  rateBuckets: RetentionPruneResult['rateBuckets'],
  analyticsReceipts: RetentionPruneResult['analyticsReceipts'] = EMPTY_RESULT.analyticsReceipts
): RetentionPruneResult {
  return Object.freeze({ rateBuckets: Object.freeze(rateBuckets), analyticsReceipts: Object.freeze(analyticsReceipts) })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fixture(repository: ExpiredRowMaintenanceRepository) {
  const pruned: RetentionPruneResult[] = []
  const errors: unknown[] = []
  const maintenance = new ExpiredRowMaintenance(repository, {
    onPruned(value) {
      pruned.push(value)
    },
    onUnexpectedError(error) {
      errors.push(error)
    }
  })
  return { maintenance, pruned, errors }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('expired-row maintenance lifecycle', () => {
  it('awaits startup pruning before installing one unreferenced fifteen-minute timer', async () => {
    vi.useFakeTimers()
    const startup = deferred<RetentionPruneResult>()
    const repository: ExpiredRowMaintenanceRepository = { pruneExpired: vi.fn(() => startup.promise) }
    const { maintenance, pruned, errors } = fixture(repository)
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')

    const starting = maintenance[START_COMPONENT]()
    expect(repository.pruneExpired).toHaveBeenCalledTimes(1)
    expect(intervalSpy).not.toHaveBeenCalled()

    const startupResult = result({ deleted: 3, possiblyBacklogged: false })
    startup.resolve(startupResult)
    await starting

    expect(pruned).toEqual([startupResult])
    expect(errors).toEqual([])
    expect(intervalSpy).toHaveBeenCalledTimes(1)
    expect(intervalSpy.mock.calls[0]?.[1]).toBe(EXPIRED_ROW_MAINTENANCE_INTERVAL_MILLISECONDS)
    const timer = intervalSpy.mock.results[0]?.value
    expect(timer?.hasRef()).toBe(false)

    await maintenance[STOP_COMPONENT]()
  })

  it('does not report a successful no-op run', async () => {
    vi.useFakeTimers()
    const repository: ExpiredRowMaintenanceRepository = { pruneExpired: vi.fn(async () => EMPTY_RESULT) }
    const { maintenance, pruned, errors } = fixture(repository)

    await maintenance[START_COMPONENT]()
    expect(pruned).toEqual([])
    expect(errors).toEqual([])
    await maintenance[STOP_COMPONENT]()
  })

  it('reports backlog even when a bounded run deletes no rows', async () => {
    vi.useFakeTimers()
    const backlogged = result({ deleted: 0, possiblyBacklogged: true })
    const repository: ExpiredRowMaintenanceRepository = { pruneExpired: vi.fn(async () => backlogged) }
    const { maintenance, pruned } = fixture(repository)

    await maintenance[START_COMPONENT]()
    expect(pruned).toEqual([backlogged])
    await maintenance[STOP_COMPONENT]()
  })

  it('propagates startup failure without installing a timer', async () => {
    vi.useFakeTimers()
    const failure = new Error('startup pruning failed')
    const repository: ExpiredRowMaintenanceRepository = {
      pruneExpired: vi.fn(async () => Promise.reject(failure))
    }
    const { maintenance, pruned, errors } = fixture(repository)
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')

    await expect(maintenance[START_COMPONENT]()).rejects.toBe(failure)
    expect(intervalSpy).not.toHaveBeenCalled()
    expect(pruned).toEqual([])
    expect(errors).toEqual([])
    await maintenance[STOP_COMPONENT]()
  })

  it('contains a periodic failure and retries on the next interval', async () => {
    vi.useFakeTimers()
    const failure = new Error('periodic pruning failed')
    const periodicResult = result({ deleted: 0, possiblyBacklogged: false }, { deleted: 2, possiblyBacklogged: false })
    const repository: ExpiredRowMaintenanceRepository = {
      pruneExpired: vi
        .fn<() => Promise<RetentionPruneResult>>()
        .mockResolvedValueOnce(EMPTY_RESULT)
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(periodicResult)
    }
    const { maintenance, pruned, errors } = fixture(repository)

    await maintenance[START_COMPONENT]()
    await vi.advanceTimersByTimeAsync(EXPIRED_ROW_MAINTENANCE_INTERVAL_MILLISECONDS)
    expect(errors).toEqual([failure])
    expect(pruned).toEqual([])

    await vi.advanceTimersByTimeAsync(EXPIRED_ROW_MAINTENANCE_INTERVAL_MILLISECONDS)
    expect(repository.pruneExpired).toHaveBeenCalledTimes(3)
    expect(pruned).toEqual([periodicResult])
    await maintenance[STOP_COMPONENT]()
  })

  it('never overlaps runs and waits for the in-flight run during stop', async () => {
    vi.useFakeTimers()
    const periodic = deferred<RetentionPruneResult>()
    const repository: ExpiredRowMaintenanceRepository = {
      pruneExpired: vi
        .fn<() => Promise<RetentionPruneResult>>()
        .mockResolvedValueOnce(EMPTY_RESULT)
        .mockImplementationOnce(() => periodic.promise)
    }
    const { maintenance } = fixture(repository)

    await maintenance[START_COMPONENT]()
    await vi.advanceTimersByTimeAsync(EXPIRED_ROW_MAINTENANCE_INTERVAL_MILLISECONDS)
    expect(repository.pruneExpired).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(EXPIRED_ROW_MAINTENANCE_INTERVAL_MILLISECONDS * 2)
    expect(repository.pruneExpired).toHaveBeenCalledTimes(2)

    let stopped = false
    const stopping = maintenance[STOP_COMPONENT]().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    periodic.resolve(EMPTY_RESULT)
    await stopping
    expect(stopped).toBe(true)
    await vi.advanceTimersByTimeAsync(EXPIRED_ROW_MAINTENANCE_INTERVAL_MILLISECONDS * 2)
    expect(repository.pruneExpired).toHaveBeenCalledTimes(2)
  })

  it('rejects a second start and makes repeated stops harmless', async () => {
    vi.useFakeTimers()
    const repository: ExpiredRowMaintenanceRepository = { pruneExpired: vi.fn(async () => EMPTY_RESULT) }
    const { maintenance } = fixture(repository)

    await maintenance[START_COMPONENT]()
    await expect(maintenance[START_COMPONENT]()).rejects.toThrow('Expired-row maintenance already started')
    await maintenance[STOP_COMPONENT]()
    await maintenance[STOP_COMPONENT]()
    expect(repository.pruneExpired).toHaveBeenCalledTimes(1)
  })
})
