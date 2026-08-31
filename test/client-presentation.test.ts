import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_NOW = Date.UTC(2026, 7, 23, 12)

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
    showKey: 'daily:2026-08-23',
    season: null as Record<string, unknown> | null,
    serverClockOffset: 0,
    ghostOfNight: null,
    notices: []
  }
  return {
    state,
    listener: null as ((state: typeof state) => void) | null,
    effects: null as Record<string, (...args: unknown[]) => unknown> | null,
    enterPerformer: null as (() => void) | null,
    showDecode: null as (() => void) | null,
    isServer: false,
    openingRunning: true,
    openingPlayed: false
  }
})

vi.mock('@dcl/sdk/ecs', () => ({ engine: { addSystem: vi.fn() } }))
vi.mock('@dcl/sdk/network', () => ({ isServer: vi.fn(() => harness.isServer) }))
vi.mock('@dcl/sdk/src/players', () => ({ onLeaveScene: vi.fn() }))

const flow = vi.hoisted(() => ({
  requestOpeningCharade: vi.fn(),
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
    requestOpeningCharade: flow.requestOpeningCharade,
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
  showAuthorBeat: vi.fn(),
  showPerformer: vi.fn(),
  showGhostOfNight: vi.fn(),
  showPreview: vi.fn()
}))

vi.mock('../src/client/ghosts', () => ghosts)

