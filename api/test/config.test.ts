import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'

const actorDigestKey = 'x'.repeat(32)

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: 'postgresql://ghostlight:password@db.internal:5432/ghostlight',
    ALLOWED_SCENE_IDS: 'scene-alpha, scene-beta',
    TRUSTED_CATALYST_URL: 'https://peer.decentraland.org',
    ACTOR_DIGEST_KEY: actorDigestKey,
    ...overrides
  }
}

describe('startup config', () => {
  it('parses required values and exact defaults without exposing the actor digest key', () => {
    const config = parseConfig(validEnv())

    expect(config.databaseUrl).toBe('postgresql://ghostlight:password@db.internal:5432/ghostlight')
    expect([...config.allowedSceneIds]).toEqual(['scene-alpha', 'scene-beta'])
    expect(Object.isFrozen(config.allowedSceneIds)).toBe(true)
    expect(config.trustedCatalystUrl).toBe('https://peer.decentraland.org')
    expect(config.http).toEqual({ host: '127.0.0.1', port: 3100 })
    expect(config.analyticsRetentionDays).toBe(31)
    expect(config.rates).toEqual({
      analyticsWalletPerMinute: 120,
      analyticsGuestPerMinute: 30,
      reportWalletPerHour: 5,
      reportGuestPerHour: 2,
      publishPerHour: 10,
      decisionPerMinute: 60,
      exportPerHour: 6,
      auditExportPerHour: 6
    })
    expect(JSON.stringify(config)).not.toContain(actorDigestKey)
    expect(Object.keys(config)).not.toContain('actorDigestKey')
    const address = `0x${'a'.repeat(40)}`
    const digest = config.digestActor('analytics-wallet-rate', address)
    expect(digest).toHaveLength(32)
    expect(config.digestActor('analytics-wallet-rate', address.toUpperCase())).toEqual(digest)
    expect(config.digestActor('report-wallet-rate', address)).not.toEqual(digest)
    expect(config.digestActor('moderation-audit-export-rate', address)).not.toEqual(digest)
    expect(config.digestActor('analytics-wallet-rate', `0x${'b'.repeat(40)}`)).not.toEqual(digest)
    expect(() => (config.digestActor as (purpose: string, actorId: string) => Buffer)('unknown', address)).toThrow(
      'Actor digest purpose'
    )
    expect(() => Reflect.apply(config.digestActor, undefined, [address])).toThrow('Actor digest purpose')
  })

  it('requires every mandatory environment value without echoing secret material', () => {
    for (const key of ['DATABASE_URL', 'ALLOWED_SCENE_IDS', 'TRUSTED_CATALYST_URL', 'ACTOR_DIGEST_KEY']) {
      expect(() => parseConfig(validEnv({ [key]: undefined }))).toThrow(key)
    }
    expect(() => parseConfig(validEnv({ ACTOR_DIGEST_KEY: 'short-secret' }))).toThrow(
      'ACTOR_DIGEST_KEY must be at least 32 UTF-8 bytes'
    )
  })

  it('requires trimmed unique bounded scene identifiers', () => {
    expect(() => parseConfig(validEnv({ ALLOWED_SCENE_IDS: 'scene-a,,scene-b' }))).toThrow('ALLOWED_SCENE_IDS')
    expect(() => parseConfig(validEnv({ ALLOWED_SCENE_IDS: 'scene-a,scene-a' }))).toThrow('unique')
    expect(() => parseConfig(validEnv({ ALLOWED_SCENE_IDS: `scene-a,${'😀'.repeat(33)}` }))).toThrow('128 UTF-8')
    expect(() => parseConfig(validEnv({ ALLOWED_SCENE_IDS: ' scene-a , scene-b ' }))).not.toThrow()
  })

  it('accepts only a credential-free HTTPS Catalyst origin and a bounded HTTP bind target', () => {
    for (const value of [
      'http://peer.decentraland.org',
      'https://user@peer.decentraland.org',
      'https://peer.decentraland.org/content',
      'https://peer.decentraland.org?x=1'
    ]) {
      expect(() => parseConfig(validEnv({ TRUSTED_CATALYST_URL: value }))).toThrow('TRUSTED_CATALYST_URL')
    }
    expect(() => parseConfig(validEnv({ HTTP_SERVER_HOST: 'https://localhost' }))).toThrow('HTTP_SERVER_HOST')
    for (const host of ['bad..host', '127.0.0.999', 'host-']) {
      expect(() => parseConfig(validEnv({ HTTP_SERVER_HOST: host }))).toThrow('HTTP_SERVER_HOST')
    }
    expect(() => parseConfig(validEnv({ HTTP_SERVER_PORT: '65536' }))).toThrow('HTTP_SERVER_PORT')
    expect(parseConfig(validEnv({ HTTP_SERVER_HOST: '0.0.0.0', HTTP_SERVER_PORT: '8080' })).http).toEqual({
      host: '0.0.0.0',
      port: 8080
    })
    expect(parseConfig(validEnv({ HTTP_SERVER_HOST: '::1' })).http.host).toBe('::1')
    expect(
      parseConfig(validEnv({ TRUSTED_CATALYST_URL: 'https://peer.decentraland.org:8443' })).trustedCatalystUrl
    ).toBe('https://peer.decentraland.org:8443')
    expect(parseConfig(validEnv({ TRUSTED_CATALYST_URL: 'https://[2001:db8::1]:8443' })).trustedCatalystUrl).toBe(
      'https://[2001:db8::1]:8443'
    )
    expect(() => parseConfig(validEnv({ TRUSTED_CATALYST_URL: `https://${'a'.repeat(2_040)}.org` }))).toThrow(
      'TRUSTED_CATALYST_URL'
    )
  })

  it('validates every retention and rate integer against its exact bound', () => {
    expect(() => parseConfig(validEnv({ ANALYTICS_RETENTION_DAYS: '0' }))).toThrow('ANALYTICS_RETENTION_DAYS')
    expect(() => parseConfig(validEnv({ ANALYTICS_RETENTION_DAYS: '367' }))).toThrow('ANALYTICS_RETENTION_DAYS')
    for (const key of [
      'RATE_ANALYTICS_WALLET_PER_MINUTE',
      'RATE_ANALYTICS_GUEST_PER_MINUTE',
      'RATE_REPORT_WALLET_PER_HOUR',
      'RATE_REPORT_GUEST_PER_HOUR',
      'RATE_PUBLISH_PER_HOUR',
      'RATE_DECISION_PER_MINUTE',
      'RATE_EXPORT_PER_HOUR',
      'RATE_AUDIT_EXPORT_PER_HOUR'
    ]) {
      expect(() => parseConfig(validEnv({ [key]: '0' }))).toThrow(key)
      expect(() => parseConfig(validEnv({ [key]: '100001' }))).toThrow(key)
      expect(() => parseConfig(validEnv({ [key]: '1.5' }))).toThrow(key)
    }
  })
})
