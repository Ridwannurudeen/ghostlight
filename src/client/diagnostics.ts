import { AvatarShape, Transform, UiCanvasInformation, engine } from '@dcl/sdk/ecs'
import type { Platform } from '@dcl/sdk/platform'
import type { Language } from '../shared/i18n'
import { getClientSettings, subscribeClientSettings } from './settings'

const DIAGNOSTICS_SYSTEM = 'ghostlight::diagnostics'
const SCENE_SAMPLE_SECONDS = 1

export const DIAGNOSTICS_FRAME_WINDOW = 120
export const DIAGNOSTICS_ASSET_TOTALS = { triangles: 6_324, materials: 5 } as const

export type ScreenInsetMode = 'device' | 'interactable'

type Insets = Readonly<{
  top: number
  right: number
  bottom: number
  left: number
}>

export type DiagnosticsCanvas = Readonly<{
  width: number
  height: number
  devicePixelRatio: number
  safeArea: Insets | null
  interactableArea: Insets | null
}>

export type DiagnosticsSnapshot = Readonly<{
  platform: Platform | null
  mobile: boolean | null
  language: Language
  screenInsetMode: ScreenInsetMode | null
  canvas: DiagnosticsCanvas | null
  frame: {
    averageMilliseconds: number | null
    worstMilliseconds: number | null
    approximateFps: number | null
    samples: number
  }
  transformEntities: number | null
  avatarShapes: number | null
  server: {
    ready: boolean
    instanceId: string
    coldStartMilliseconds: number | null
    roundTripMilliseconds: number | null
  }
  loop: {
    charades: number
    guesses: number
    posts: number
    mailSent: number
    mailReceived: number
  }
}>

export class DiagnosticsTracker {
  private enabled = false
  private platform: Platform | null = null
  private mobile: boolean | null = null
  private screenInsetMode: ScreenInsetMode | null = null
  private canvas: DiagnosticsCanvas | null = null
  private frameMilliseconds: number[] = []
  private transformEntities: number | null = null
  private avatarShapes: number | null = null
  private firstServerAttemptAt: number | null = null
  private coldStartMilliseconds: number | null = null
  private roundTripMilliseconds: number | null = null
  private pingSentAt = new Map<number, number>()
  private loop = { charades: 0, guesses: 0, posts: 0, mailSent: 0, mailReceived: 0 }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    if (!enabled) this.pingSentAt.clear()
  }

  setEnvironment(platform: Platform, mobile: boolean, screenInsetMode: ScreenInsetMode) {
    this.platform = platform
    this.mobile = mobile
    this.screenInsetMode = screenInsetMode
  }

  sampleFrame(deltaSeconds: number) {
    if (!this.enabled || !Number.isFinite(deltaSeconds) || deltaSeconds < 0) return
    this.frameMilliseconds.push(deltaSeconds * 1_000)
    if (this.frameMilliseconds.length > DIAGNOSTICS_FRAME_WINDOW) this.frameMilliseconds.shift()
  }

  updateScene(canvas: DiagnosticsCanvas | null, transformEntities: number, avatarShapes: number) {
    if (!this.enabled) return
    this.canvas = canvas
    this.transformEntities = transformEntities
    this.avatarShapes = avatarShapes
  }

  recordServerAttempt(now: number) {
    if (this.coldStartMilliseconds === null && this.firstServerAttemptAt === null) this.firstServerAttemptAt = now
  }

  recordServerReady(now: number) {
    if (this.coldStartMilliseconds !== null || this.firstServerAttemptAt === null) return
    this.coldStartMilliseconds = Math.max(0, now - this.firstServerAttemptAt)
  }

  recordPing(sequence: number, now: number) {
    if (!this.enabled) return
    this.pingSentAt.set(sequence, now)
    if (this.pingSentAt.size > 4) this.pingSentAt.delete(this.pingSentAt.keys().next().value!)
  }

  recordPong(sequence: number, now: number) {
    if (!this.enabled) return
    const sentAt = this.pingSentAt.get(sequence)
    if (sentAt === undefined) return
    this.pingSentAt.delete(sequence)
    this.roundTripMilliseconds = Math.max(0, now - sentAt)
  }

  recordCharade(mail: boolean) {
    if (!this.enabled) return
    this.loop.charades += 1
    if (mail) this.loop.mailReceived += 1
  }

  recordGuess() {
    if (this.enabled) this.loop.guesses += 1
  }

  recordPost(mail: boolean) {
    if (!this.enabled) return
    if (mail) this.loop.mailSent += 1
    else this.loop.posts += 1
  }

  snapshot(language: Language, server: { ready: boolean; instanceId: string }): DiagnosticsSnapshot {
    const totalFrameMilliseconds = this.frameMilliseconds.reduce((total, value) => total + value, 0)
    const averageMilliseconds = this.frameMilliseconds.length
      ? totalFrameMilliseconds / this.frameMilliseconds.length
      : null
    const worstMilliseconds = this.frameMilliseconds.length ? Math.max(...this.frameMilliseconds) : null
    return {
      platform: this.platform,
      mobile: this.mobile,
      language,
      screenInsetMode: this.screenInsetMode,
      canvas: this.canvas,
      frame: {
        averageMilliseconds,
        worstMilliseconds,
        approximateFps: averageMilliseconds && averageMilliseconds > 0 ? 1_000 / averageMilliseconds : null,
        samples: this.frameMilliseconds.length
      },
      transformEntities: this.transformEntities,
      avatarShapes: this.avatarShapes,
      server: {
        ready: server.ready,
        instanceId: server.instanceId,
        coldStartMilliseconds: this.coldStartMilliseconds,
        roundTripMilliseconds: this.roundTripMilliseconds
      },
      loop: { ...this.loop }
    }
  }
}