const reveal = vi.hoisted(() => ({
  begin: vi.fn(),
  resolve: vi.fn(),
  hasShownVerdict: vi.fn(),
  canAdvance: vi.fn(),
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

const setup = vi.hoisted(() => ({
  startClientSetup: vi.fn(),
  isPlayerInDecodeArea: vi.fn(() => true),
  switchTheaterCamera: vi.fn(),
  releaseTheaterCamera: vi.fn()
}))
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
const theater = vi.hoisted(() => ({ setThemeAccent: vi.fn(), setText: vi.fn() }))
vi.mock('../src/client/theater', () => ({
  lights: { setThemeAccent: theater.setThemeAccent },
  marquee: { setText: theater.setText }
}))
vi.mock('../src/client/sound', () => sound)
vi.mock('../src/client/ui', () => ({ uiComponent: vi.fn() }))
const server = vi.hoisted(() => ({ startServer: vi.fn() }))
vi.mock('../src/server/server', () => server)

import { engine } from '@dcl/sdk/ecs'
import { main } from '../src/index'
import { updateClientSettings } from '../src/client/settings'
import { t, themeLabel } from '../src/shared/i18n'
import { SEASON_ZERO_WEEKS, type SeasonWeek } from '../src/shared/seasons'
import { showPolicyForTimestamp } from '../src/shared/show-policy'

function seasonMetadata(week: SeasonWeek) {
  return {
    id: 'season-zero',
    weekId: week.id,
    startsAt: week.eligibility.startsAt,
    endsAt: week.eligibility.endsAt,
    titleId: week.title.id,
    propId: week.prop.id,
    finale: {
      id: week.finale.id,
      startsAt: week.finale.window.startsAt,
      endsAt: week.finale.window.endsAt
    }
  }
}

describe('client presentation integration', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW)
  })

  afterEach(() => {
    harness.isServer = false
    vi.restoreAllMocks()
  })

  it('starts only the authoritative server path in the server runtime', () => {
    harness.isServer = true
    server.startServer.mockClear()
    setup.startClientSetup.mockClear()
    flow.startClientFlow.mockClear()
    vi.mocked(engine.addSystem).mockClear()

    main()

    expect(server.startServer).toHaveBeenCalledOnce()
    expect(setup.startClientSetup).not.toHaveBeenCalled()
    expect(flow.startClientFlow).not.toHaveBeenCalled()
    expect(engine.addSystem).not.toHaveBeenCalled()
  })

  it('wires cold-open staging, reveal effects, setup, and the automatic first charade', () => {
    main()

    expect(harness.effects).toMatchObject({
      beginReveal: reveal.begin,
      resolveReveal: reveal.resolve,
      canAdvanceReveal: reveal.canAdvance,
      skipReveal: reveal.skipToEnd,
      cancelReveal: reveal.cancel,
      clearPreview: ghosts.clearPreview,
      showReward: rewards.setRewardProp,
      showStageReward: rewards.setStageRewardProp,
      clearStageReward: rewards.clearStageRewardProp
    })
    harness.effects!.acquirePracticeCamera()
    expect(setup.switchTheaterCamera).toHaveBeenCalledWith('stage')
    harness.effects!.releasePracticeCamera()
    expect(setup.releaseTheaterCamera).toHaveBeenCalledTimes(1)
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
    expect(opening.start).toHaveBeenCalledWith(themeLabel(showPolicyForTimestamp(TEST_NOW)!.legacyTheme.id, 'en'), 'en')
    expect(flow.requestOpeningCharade).toHaveBeenCalledTimes(1)
    expect(flow.requestNextCharade).not.toHaveBeenCalled()

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
    flow.requestOpeningCharade.mockClear()
    flow.requestNextCharade.mockClear()
    harness.openingPlayed = false
    harness.openingRunning = true
    setup.isPlayerInDecodeArea.mockReturnValue(false)
    Object.assign(harness.state, { ready: true, screen: 'foyer', charade: null, pending: [] })

    main()

    const openingSystem = vi.mocked(engine.addSystem).mock.calls[0][0]
    expect(setup.isPlayerInDecodeArea()).toBe(false)
    openingSystem(0)

    expect(opening.start).toHaveBeenCalledWith(themeLabel(showPolicyForTimestamp(TEST_NOW)!.legacyTheme.id, 'en'), 'en')
    expect(flow.requestOpeningCharade).toHaveBeenCalledTimes(1)
    expect(flow.requestNextCharade).not.toHaveBeenCalled()

    Object.assign(harness.state, { pending: [{ kind: 'nextCharade' }] })
    harness.showDecode!()
    expect(flow.requestOpeningCharade).toHaveBeenCalledTimes(1)

    Object.assign(harness.state, { pending: [] })
    flow.requestOpeningCharade.mockClear()
    harness.showDecode!()
    expect(flow.requestOpeningCharade).toHaveBeenCalledTimes(1)
    expect(flow.requestNextCharade).not.toHaveBeenCalled()
  })

  it('discards a staged opening performer when the opening is cancelled', () => {
    ghosts.showPerformer.mockClear()
    opening.cancel.mockClear()
    harness.openingRunning = true

    main()
    const look = { address: '0xCancelled' }
    const emotes = ['wave', 'clap', 'dab']
    harness.effects!.showPerformer(look, emotes)
    expect(ghosts.showPerformer).not.toHaveBeenCalled()

    harness.effects!.cancelOpening()
    harness.enterPerformer!()

    expect(opening.cancel).toHaveBeenCalledTimes(1)
    expect(ghosts.showPerformer).not.toHaveBeenCalled()
  })

  it('uses local weekly show names for the marquee and cold opening across language and same-theme week changes', () => {
    const first = SEASON_ZERO_WEEKS[0]
    const second = SEASON_ZERO_WEEKS[1]
    vi.mocked(engine.addSystem).mockClear()
    opening.start.mockClear()
    flow.requestOpeningCharade.mockClear()
    flow.requestNextCharade.mockClear()
    theater.setText.mockClear()
    rewards.setRewardProp.mockClear()
    rewards.setStageRewardProp.mockClear()
    harness.openingPlayed = false
    harness.openingRunning = true
    updateClientSettings({ language: 'en' })
    vi.mocked(Date.now).mockReturnValue(first.eligibility.startsAt + 1)
    Object.assign(harness.state, {
      ready: true,
      screen: 'foyer',
      charade: null,
      pending: [],
      theme: 'food',
      themeLabel: 'UNTRUSTED SERVER SHOW',
      showKey: '',
      season: null
    })

    main()
    harness.listener!(harness.state)
    const openingSystem = vi.mocked(engine.addSystem).mock.calls[0][0]
    openingSystem(0)
    expect(opening.start).not.toHaveBeenCalled()
    expect(flow.requestOpeningCharade).not.toHaveBeenCalled()
    expect(flow.requestNextCharade).not.toHaveBeenCalled()

    Object.assign(harness.state, {
      showKey: `season-zero:${first.id}`,
      season: seasonMetadata(first)
    })
    harness.listener!(harness.state)
    expect(theater.setText).toHaveBeenLastCalledWith(t('marquee.tonightShow', 'en', { theme: first.name.en }))

    openingSystem(0)
    expect(opening.start).toHaveBeenCalledWith(first.name.en, 'en')

    vi.mocked(Date.now).mockReturnValue(second.eligibility.startsAt + 1)
    Object.assign(harness.state, {
      showKey: `season-zero:${second.id}`,
      season: seasonMetadata(second),
      theme: 'food'
    })
    harness.listener!(harness.state)
    expect(theater.setText).toHaveBeenLastCalledWith(t('marquee.tonightShow', 'en', { theme: second.name.en }))

    updateClientSettings({ language: 'es' })
    expect(theater.setText).toHaveBeenLastCalledWith(t('marquee.tonightShow', 'es', { theme: second.name.es }))
    expect(theater.setText.mock.calls.some(([value]) => String(value).includes('UNTRUSTED SERVER SHOW'))).toBe(false)
    expect(rewards.setRewardProp).not.toHaveBeenCalled()
    expect(rewards.setStageRewardProp).not.toHaveBeenCalled()
    updateClientSettings({ language: 'en' })
  })

  it('suppresses a stale weekly marquee and cold opening until the rollover schedule arrives', () => {
    const previous = SEASON_ZERO_WEEKS[0]
    const boundary = SEASON_ZERO_WEEKS[1].eligibility.startsAt
    const currentPolicy = showPolicyForTimestamp(boundary)!
    vi.mocked(Date.now).mockReturnValue(boundary)
    vi.mocked(engine.addSystem).mockClear()
    opening.start.mockClear()
    flow.requestOpeningCharade.mockClear()
    flow.requestNextCharade.mockClear()
    theater.setText.mockClear()
    harness.openingPlayed = false
    harness.openingRunning = true
    updateClientSettings({ language: 'en' })
    Object.assign(harness.state, {
      ready: true,
      screen: 'foyer',
      charade: null,
      pending: [],
      theme: 'food',
      showKey: `season-zero:${previous.id}`,
      season: seasonMetadata(previous),
      serverClockOffset: 0
    })

    main()
    harness.listener!(harness.state)
    const openingSystem = vi.mocked(engine.addSystem).mock.calls[0][0]
    openingSystem(0)

    expect(opening.start).not.toHaveBeenCalled()
    expect(flow.requestOpeningCharade).not.toHaveBeenCalled()
    expect(flow.requestNextCharade).not.toHaveBeenCalled()
    expect(theater.setText).toHaveBeenLastCalledWith(
      t('marquee.tonightShow', 'en', { theme: themeLabel(currentPolicy.legacyTheme.id, 'en') })
    )
    expect(theater.setText.mock.calls.some(([value]) => String(value).includes(previous.name.en))).toBe(false)
  })
})
