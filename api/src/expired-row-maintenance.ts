import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import type { RetentionPruneResult } from './retention-repository.js'

export const EXPIRED_ROW_MAINTENANCE_INTERVAL_MILLISECONDS = 15 * 60 * 1_000

export interface ExpiredRowMaintenanceRepository {
  pruneExpired(): Promise<RetentionPruneResult>
}

export type ExpiredRowMaintenanceOptions = Readonly<{
  onPruned(result: RetentionPruneResult): void
  onUnexpectedError(error: unknown): void
}>

function didPrune(result: RetentionPruneResult) {
  return (
    result.rateBuckets.deleted > 0 ||
    result.rateBuckets.possiblyBacklogged ||
    result.analyticsReceipts.deleted > 0 ||
    result.analyticsReceipts.possiblyBacklogged
  )
}

export class ExpiredRowMaintenance {
  private started = false
  private stopped = false
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<void> | undefined

  constructor(
    private readonly repository: ExpiredRowMaintenanceRepository,
    private readonly options: ExpiredRowMaintenanceOptions
  ) {}

  private beginPrune(reportFailure: boolean) {
    const run = this.repository.pruneExpired().then((result) => {
      if (didPrune(result)) this.options.onPruned(result)
    })
    const handled = reportFailure
      ? run.catch((error: unknown) => {
          this.options.onUnexpectedError(error)
        })
      : run
    const tracked = handled.finally(() => {
      this.inFlight = undefined
    })
    this.inFlight = tracked
    return tracked
  }

  private tick() {
    if (this.stopped || this.inFlight !== undefined) return
    void this.beginPrune(true)
  }

  async [START_COMPONENT]() {
    if (this.started) throw new Error('Expired-row maintenance already started')
    this.started = true
    await this.beginPrune(false)
    if (this.stopped) return
    this.timer = setInterval(() => this.tick(), EXPIRED_ROW_MAINTENANCE_INTERVAL_MILLISECONDS)
    this.timer.unref()
  }

  async [STOP_COMPONENT]() {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.inFlight
  }
}