export const diagnosticsTracker = new DiagnosticsTracker()

let initialized = false
let sampling = false
let sceneSampleElapsed = SCENE_SAMPLE_SECONDS

export function initializeDiagnostics() {
  if (initialized) return
  initialized = true
  setDiagnosticsEnabled(getClientSettings().diagnosticsEnabled)
  subscribeClientSettings((settings) => setDiagnosticsEnabled(settings.diagnosticsEnabled))
}

export function configureDiagnosticsEnvironment(
  platform: Platform,
  mobile: boolean,
  screenInsetMode: ScreenInsetMode
) {
  diagnosticsTracker.setEnvironment(platform, mobile, screenInsetMode)
}

export function recordDiagnosticsServerAttempt(now: number) {
  diagnosticsTracker.recordServerAttempt(now)
}

export function recordDiagnosticsServerReady(now: number) {
  diagnosticsTracker.recordServerReady(now)
}

export function recordDiagnosticsPing(sequence: number, now: number) {
  diagnosticsTracker.recordPing(sequence, now)
}

export function recordDiagnosticsPong(sequence: number, now: number) {
  diagnosticsTracker.recordPong(sequence, now)
}

export function recordDiagnosticsCharade(mail: boolean) {
  diagnosticsTracker.recordCharade(mail)
}

export function recordDiagnosticsGuess() {
  diagnosticsTracker.recordGuess()
}

export function recordDiagnosticsPost(mail: boolean) {
  diagnosticsTracker.recordPost(mail)
}

export function getDiagnosticsSnapshot(
  language: Language,
  server: { ready: boolean; instanceId: string }
): DiagnosticsSnapshot {
  return diagnosticsTracker.snapshot(language, server)
}

export function formatDiagnosticsBlock(snapshot: DiagnosticsSnapshot) {
  return ['GHOSTLIGHT_DIAGNOSTICS v1', ...formatDiagnosticsLines(snapshot)].join('\n')
}

