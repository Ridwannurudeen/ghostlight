import { describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const state = {
    ready: false,
    screen: 'waking',
    charade: null,
    pending: [],
    audience: [],
    reactionEvent: null,
    themeLabel: 'Kitchen Capers',
    theme: 'food',
    ghostOfNight: null,
    notices: []
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
vi.mock('@dcl/sdk/src/players', () => ({ onLeaveScene: vi.fn() }))

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
  clearGhostOfNight: vi.fn(),
  clearPreview: vi.fn(),
  react: vi.fn(),
  replayPerformer: vi.fn(),
  setAudience: vi.fn(),
  showDuet: vi.fn(),
  showPerformer: vi.fn(),
  showGhostOfNight: vi.fn(),
  showPreview: vi.fn()
}))

vi.mock('../src/client/ghosts', () => ghosts)

const reveal = vi.hoisted(() => ({
  begin: vi.fn(),
  resolve: vi.fn(),
  hasShownVerdict: vi.fn(),
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
  cancel: vi.fn(),
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

const setup = vi.hoisted(() => ({ startClientSetup: vi.fn(), isPlayerInDecodeArea: vi.fn(() => true) }))
vi.mock('../src/client/setup', () => setup)
const sound = vi.hoisted(() => ({ duckForReveal: vi.fn(), play: vi.fn(), restoreAfterReveal: vi.fn() }))
const rewards = vi.hoisted(() => ({
  clearStageRewardProp: vi.fn(),
  refreshRewardProps: vi.fn(),
  removeRewardProp: vi.fn(),
  setRewardProp: vi.fn(),
  setStageRewardProp: vi.fn()
}))
vi.mock('../src/client/rewards', () => rewards)
vi.mock('../src/client/theater', () => ({
  lights: { setThemeAccent: vi.fn() },
  marquee: { setText: vi.fn() }
}))
vi.mock('../src/client/sound', () => sound)
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
      canAdvanceReveal: reveal.hasShownVerdict,
      skipReveal: reveal.skipToEnd,
      cancelReveal: reveal.cancel,
      clearPreview: ghosts.clearPreview,
      showReward: rewards.setRewardProp,
      showStageReward: rewards.setStageRewardProp,
      clearStageReward: rewards.clearStageRewardProp
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
    const reply = { look: { address: '0xReply' }, emotes: ['dance', 'wave', 'clap'] }
    harness.effects!.showDuet({ look, emotes }, reply)
    expect(ghosts.showDuet).toHaveBeenCalledWith({ look, emotes }, reply)

    Object.assign(harness.state, { ready: true, screen: 'foyer' })
    harness.listener!(harness.state)
    const openingSystem = vi.mocked(engine.addSystem).mock.calls[0][0]
    openingSystem(0)
    expect(opening.start).toHaveBeenCalledWith('Kitchen Capers', 'en')
    expect(flow.requestNextCharade).toHaveBeenCalledTimes(1)

    Object.assign(harness.state, { screen: 'posted', notices: [{ id: 'daily-1', kind: 'stamp' }] })
    harness.listener!(harness.state)
    harness.listener!(harness.state)
    expect(sound.play).toHaveBeenCalledTimes(1)
    expect(sound.play).toHaveBeenCalledWith('stamp')

    sound.play.mockClear()
    Object.assign(harness.state, { screen: 'reveal', notices: [{ id: 'reveal-1', kind: 'stamp' }] })
    harness.listener!(harness.state)
    Object.assign(harness.state, { screen: 'posted' })
    harness.listener!(harness.state)
    expect(sound.play).not.toHaveBeenCalled()

    ghosts.clearPerformer.mockClear()
    Object.assign(harness.state, { screen: 'reveal', author: null })
    harness.listener!(harness.state)
    Object.assign(harness.state, { screen: 'author', author: { replyTo: 'charade-1' } })
    harness.listener!(harness.state)
    expect(ghosts.clearPerformer).not.toHaveBeenCalled()
    Object.assign(harness.state, { screen: 'reveal', author: null })
    harness.listener!(harness.state)
    Object.assign(harness.state, { screen: 'author', author: {} })
    harness.listener!(harness.state)
    expect(ghosts.clearPerformer).toHaveBeenCalledTimes(1)
  })

  it('starts the opening from the ready foyer before the player reaches the decode area', () => {
    vi.mocked(engine.addSystem).mockClear()
    opening.start.mockClear()
    flow.requestNextCharade.mockClear()
    harness.openingPlayed = false
    harness.openingRunning = true
    setup.isPlayerInDecodeArea.mockReturnValue(false)
    Object.assign(harness.state, { ready: true, screen: 'foyer', charade: null, pending: [] })

    main()

    const openingSystem = vi.mocked(engine.addSystem).mock.calls[0][0]
    expect(setup.isPlayerInDecodeArea()).toBe(false)
    openingSystem(0)

    expect(opening.start).toHaveBeenCalledWith('Kitchen Capers', 'en')
    expect(flow.requestNextCharade).toHaveBeenCalledTimes(1)
  })
})
