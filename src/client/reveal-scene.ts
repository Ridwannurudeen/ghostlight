import { Billboard, TextShape, Transform, Tween, engine, type Entity } from '@dcl/sdk/ecs'
import { Color3, Color4, Vector3 } from '@dcl/sdk/math'
import type { DecodeCharade, RevealResult } from './flow'
import { freezePerformer, playPerformerEmote, react, resumePerformer } from './ghosts'
import {
  createRevealController,
  type RevealClock,
  type RevealEffects,
  type RevealSoundName,
  type RevealStats
} from './reveal'
import { switchTheaterCamera } from './setup'
import { curtains, lights } from './theater'

export type RevealAudioPort = {
  play(name: RevealSoundName): void
  duck(): void
  restore(): void
}

export type RevealViewState = {
  active: boolean
  answersLocked: boolean
  wrongAnswersFaded: boolean
  selectedAnswerIndex: number
  answers: readonly string[]
  phrase: string
  correct: boolean | null
  verdict: 'hit' | 'miss' | null
  verdictText: string
  stats: RevealStats | null
  titleProgress: number
  complete: boolean
}

const EMPTY_REVEAL_VIEW: RevealViewState = {
  active: false,
  answersLocked: false,
  wrongAnswersFaded: false,
  selectedAnswerIndex: -1,
  answers: [],
  phrase: '',
  correct: null,
  verdict: null,
  verdictText: '',
  stats: null,
  titleProgress: 0,
  complete: false
}

const FLOATING_START = Vector3.create(8, 3.05, 12.25)
const FLOATING_END = Vector3.create(8, 4.25, 12.25)
const FLOATING_SECONDS = 1.4
const TITLE_PROGRESS_SECONDS = 0.8

let revealView: RevealViewState = { ...EMPTY_REVEAL_VIEW }

export function getRevealViewState() {
  return revealView
}

export function createSceneRevealController(audio: RevealAudioPort, clock?: RevealClock) {
  let floatingEntity: Entity | null = null
  let floatingSecondsRemaining = 0

  function ensureFloatingEntity() {
    if (floatingEntity !== null) return floatingEntity
    floatingEntity = engine.addEntity()
    Transform.create(floatingEntity, { position: FLOATING_START })
    Billboard.create(floatingEntity, {})
    return floatingEntity
  }

  function revealPresentationSystem(deltaSeconds: number) {
    if (floatingEntity !== null && floatingSecondsRemaining > 0) {
      floatingSecondsRemaining = Math.max(0, floatingSecondsRemaining - deltaSeconds)
      if (floatingSecondsRemaining === 0) {
        TextShape.deleteFrom(floatingEntity)
      } else {
        const alpha = floatingSecondsRemaining / FLOATING_SECONDS
        TextShape.getMutable(floatingEntity).textColor = Color4.create(0.2, 1, 0.72, alpha)
      }
    }

    if (revealView.titleProgress > 0 && revealView.titleProgress < 1) {
      revealView = {
        ...revealView,
        titleProgress: Math.min(1, revealView.titleProgress + deltaSeconds / TITLE_PROGRESS_SECONDS)
      }
    }
  }

  function hideFloatingVerdict() {
    floatingSecondsRemaining = 0
    if (floatingEntity !== null && TextShape.has(floatingEntity)) TextShape.deleteFrom(floatingEntity)
  }

  engine.addSystem(revealPresentationSystem, undefined, 'ghost-charades::reveal-presentation')

  const effects: RevealEffects = {
    playSound: audio.play,
    lockAnswers: () => {
      revealView = { ...revealView, answersLocked: true }
    },
    setLights: (mood) => lights.set(mood),
    duckAudio: audio.duck,
    twitchCurtains: () => curtains.twitch(),
    freezePerformer,
    setCamera: (camera) => switchTheaterCamera(camera === 'push-in' ? 'reveal' : 'stage'),
    fadeWrongAnswers: () => {
      revealView = { ...revealView, wrongAnswersFaded: true }
    },
    setSpotlightColor: (color) => lights.setSpotlightColor(color),
    showFloatingVerdict: (text) => {
      const entity = ensureFloatingEntity()
      Transform.createOrReplace(entity, { position: FLOATING_START })
      TextShape.createOrReplace(entity, {
        text,
        fontSize: 4,
        textColor: Color4.create(0.2, 1, 0.72, 1),
        outlineWidth: 0.12,
        outlineColor: Color3.create(0.02, 0.08, 0.06)
      })
      Tween.setMove(entity, FLOATING_START, FLOATING_END, FLOATING_SECONDS * 1_000)
      floatingSecondsRemaining = FLOATING_SECONDS
      revealView = { ...revealView, verdict: 'hit', verdictText: text }
    },
    showMissVerdictCard: (text) => {
      revealView = { ...revealView, verdict: 'miss', verdictText: text }
    },
    reactAudience: (reaction) => react(reaction),
    playPerformerEmote: (emote) => playPerformerEmote(emote),
    showStats: (stats) => {
      revealView = { ...revealView, stats }
    },
    animateTitleProgress: () => {
      revealView = { ...revealView, titleProgress: 0.01 }
    },
    resetRevealVisuals: () => {
      hideFloatingVerdict()
      resumePerformer()
      revealView = { ...revealView, wrongAnswersFaded: false, titleProgress: Math.max(1, revealView.titleProgress) }
    },
    restoreAudio: audio.restore,
    complete: () => {
      revealView = { ...revealView, complete: true }
    }
  }

  const controller = createRevealController(effects, clock)

  return {
    begin(charade: DecodeCharade, answerIndex: number) {
      revealView = {
        ...EMPTY_REVEAL_VIEW,
        active: true,
        selectedAnswerIndex: answerIndex,
        answers: charade.answers
      }
      controller.begin()
    },
    resolve(reveal: RevealResult, charade: DecodeCharade) {
      revealView = {
        ...revealView,
        answers: charade.answers,
        phrase: reveal.phrase,
        correct: reveal.correct
      }
      return controller.resolve({
        correct: reveal.correct,
        authorName: charade.authorName,
        phrase: reveal.phrase,
        stats: reveal.stats
      })
    },
    skipToEnd: controller.skipToEnd,
    cancel() {
      const cancelled = controller.cancel()
      hideFloatingVerdict()
      revealView = { ...EMPTY_REVEAL_VIEW }
      return cancelled
    },
    getStatus: controller.getStatus
  }
}
