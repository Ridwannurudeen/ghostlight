import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSceneRevealController, getRevealViewState } from '../src/client/reveal-scene'
import type { DecodeCharade } from '../src/client/flow'
import { makeLook } from './test-helpers'

vi.mock('@dcl/sdk/ecs', () => ({
  Billboard: { create: vi.fn() },
  TextShape: {
    createOrReplace: vi.fn(),
    deleteFrom: vi.fn(),
    getMutable: vi.fn(() => ({})),
    has: vi.fn(() => false)
  },
  Transform: { create: vi.fn(), createOrReplace: vi.fn() },
  Tween: { setMove: vi.fn() },
  engine: { addEntity: vi.fn(() => 1), addSystem: vi.fn() }
}))

vi.mock('@dcl/sdk/math', () => ({
  Color3: { create: (r: number, g: number, b: number) => ({ r, g, b }) },
  Color4: { create: (r: number, g: number, b: number, a: number) => ({ r, g, b, a }) },
  Vector3: { create: (x: number, y: number, z: number) => ({ x, y, z }) }
}))

vi.mock('../src/client/ghosts', () => ({
  freezePerformer: vi.fn(),
  playPerformerEmote: vi.fn(),
  react: vi.fn(),
  resumePerformer: vi.fn()
}))

vi.mock('../src/client/setup', () => ({ switchTheaterCamera: vi.fn() }))

vi.mock('../src/client/theater', () => ({
  curtains: { twitch: vi.fn() },
  lights: { set: vi.fn(), setSpotlightColor: vi.fn() }
}))

import { engine } from '@dcl/sdk/ecs'

const charade: DecodeCharade = {
  id: 'charade-1',
  authorName: 'Maya',
  authorAddress: '0xMaya',
  look: makeLook('0xMaya', 'Maya'),
  emotes: ['wave', 'clap', 'dab'],
  answers: ['Flying a kite', 'Walking a dog', 'Missing a train'],
  createdAt: 1,
  isHouse: false,
  authorTitle: ''
}

describe('scene reveal adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('animates the stats ribbon for a miss even when no floating hit text is created', () => {
    const audio = { play: vi.fn(), duck: vi.fn(), restore: vi.fn() }
    const controller = createSceneRevealController(audio)

    expect(engine.addSystem).toHaveBeenCalledTimes(1)
    controller.begin(charade, 1)
    controller.resolve(
      {
        charadeId: charade.id,
        correct: false,
        phrase: 'Flying a kite',
        stats: { correct: 7, total: 11 },
        yourScore: 2,
        daily: { day: '2026-08-23', decoded: 10, authored: 1, stamped: false },
        stampAwarded: false,
        title: 'Scene Stealer',
        nextUnlock: {
          nextTitle: 'Ghostlight Legend',
          requirement: '3 daily stamps and 25 correct decodes',
          progress: 0.4
        },
        titleUnlocked: true
      },
      charade
    )
    vi.advanceTimersByTime(6_000)

    const presentationSystem = vi.mocked(engine.addSystem).mock.calls[0][0]
    presentationSystem(0.8)

    expect(getRevealViewState()).toMatchObject({
      verdict: 'miss',
      stats: { correct: 7, total: 11 },
      titleProgress: 0.4,
      unlockedTitle: 'Scene Stealer'
    })
    expect(audio.play).toHaveBeenCalledWith('gasp')
    expect(audio.play).toHaveBeenCalledWith('unlock')
  })
})