export function formatDiagnosticsLines(snapshot: DiagnosticsSnapshot) {
  const canvas = snapshot.canvas
  return [
    `platform=${snapshot.platform ?? 'n/a'} mobile=${formatBoolean(snapshot.mobile)} language=${snapshot.language} inset=${snapshot.screenInsetMode ?? 'n/a'}`,
    `canvas.width=${formatNumber(canvas?.width)} canvas.height=${formatNumber(canvas?.height)} canvas.dpr=${formatNumber(canvas?.devicePixelRatio)} safe=${formatInsets(canvas?.safeArea)} interactable=${formatInsets(canvas?.interactableArea)}`,
    `frame.avg_ms=${formatNumber(snapshot.frame.averageMilliseconds)} frame.worst_ms=${formatNumber(snapshot.frame.worstMilliseconds)} frame.approx_fps=${formatNumber(snapshot.frame.approximateFps)} frame.samples=${snapshot.frame.samples}`,
    `scene.transform_entities=${formatNumber(snapshot.transformEntities, 0)} scene.avatar_shapes=${formatNumber(snapshot.avatarShapes, 0)} assets.triangles=${DIAGNOSTICS_ASSET_TOTALS.triangles} assets.materials=${DIAGNOSTICS_ASSET_TOTALS.materials}`,
    `server.state=${snapshot.server.ready ? 'ready' : 'waking'} server.instance=${safeToken(snapshot.server.instanceId)} server.cold_start_ms=${formatNumber(snapshot.server.coldStartMilliseconds, 0)} server.rtt_ms=${formatNumber(snapshot.server.roundTripMilliseconds, 0)}`,
    `loop.charades=${snapshot.loop.charades} loop.guesses=${snapshot.loop.guesses} loop.posts=${snapshot.loop.posts} loop.mail_sent=${snapshot.loop.mailSent} loop.mail_received=${snapshot.loop.mailReceived}`
  ]
}

function setDiagnosticsEnabled(enabled: boolean) {
  diagnosticsTracker.setEnabled(enabled)
  if (enabled === sampling) return
  sampling = enabled
  if (enabled) {
    sceneSampleElapsed = SCENE_SAMPLE_SECONDS
    engine.addSystem(diagnosticsSamplingSystem, undefined, DIAGNOSTICS_SYSTEM)
  } else {
    engine.removeSystem(DIAGNOSTICS_SYSTEM)
  }
}

function diagnosticsSamplingSystem(deltaSeconds: number) {
  diagnosticsTracker.sampleFrame(deltaSeconds)
  sceneSampleElapsed += deltaSeconds
  if (sceneSampleElapsed < SCENE_SAMPLE_SECONDS) return
  sceneSampleElapsed = 0

  const canvasInformation = UiCanvasInformation.getOrNull(engine.RootEntity)
  const canvas = canvasInformation
    ? {
        width: canvasInformation.width,
        height: canvasInformation.height,
        devicePixelRatio: canvasInformation.devicePixelRatio,
        safeArea: copyInsets(canvasInformation.screenInsetArea),
        interactableArea: copyInsets(canvasInformation.interactableArea)
      }
    : null
  diagnosticsTracker.updateScene(
    canvas,
    countEntitiesWith(Transform),
    countEntitiesWith(AvatarShape)
  )
}

function countEntitiesWith(component: typeof Transform | typeof AvatarShape) {
  let count = 0
  for (const _ of engine.getEntitiesWith(component)) count += 1
  return count
}

function copyInsets(insets: Insets | undefined) {
  return insets
    ? { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left }
    : null
}

function formatInsets(insets: Insets | null | undefined) {
  return insets
    ? `t${formatNumber(insets.top)}:r${formatNumber(insets.right)}:b${formatNumber(insets.bottom)}:l${formatNumber(insets.left)}`
    : 'n/a'
}

function formatBoolean(value: boolean | null) {
  return value === null ? 'n/a' : String(value)
}

function formatNumber(value: number | null | undefined, fractionDigits = 1) {
  return value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : value.toFixed(fractionDigits)
}

function safeToken(value: string | null | undefined) {
  const token = (value ?? '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 64)
  return token || 'n/a'
}
