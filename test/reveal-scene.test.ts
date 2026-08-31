import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSceneRevealController, getRevealViewState } from '../src/client/reveal-scene'
import type { DecodeCharade } from '../src/client/flow'
import { DEFAULT_CLIENT_SETTINGS, updateClientSettings } from '../src/client/settings'
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
  replayPerformerBeat: vi.fn(),
  resumePerformer: vi.fn()
}))

vi.mock('../src/client/setup', () => ({ switchTheaterCamera: vi.fn(), releaseTheaterCamera: vi.fn() }))

vi.mock('../src/client/theater', () => ({
  curtains: { twitch: vi.fn() },
  lights: { set: vi.fn(), setSpotlightColor: vi.fn() }
}))

import { Tween, engine } from '@dcl/sdk/ecs'
import { playPerformerEmote, react, replayPerformerBeat } from '../src/client/ghosts'
import { releaseTheaterCamera, switchTheaterCamera } from '../src/client/setup'
import { curtains, lights } from '../src/client/theater'

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
    updateClientSettings(DEFAULT_CLIENT_SETTINGS)
  })

  afterEach(() => {
    updateClientSettings(DEFAULT_CLIENT_SETTINGS)
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

  it('removes camera and tween motion but preserves the full reduced-motion result and reset', () => {
    updateClientSettings({ reducedMotion: true })
    const audio = { play: vi.fn(), duck: vi.fn(), restore: vi.fn() }
    const controller = createSceneRevealController(audio)

    controller.begin(charade, 0)
    controller.resolve(
      {
        charadeId: charade.id,
        correct: true,
        phrase: 'Flying a kite',
        stats: { correct: 7, total: 11 },
        yourScore: 2,
        daily: { day: '2026-08-23', decoded: 10, authored: 1, stamped: true },
        stampAwarded: true,
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
    vi.advanceTimersByTime(3_000)

    expect(switchTheaterCamera).not.toHaveBeenCalled()
    expect(curtains.twitch).not.toHaveBeenCalled()
    expect(Tween.setMove).not.toHaveBeenCalled()
    expect(releaseTheaterCamera).toHaveBeenCalledTimes(1)
    expect(getRevealViewState()).toMatchObject({
      verdict: 'hit',
      verdictText: 'YOU GOT IT',
      stats: { correct: 7, total: 11 },
      titleProgress: 0.4,
      unlockedTitle: 'Scene Stealer',
      complete: true
    })
    expect(audio.play.mock.calls.map(([name]) => name)).toEqual([
      'tick',
      'drumroll',
      'sting',
      'hit',
      'applause',
      'unlock',
      'stamp'
    ])
    expect(audio.restore).toHaveBeenCalledTimes(1)
  })

  it('restores an authoritative completed reveal without replaying choreography, audio, or stats', () => {
    updateClientSettings({ reducedMotion: true })
    const audio = { play: vi.fn(), duck: vi.fn(), restore: vi.fn() }
    const controller = createSceneRevealController(audio)
    const reveal = {
      charadeId: charade.id,
      correct: true,
      phrase: 'Flying a kite',
      stats: { correct: 7, total: 11 },
      yourScore: 2,
      daily: { day: '2026-08-23', decoded: 10, authored: 1, stamped: true },
      stampAwarded: true,
      title: 'Scene Stealer' as const,
      nextUnlock: {
        nextTitle: 'Ghostlight Legend' as const,
        requirement: '3 daily stamps and 25 correct decodes',
        progress: 0.4
      },
      titleUnlocked: true
    }
    controller.begin(charade, 1)
    controller.resolve(reveal, charade)
    vi.advanceTimersByTime(3_000)
    expect(controller.canAdvance()).toBe(true)
    controller.cancel()
    expect(getRevealViewState()).toMatchObject({ active: false, answerRevealed: false })
    vi.clearAllMocks()

    expect(controller.restore(reveal, charade)).toBe(true)

    expect(controller.canAdvance()).toBe(true)
    expect(getRevealViewState()).toMatchObject({
      active: true,
      answersLocked: true,
      selectedAnswerIndex: 1,
      phrase: 'Flying a kite',
      answerRevealed: true,
      correct: true,
      verdict: 'hit',
      verdictText: 'YOU GOT IT',
      stats: { correct: 7, total: 11 },
      titleProgress: 0.4,
      unlockedTitle: 'Scene Stealer',
      stampAwarded: true,
      complete: true
    })
    expect(audio.play).not.toHaveBeenCalled()
    expect(audio.duck).not.toHaveBeenCalled()
    expect(audio.restore).not.toHaveBeenCalled()
    expect(playPerformerEmote).not.toHaveBeenCalled()
    expect(react).not.toHaveBeenCalled()
    expect(switchTheaterCamera).not.toHaveBeenCalled()
    expect(lights.set).not.toHaveBeenCalled()
  })

  it.each([
    { correct: true, scoreDelta: 175, verdict: 'hit', text: 'SPOTLIGHT PAID OFF · +175' },
    { correct: false, scoreDelta: -75, verdict: 'miss', text: 'SPOTLIGHT MISSED · −75' }
  ] as const)('visibly resolves the server-confirmed Spotlight stake for a $verdict', (outcome) => {
    updateClientSettings({ reducedMotion: true })
    const audio = { play: vi.fn(), duck: vi.fn(), restore: vi.fn() }
    const controller = createSceneRevealController(audio)

    controller.begin(charade, 0)
    controller.resolve(
      {
        charadeId: charade.id,
        correct: outcome.correct,
        phrase: 'Flying a kite',
        stats: { correct: outcome.correct ? 1 : 0, total: 1 },
        yourScore: outcome.correct ? 1 : 0,
        daily: { day: '2026-08-25', decoded: 1, authored: 0, stamped: false },
        stampAwarded: false,
        title: '',
        nextUnlock: {
          nextTitle: 'Understudy',
          requirement: 'Post your first charade',
          progress: 0
        },
        titleUnlocked: false,
        spotlight: true,
        scoreDelta: outcome.scoreDelta
      },
      charade
    )
    vi.advanceTimersByTime(800)

    expect(getRevealViewState()).toMatchObject({ verdict: outcome.verdict, verdictText: outcome.text })
  })

  it('does not invent a Spotlight amount when the authoritative delta is absent', () => {
    updateClientSettings({ reducedMotion: true })
    const controller = createSceneRevealController({ play: vi.fn(), duck: vi.fn(), restore: vi.fn() })

    controller.begin(charade, 0)
    controller.resolve(
      {
        charadeId: charade.id,
        correct: true,
        phrase: 'Flying a kite',
        stats: { correct: 1, total: 1 },
        yourScore: 1,
        daily: { day: '2026-08-25', decoded: 1, authored: 0, stamped: false },
        stampAwarded: false,
        title: '',
        nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 },
        titleUnlocked: false,
        spotlight: true
      },
      charade
    )
    vi.advanceTimersByTime(800)

    expect(getRevealViewState()).toMatchObject({ verdict: 'hit', verdictText: 'YOU GOT IT' })
  })

  it('resolves answer ids, verdict copy, and titles in the selected language', () => {
    updateClientSettings({ language: 'pt', reducedMotion: true })
    const audio = { play: vi.fn(), duck: vi.fn(), restore: vi.fn() }
    const controller = createSceneRevealController(audio)
    const localizedCharade: DecodeCharade = {
      ...charade,
      answerIds: ['everyday-wake-up-late', 'everyday-brush-your-teeth', 'everyday-miss-the-bus']
    }

    controller.begin(localizedCharade, 0)
    controller.resolve(
      {
        charadeId: charade.id,
        correct: true,
        phraseId: 'everyday-wake-up-late',
        phrase: 'Wake up late',
        stats: { correct: 1, total: 1 },
        yourScore: 1,
        daily: { day: '2026-08-23', decoded: 1, authored: 0, stamped: false },
        stampAwarded: false,
        title: 'Scene Stealer',
        nextUnlock: {
          nextTitle: 'Ghostlight Legend',
          requirement: '3 daily stamps and 25 correct decodes',
          progress: 0.4
        },
        titleUnlocked: true
      },
      localizedCharade
    )
    vi.advanceTimersByTime(3_000)

    expect(getRevealViewState()).toMatchObject({
      answers: ['Acordar atrasado', 'Escovar os dentes', 'Perder o ônibus'],
      phrase: 'Acordar atrasado',
      verdictText: 'VOCÊ ACERTOU!',
      unlockedTitle: 'Rouba-cena'
    })
  })

  it('spotlights only the selected retry beat for 2.5 seconds', () => {
    const controller = createSceneRevealController({ play: vi.fn(), duck: vi.fn(), restore: vi.fn() })
    const presentationSystem = vi.mocked(engine.addSystem).mock.calls[0][0]

    controller.retry(2)

    expect(lights.set).toHaveBeenCalledWith('tension')
    expect(lights.setSpotlightColor).toHaveBeenCalledWith('white')
    expect(replayPerformerBeat).toHaveBeenCalledWith(2)
    presentationSystem(2.49)
    expect(lights.set).not.toHaveBeenCalledWith('house')
    presentationSystem(0.01)
    expect(lights.set).toHaveBeenCalledWith('house')
  })

  it('keeps the retry cue and staged second-miss verdict under reduced motion without avatar motion', () => {
    updateClientSettings({ reducedMotion: true })
    const audio = { play: vi.fn(), duck: vi.fn(), restore: vi.fn() }
    const controller = createSceneRevealController(audio)

    controller.retry(1)
    expect(replayPerformerBeat).not.toHaveBeenCalled()
    controller.begin(charade, 0)
    controller.resolve(
      {
        charadeId: charade.id,
        correct: false,
        phrase: 'Flying a kite',
        stats: { correct: 0, total: 1 },
        yourScore: 0,
        daily: { day: '2026-08-26', decoded: 1, authored: 0, stamped: false },
        stampAwarded: false,
        title: '',
        nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 },
        titleUnlocked: false,
        spotlight: true,
        scoreDelta: -100,
        attempt: 2
      },
      charade
    )

    vi.advanceTimersByTime(800)
    expect(getRevealViewState()).toMatchObject({
      answerRevealed: false,
      verdict: 'miss',
      verdictText: 'THE GHOST GOT YOU · SPOTLIGHT −100'
    })
    expect(audio.play).toHaveBeenCalledWith('laugh')
    expect(react).not.toHaveBeenCalled()
    expect(playPerformerEmote).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(getRevealViewState()).toMatchObject({ answerRevealed: true, phrase: 'Flying a kite' })
  })

  it.each([
    { label: 'standard', verdictAt: 2_600, phraseAt: 4_000 },
    { label: 'ordinary', verdictAt: 1_000, phraseAt: 1_700 },
    { label: 'reduced motion', verdictAt: 800, phraseAt: 1_300 }
  ])('cannot advance a $label second miss before the phrase card', ({ label, verdictAt, phraseAt }) => {
    if (label === 'reduced motion') updateClientSettings({ reducedMotion: true })
    const controller = createSceneRevealController({ play: vi.fn(), duck: vi.fn(), restore: vi.fn() })
    if (label === 'ordinary') {
      controller.begin(charade, 0)
      controller.resolve(
        {
          charadeId: charade.id,
          correct: true,
          phrase: 'Flying a kite',
          stats: { correct: 1, total: 1 },
          yourScore: 1,
          daily: { day: '2026-08-26', decoded: 1, authored: 0, stamped: false },
          stampAwarded: false,
          title: '',
          nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 },
          titleUnlocked: false
        },
        charade
      )
      vi.advanceTimersByTime(2_600)
      controller.cancel()
    }
    controller.begin(charade, 0)
    controller.resolve(
      {
        charadeId: charade.id,
        correct: false,
        phrase: 'Flying a kite',
        stats: { correct: 0, total: 1 },
        yourScore: 0,
        daily: { day: '2026-08-26', decoded: 1, authored: 0, stamped: false },
        stampAwarded: false,
        title: '',
        nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 },
        titleUnlocked: false,
        attempt: 2
      },
      charade
    )

    vi.advanceTimersByTime(verdictAt)
    expect(controller.canAdvance()).toBe(false)
    expect(getRevealViewState()).toMatchObject({ verdict: 'miss', answerRevealed: false })
    vi.advanceTimersByTime(phraseAt - verdictAt)
    expect(controller.canAdvance()).toBe(true)
    expect(getRevealViewState()).toMatchObject({ answerRevealed: true, phrase: 'Flying a kite' })
  })
})
