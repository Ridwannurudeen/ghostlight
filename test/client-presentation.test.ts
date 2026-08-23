import { describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const state = {
    ready: false,
    screen: 'waking',
    charade: null,
    pending: [],
    audience: [],
    reactionEvent: null
  }
  return {
    state,
    listener: null as ((state: typeof state) => void) | null,
    effects: null as Record<string, (...args: unknown[]) => unknown> | null,
    enterPerformer: null as (() => void) | null,
    showDecode: null as (() => void) | null,
    openingRunning: true,
    openingPlayed: false
  }
})

vi.mock('@dcl/sdk/ecs', () => ({ engine: { addSystem: vi.fn() } }))
vi.mock('@dcl/sdk/network', () => ({ isServer: vi.fn(() => false) }))

const flow = vi.hoisted(() => ({
  requestNextCharade: vi.fn(),
  startClientFlow: vi.fn()
}))

vi.mock('../src/client/flow', () => ({
  clientFlow: {
    getState: () => harness.state,
    setEffects: (effects: Record<string, (...args: unknown[]) => unknown>) => {
      harness.effects = effects
    },
    subscribe: (listener: (state: typeof harness.state) => void) => {
      harness.listener = listener
    },
    requestNextCharade: flow.requestNextCharade
  },
  startClientFlow: flow.startClientFlow
}))

const ghosts = vi.hoisted(() => ({
  clearPerformer: vi.fn(),
  clearPreview: vi.fn(),
  react: vi.fn(),
  replayPerformer: vi.fn(),
  setAudience: vi.fn(),
  showPerformer: vi.fn(),
  showPreview: vi.fn()
}))

vi.mock('../src/client/ghosts', () => ghosts)

const reveal = vi.hoisted(() => ({
  begin: vi.fn(),
  resolve: vi.fn(),
  skipToEnd: vi.fn(),
  cancel: vi.fn()
}))

vi.mock('../src/client/reveal-scene', () => ({ createSceneRevealController: vi.fn(() => reveal) }))

const opening = vi.hoisted(() => ({
  start: vi.fn(() => {
    harness.openingPlayed = true
    return true
  }),
  tick: vi.fn(),
  isRunning: vi.fn(() => harness.openingRunning),
  hasPlayed: vi.fn(() => harness.openingPlayed)
}))

vi.mock('../src/client/opening-scene', () => ({
  createSceneOpeningController: vi.fn((enterPerformer: () => void, showDecode: () => void) => {
    harness.enterPerformer = enterPerformer
    harness.showDecode = showDecode
    return opening
  })
}))

const setup = vi.hoisted(() => ({ startClientSetup: vi.fn() }))
vi.mock('../src/client/setup', () => setup)
vi.mock('../src/client/sound', () => ({
  duckForReveal: vi.fn(),
  play: vi.fn(),
  restoreAfterReveal: vi.fn()
}))
vi.mock('../src/client/ui', () => ({ uiComponent: vi.fn() }))
vi.mock('../src/server/server', () => ({ startServer: vi.fn() }))

import { engine } from '@dcl/sdk/ecs'
import { main } from '../src/index'

describe('client presentation integration', () => {
  it('wires cold-open staging, reveal effects, setup, and the automatic first charade', () => {
    main()

    expect(harness.effects).toMatchObject({
      beginReveal: reveal.begin,
      resolveReveal: reveal.resolve,
      skipReveal: reveal.skipToEnd,
      cancelReveal: reveal.cancel
    })
    expect(setup.startClientSetup).toHaveBeenCalledTimes(1)
    expect(flow.startClientFlow).toHaveBeenCalledTimes(1)
    expect(engine.addSystem).toHaveBeenCalledTimes(1)

    const look = { address: '0xMaya' }
    const emotes = ['wave', 'clap', 'dab']
    harness.effects!.showPerformer(look, emotes)
    expect(ghosts.showPerformer).not.toHaveBeenCalled()
    harness.enterPerformer!()
    expect(ghosts.showPerformer).toHaveBeenCalledWith(look, emotes)

    Object.assign(harness.state, { ready: true, screen: 'foyer' })
    harness.listener!(harness.state)
    expect(opening.start).toHaveBeenCalledWith('OPENING NIGHT')
    expect(flow.requestNextCharade).toHaveBeenCalledTimes(1)
  })
})
