import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'

export type RateConfig = Readonly<{
  analyticsWalletPerMinute: number
  analyticsGuestPerMinute: number
  reportWalletPerHour: number
  reportGuestPerHour: number
  publishPerHour: number
  decisionPerMinute: number
  exportPerHour: number
  auditExportPerHour: number
}>

export const ACTOR_DIGEST_PURPOSES = [
  'analytics-wallet-rate',
  'analytics-guest-rate',
  'report-wallet-rate',
  'report-guest-rate',
  'publish-rate',
  'decision-rate',
  'export-rate',
  'moderation-audit-export-rate',
  'moderation-report',
  'moderation-audit'
] as const

export type ActorDigestPurpose = (typeof ACTOR_DIGEST_PURPOSES)[number]

export type AppConfig = Readonly<{
  databaseUrl: string
  allowedSceneIds: readonly string[]
  trustedCatalystUrl: string
  http: Readonly<{ host: string; port: number }>
  analyticsRetentionDays: number
  rates: RateConfig
  digestActor: (purpose: ActorDigestPurpose, actorId: string) => Buffer
}>

type Environment = Readonly<Record<string, string | undefined>>

const MAX_SCENE_ID_BYTES = 128
const MAX_ACTOR_ID_BYTES = 512
const MAX_ORIGIN_BYTES = 2_048
const MAX_RATE = 100_000
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu
const IPV4_SHAPE = /^[0-9.]+$/u
const INTEGER = /^(?:0|[1-9][0-9]*)$/u
const ETHEREUM_ADDRESS = /^0x[a-f0-9]{40}$/iu
const ACTOR_DIGEST_PURPOSE_SET = new Set<string>(ACTOR_DIGEST_PURPOSES)

function required(env: Environment, key: string) {
  const value = env[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`)
  return value
}

function parseInteger(env: Environment, key: string, fallback: number, minimum: number, maximum: number) {
  const raw = env[key]
  if (raw === undefined) return fallback
  if (!INTEGER.test(raw)) throw new RangeError(`${key} must be an integer between ${minimum} and ${maximum}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${key} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function parseDatabaseUrl(value: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > MAX_ORIGIN_BYTES ||
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hostname === ''
  ) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL')
  }
  return value
}

function parseSceneIds(value: string) {
  const values = value.split(',').map((entry) => entry.trim())
  if (values.length === 0 || values.some((entry) => entry === '')) {
    throw new Error('ALLOWED_SCENE_IDS must contain nonempty comma-separated identifiers')
  }
  const unique = new Set<string>()
  for (const sceneId of values) {
    if (Buffer.byteLength(sceneId, 'utf8') > MAX_SCENE_ID_BYTES) {
      throw new Error(`ALLOWED_SCENE_IDS entries must not exceed ${MAX_SCENE_ID_BYTES} UTF-8 bytes`)
    }
    if (unique.has(sceneId)) throw new Error('ALLOWED_SCENE_IDS entries must be unique')
    unique.add(sceneId)
  }
  return Object.freeze([...unique])
}

function parseHttpsOrigin(value: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('TRUSTED_CATALYST_URL must be a credential-free HTTPS origin')
  }
  if (
    value.trim() !== value ||
    parsed.protocol !== 'https:' ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    Buffer.byteLength(parsed.origin, 'utf8') > MAX_ORIGIN_BYTES
  ) {
    throw new Error('TRUSTED_CATALYST_URL must be a credential-free HTTPS origin')
  }
  return parsed.origin
}

function parseHost(value: string | undefined) {
  const host = value ?? '127.0.0.1'
  const ipVersion = isIP(host)
  if (host.length > 253 || (ipVersion === 0 && (!HOSTNAME.test(host) || IPV4_SHAPE.test(host)))) {
    throw new Error('HTTP_SERVER_HOST must be a bounded hostname or IP address')
  }
  return host
}

export function parseConfig(env: Environment = process.env): AppConfig {
  const databaseUrl = parseDatabaseUrl(required(env, 'DATABASE_URL'))
  const allowedSceneIds = parseSceneIds(required(env, 'ALLOWED_SCENE_IDS'))
  const trustedCatalystUrl = parseHttpsOrigin(required(env, 'TRUSTED_CATALYST_URL'))
  const actorDigestKey = required(env, 'ACTOR_DIGEST_KEY')
  if (Buffer.byteLength(actorDigestKey, 'utf8') < 32) {
    throw new Error('ACTOR_DIGEST_KEY must be at least 32 UTF-8 bytes')
  }

  const digestActor = (purpose: ActorDigestPurpose, actorId: string) => {
    if (!ACTOR_DIGEST_PURPOSE_SET.has(purpose)) throw new Error('Actor digest purpose is invalid')
    if (typeof actorId !== 'string' || actorId === '' || Buffer.byteLength(actorId, 'utf8') > MAX_ACTOR_ID_BYTES) {
      throw new Error('Actor identifier must be between 1 and 512 UTF-8 bytes')
    }
    const canonicalActorId = ETHEREUM_ADDRESS.test(actorId) ? actorId.toLowerCase() : actorId
    return createHmac('sha256', actorDigestKey)
      .update(purpose, 'utf8')
      .update('\0', 'utf8')
      .update(canonicalActorId, 'utf8')
      .digest()
  }

  const rates: RateConfig = Object.freeze({
    analyticsWalletPerMinute: parseInteger(env, 'RATE_ANALYTICS_WALLET_PER_MINUTE', 120, 1, MAX_RATE),
    analyticsGuestPerMinute: parseInteger(env, 'RATE_ANALYTICS_GUEST_PER_MINUTE', 30, 1, MAX_RATE),
    reportWalletPerHour: parseInteger(env, 'RATE_REPORT_WALLET_PER_HOUR', 5, 1, MAX_RATE),
    reportGuestPerHour: parseInteger(env, 'RATE_REPORT_GUEST_PER_HOUR', 2, 1, MAX_RATE),
    publishPerHour: parseInteger(env, 'RATE_PUBLISH_PER_HOUR', 10, 1, MAX_RATE),
    decisionPerMinute: parseInteger(env, 'RATE_DECISION_PER_MINUTE', 60, 1, MAX_RATE),
    exportPerHour: parseInteger(env, 'RATE_EXPORT_PER_HOUR', 6, 1, MAX_RATE),
    auditExportPerHour: parseInteger(env, 'RATE_AUDIT_EXPORT_PER_HOUR', 6, 1, MAX_RATE)
  })

  return Object.freeze({
    databaseUrl,
    allowedSceneIds,
    trustedCatalystUrl,
    http: Object.freeze({
      host: parseHost(env.HTTP_SERVER_HOST),
      port: parseInteger(env, 'HTTP_SERVER_PORT', 3100, 1, 65_535)
    }),
    analyticsRetentionDays: parseInteger(env, 'ANALYTICS_RETENTION_DAYS', 31, 1, 366),
    rates,
    digestActor
  })
}
