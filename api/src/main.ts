import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent } from '@well-known-components/http-server'
import { Lifecycle, START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { createJsonLogComponent } from '@well-known-components/logger'
import { AnalyticsExportRepository } from './analytics-export-repository.js'
import { AnalyticsRepository } from './analytics-repository.js'
import type { ApiAuthContext } from './auth.js'
import { parseConfig } from './config.js'
import { createDatabase } from './database.js'
import { ExpiredRowMaintenance } from './expired-row-maintenance.js'
import { createHttpRouter } from './http.js'
import { ModerationAuditExportRepository } from './moderation-audit-export-repository.js'
import { ModerationRepository } from './moderation-repository.js'
import { RetentionRepository } from './retention-repository.js'

async function initComponents() {
  const appConfig = parseConfig()
  const config = createConfigComponent({
    HTTP_SERVER_HOST: appConfig.http.host,
    HTTP_SERVER_PORT: String(appConfig.http.port),
    LOG_LEVEL: 'INFO'
  })
  const logs = await createJsonLogComponent({ config })
  const databaseStore = createDatabase(appConfig.databaseUrl)
  const database = {
    async [START_COMPONENT]() {
      await databaseStore.migrate()
      await databaseStore.seedSceneAllowlist(appConfig.allowedSceneIds, appConfig.trustedCatalystUrl)
    },
    async [STOP_COMPONENT]() {
      await databaseStore.close()
    }
  }
  const repository = new AnalyticsRepository(databaseStore, {
    allowedSceneIds: appConfig.allowedSceneIds,
    trustedCatalystUrl: appConfig.trustedCatalystUrl,
    retentionDays: appConfig.analyticsRetentionDays,
    analyticsWalletPerMinute: appConfig.rates.analyticsWalletPerMinute,
    analyticsGuestPerMinute: appConfig.rates.analyticsGuestPerMinute
  })
  const exportRepository = new AnalyticsExportRepository(databaseStore, {
    allowedSceneIds: appConfig.allowedSceneIds,
    exportPerHour: appConfig.rates.exportPerHour
  })
  const moderationRepository = new ModerationRepository(databaseStore, {
    allowedSceneIds: appConfig.allowedSceneIds,
    trustedCatalystUrl: appConfig.trustedCatalystUrl,
    publishPerHour: appConfig.rates.publishPerHour,
    reportWalletPerHour: appConfig.rates.reportWalletPerHour,
    reportGuestPerHour: appConfig.rates.reportGuestPerHour,
    decisionPerMinute: appConfig.rates.decisionPerMinute
  })
  const moderationAuditExportRepository = new ModerationAuditExportRepository(databaseStore, {
    auditExportPerHour: appConfig.rates.auditExportPerHour
  })
  const retentionRepository = new RetentionRepository(databaseStore, {
    analyticsRetentionDays: appConfig.analyticsRetentionDays
  })
  const requestLogger = logs.getLogger('ghostlight-api')
  const maintenanceLogger = logs.getLogger('ghostlight-api-retention')
  const maintenance = new ExpiredRowMaintenance(retentionRepository, {
    onPruned(result) {
      maintenanceLogger.info('Expired-row maintenance pruned rows', {
        rateBucketsDeleted: result.rateBuckets.deleted,
        rateBucketsPossiblyBacklogged: result.rateBuckets.possiblyBacklogged ? 1 : 0,
        analyticsReceiptsDeleted: result.analyticsReceipts.deleted,
        analyticsReceiptsPossiblyBacklogged: result.analyticsReceipts.possiblyBacklogged ? 1 : 0
      })
    },
    onUnexpectedError() {
      maintenanceLogger.error(new Error('Expired-row maintenance failed'))
    }
  })
  const router = createHttpRouter({
    config: appConfig,
    repository,
    exportRepository,
    moderationRepository,
    moderationAuditExportRepository,
    async isReady() {
      await databaseStore.ping()
      return true
    },
    onUnexpectedError() {
      requestLogger.error(new Error('Request processing failed'))
    }
  })
  const server = await createServerComponent<ApiAuthContext>(
    { config, logs },
    {
      http: {
        maxHeaderSize: 16_384,
        requestTimeout: 10_000,
        headersTimeout: 5_000,
        keepAliveTimeout: 5_000
      }
    }
  )
  server.use(router.middleware())
  server.use(router.allowedMethods())
  return { config, logs, database, maintenance, server }
}

Lifecycle.run({
  initComponents,
  async main({ startComponents }) {
    await startComponents()
  }
})
