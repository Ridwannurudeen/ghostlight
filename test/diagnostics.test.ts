import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@dcl/sdk/ecs', () => ({
  AvatarShape: {},
  Transform: {},
  UiCanvasInformation: { getOrNull: vi.fn(() => null) },
  engine: {
    RootEntity: 0,
    addSystem: vi.fn(),
    removeSystem: vi.fn(),
    getEntitiesWith: vi.fn(() => [])
  },
  Schemas: {
    Map: (value: unknown) => value,
    Array: (value: unknown) => value,
    Optional: (value: unknown) => value,
    String: 'string',
    Boolean: 'boolean',
    Number: 'number',
    Int: 'int',
    Int64: 'int64'
  }
}))

vi.mock('@dcl/sdk/network', () => ({
  registerMessages: () => ({
    send: vi.fn(),
    onMessage: vi.fn(),
    onReady: vi.fn(),
    isReady: () => false
  })
}))

vi.mock('@dcl/sdk/src/players', () => ({ getPlayer: () => null }))

import {
  DIAGNOSTICS_ASSET_TOTALS,
  DIAGNOSTICS_FRAME_WINDOW,
  DiagnosticsTracker,
  formatDiagnosticsBlock,
  formatDiagnosticsLines,
  initializeDiagnostics
} from '../src/client/diagnostics'
import { engine } from '@dcl/sdk/ecs'
import { createInitialFlowState, flowReducer } from '../src/client/flow'
import { DEFAULT_CLIENT_SETTINGS, getClientSettings, updateClientSettings } from '../src/client/settings'
import { DIAGNOSTICS_DEFAULT_ENABLED } from '../src/shared/config'
import { FIXED_NOW } from './test-helpers'

describe('diagnostics', () => {
  beforeEach(() => {
    updateClientSettings(DEFAULT_CLIENT_SETTINGS)
  })

  it('is disabled by default and does no frame or loop sampling while disabled', () => {
    const tracker = new DiagnosticsTracker()
    tracker.sampleFrame(1 / 60)
    tracker.updateScene(null, 79, 7)
    tracker.recordCharade(true)
    tracker.recordGuess(true, 1)
    tracker.recordPost(true)
    tracker.recordDisconnect()
    tracker.recordRecovery()

    expect(DIAGNOSTICS_DEFAULT_ENABLED).toBe(false)
    expect(DEFAULT_CLIENT_SETTINGS.diagnosticsEnabled).toBe(false)
    initializeDiagnostics()
    expect(engine.addSystem).not.toHaveBeenCalled()
    expect(tracker.snapshot('en', { ready: false, instanceId: '' })).toMatchObject({
      frame: { samples: 0 },
      transformEntities: null,
      avatarShapes: null,
      loop: {
        charades: 0,
        guesses: 0,
        firstTry: 0,
        recovered: 0,
        finalMisses: 0,
        posts: 0,
        mailSent: 0,
        mailReceived: 0
      },
      connection: { disconnects: 0, recoveries: 0 }
    })
  })

  it('keeps a rolling frame window and records verified session events', () => {
    const tracker = new DiagnosticsTracker()
    tracker.recordServerAttempt(1_000)
    tracker.recordServerReady(1_450)
    tracker.setEnabled(true)
    tracker.setEnvironment('mobile', true, 'interactable')
    for (let index = 0; index <= DIAGNOSTICS_FRAME_WINDOW; index += 1) tracker.sampleFrame(index === 0 ? 1 : 0.02)
    tracker.updateScene(null, 79, 7)
    tracker.recordPing(4, 2_000)
    tracker.recordPong(4, 2_042)
    tracker.recordCharade(true)
    tracker.recordGuess(true, 1)
    tracker.recordGuess(true, 2)
    tracker.recordGuess(false, 2)
    tracker.recordPost(false)
    tracker.recordPost(true)
    tracker.recordDisconnect()
    tracker.recordRecovery()

    expect(tracker.snapshot('pt', { ready: true, instanceId: 'server-1' })).toMatchObject({
      platform: 'mobile',
      mobile: true,
      language: 'pt',
      screenInsetMode: 'interactable',
      frame: {
        averageMilliseconds: 20,
        worstMilliseconds: 20,
        approximateFps: 50,
        samples: DIAGNOSTICS_FRAME_WINDOW
      },
      transformEntities: 79,
      avatarShapes: 7,
      server: { ready: true, instanceId: 'server-1', coldStartMilliseconds: 450, roundTripMilliseconds: 42 },
      loop: {
        charades: 1,
        guesses: 3,
        firstTry: 1,
        recovered: 1,
        finalMisses: 1,
        posts: 1,
        mailSent: 1,
        mailReceived: 1
      },
      connection: { disconnects: 1, recoveries: 1 }
    })
  })

  it('formats a compact null-safe clipboard block without uncontrolled text', () => {
    const tracker = new DiagnosticsTracker()
    const snapshot = tracker.snapshot('en', { ready: false, instanceId: 'bad\ninstance display name' })
    const block = formatDiagnosticsBlock(snapshot)

    expect(formatDiagnosticsLines(snapshot)).toHaveLength(6)
    expect(block.split('\n')).toHaveLength(7)
    expect(block).toMatch(/^GHOSTLIGHT_DIAGNOSTICS v1\n/)
    expect(block).toContain('frame.avg_ms=n/a')
    expect(block).toContain('server.state=waking')
    expect(block).toContain('server.instance=badinstancedisplayname')
    expect(block).toContain('outcome.first_try=0')
    expect(block).toContain('connection.disconnects=0')
    expect(block).not.toMatch(/undefined|null/)
  })

  it('keeps diagnostics settings outside the flow reducer state machine', () => {
    const state = flowReducer(createInitialFlowState(), {
      type: 'ready',
      instanceId: 'server-1',
      serverTime: FIXED_NOW,
      now: FIXED_NOW,
      theme: 'everyday',
      themeLabel: 'Everyday Escapades',
      playerAddress: '0xPlayer',
      playerName: 'Player'
    })

    updateClientSettings({ diagnosticsEnabled: true })
    updateClientSettings({ diagnosticsEnabled: false })

    expect(getClientSettings().diagnosticsEnabled).toBe(false)
    expect(state).toMatchObject({ ready: true, screen: 'foyer', instanceId: 'server-1' })
  })

  it('keeps compiled diagnostic asset totals synchronized with the generated manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'assets', 'models', 'manifest.json'), 'utf8')
    ) as { totals: { triangles: number; materials: string[] } }

    expect(DIAGNOSTICS_ASSET_TOTALS).toEqual({
      triangles: manifest.totals.triangles,
      materials: manifest.totals.materials.length
    })
  })
})
