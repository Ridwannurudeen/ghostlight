import { t } from '../shared/i18n'

export const REVEAL_DURATION_SECONDS = 8
export const ORDINARY_REVEAL_DURATION_SECONDS = 3
export const REDUCED_MOTION_REVEAL_DURATION_SECONDS = 3

const REVEAL_OUTCOME_SECONDS = 2.6
const REVEAL_RESET_SECONDS = 7.5
const ORDINARY_REVEAL_OUTCOME_SECONDS = 1
const REDUCED_MOTION_REVEAL_OUTCOME_SECONDS = 0.8
const REDUCED_MOTION_REVEAL_RESET_SECONDS = 2.5

export type RevealLightMood = 'house' | 'tension' | 'hit' | 'miss'
export type RevealSoundName =
  | 'tick'
  | 'drumroll'
  | 'sting'
  | 'hit'
  | 'miss'
  | 'applause'
  | 'gasp'
  | 'laugh'
  | 'unlock'
  | 'stamp'
export type RevealCamera = 'push-in' | 'stage'
export type RevealAudienceReaction = 'clap' | 'shrug' | 'laugh'
export type RevealStatus = 'idle' | 'running' | 'complete'
export type RevealRunOptions = {
  isFinale?: boolean
}

export type RevealStats = {
  correct: number
  total: number
}

export type RevealOutcome = {
  correct: boolean
  authorName: string
  phrase: string
  stats: RevealStats
  titleProgress: number
  unlockedTitle: string
  stampAwarded: boolean
  attempt?: 1 | 2
  hitText?: string
  missText?: string
  gotYouText?: string
}

export type RevealEffects = {
  playSound: (name: RevealSoundName) => void
  lockAnswers: () => void
  setLights: (mood: RevealLightMood) => void
  duckAudio: () => void
  twitchCurtains: () => void
  freezePerformer: () => void
  setCamera: (camera: RevealCamera) => void
  releaseCamera: () => void
  fadeWrongAnswers: () => void
  setSpotlightColor: (color: 'white') => void
  showFloatingVerdict: (text: string) => void
  showGhostGotYou: (text: string) => void
  showMissVerdictCard: (text: string) => void
  reactAudience: (reaction: RevealAudienceReaction) => void
  playPerformerEmote: (emote: 'wave' | 'fistpump') => void
  showStats: (stats: RevealStats) => void
  animateTitleProgress: (progress: number, unlockedTitle: string) => void
  resetRevealVisuals: () => void
  restoreAudio: () => void
  complete: () => void
}

export type RevealTimelineEntry = {
  at: number
  beat: 'lock' | 'freeze' | 'sting' | 'verdict' | 'reaction' | 'stats' | 'reset' | 'complete'
  run: (effects: RevealEffects, outcome?: RevealOutcome) => void
}

export type RevealClock = {
  now: () => number
  setTimeout: (run: () => void, delayMilliseconds: number) => number
  clearTimeout: (timer: number) => void
}

export type RevealControllerOptions = {
  reducedMotion?: () => boolean
}

function returnToCleanState(effects: RevealEffects) {
  effects.releaseCamera()
  effects.setLights('house')
  effects.resetRevealVisuals()
  effects.restoreAudio()
}

export const REVEAL_TIMELINE: readonly RevealTimelineEntry[] = [
  {
    at: 0,
    beat: 'lock',
    run(effects) {
      effects.playSound('tick')
      effects.lockAnswers()
      effects.setLights('tension')
      effects.duckAudio()
      effects.playSound('drumroll')
      effects.twitchCurtains()
    }
  },
  {
    at: 1.2,
    beat: 'freeze',
    run(effects) {
      effects.freezePerformer()
      effects.setCamera('push-in')
    }
  },
  {
    at: 2,
    beat: 'sting',
    run(effects) {
      effects.playSound('sting')
      effects.fadeWrongAnswers()
      effects.setSpotlightColor('white')
    }
  },
  {
    at: 2.6,
    beat: 'verdict',
    run(effects, outcome) {
      if (!outcome) return
      if (outcome.correct) {
        effects.setLights('hit')
        effects.playSound('hit')
        effects.showFloatingVerdict(outcome.hitText ?? t('reveal.hit', 'en'))
        effects.reactAudience('clap')
        return
      }

      effects.setLights('miss')
      if (outcome.attempt === 2) {
        effects.playSound('laugh')
        effects.showGhostGotYou(outcome.gotYouText ?? t('reveal.gotYou', 'en'))
        effects.reactAudience('laugh')
        effects.playPerformerEmote('fistpump')
        return
      }
      effects.playSound('miss')
      effects.showMissVerdictCard(
        outcome.missText ??
          t('reveal.miss', 'en', { author: outcome.authorName.toUpperCase(), phrase: outcome.phrase.toUpperCase() })
      )
      effects.reactAudience('shrug')
    }
  },
  {
    at: 4,
    beat: 'reaction',
    run(effects, outcome) {
      if (!outcome) return
      if (!outcome.correct && outcome.attempt === 2) {
        effects.playSound('miss')
        effects.showMissVerdictCard(
          outcome.missText ??
            t('reveal.miss', 'en', { author: outcome.authorName.toUpperCase(), phrase: outcome.phrase.toUpperCase() })
        )
        return
      }
      effects.playPerformerEmote('wave')
      effects.playSound(outcome.correct ? 'applause' : 'gasp')
    }
  },
  {
    at: 6,
    beat: 'stats',
    run(effects, outcome) {
      if (!outcome) return
      effects.showStats(outcome.stats)
      effects.animateTitleProgress(outcome.titleProgress, outcome.unlockedTitle)
    }
  },
  {
    at: REVEAL_RESET_SECONDS,
    beat: 'reset',
    run(effects) {
      returnToCleanState(effects)
    }
  },
  {
    at: REVEAL_DURATION_SECONDS,
    beat: 'complete',
    run(effects) {
      effects.complete()
    }
  }
]

export const ORDINARY_REVEAL_TIMELINE: readonly RevealTimelineEntry[] = [
  {
    at: 0,
    beat: 'lock',
    run(effects) {
      effects.playSound('tick')
      effects.lockAnswers()
      effects.setLights('tension')
      effects.duckAudio()
      effects.playSound('drumroll')
      effects.twitchCurtains()
    }
  },
  {
    at: 0.6,
    beat: 'sting',
    run(effects) {
      effects.playSound('sting')
      effects.fadeWrongAnswers()
      effects.setSpotlightColor('white')
    }
  },
  {
    at: ORDINARY_REVEAL_OUTCOME_SECONDS,
    beat: 'verdict',
    run(effects, outcome) {
      if (!outcome) return
      if (outcome.correct) {
        effects.setLights('hit')
        effects.playSound('hit')
        effects.showFloatingVerdict(outcome.hitText ?? t('reveal.hit', 'en'))
        return
      }

      effects.setLights('miss')
      if (outcome.attempt === 2) {
        effects.playSound('laugh')
        effects.showGhostGotYou(outcome.gotYouText ?? t('reveal.gotYou', 'en'))
        effects.reactAudience('laugh')
        effects.playPerformerEmote('fistpump')
        return
      }
      effects.playSound('miss')
      effects.showMissVerdictCard(
        outcome.missText ??
          t('reveal.miss', 'en', { author: outcome.authorName.toUpperCase(), phrase: outcome.phrase.toUpperCase() })
      )
    }
  },
  {
    at: 1.7,
    beat: 'reaction',
    run(effects, outcome) {
      if (!outcome) return
      if (!outcome.correct && outcome.attempt === 2) {
        effects.playSound('miss')
        effects.showMissVerdictCard(
          outcome.missText ??
            t('reveal.miss', 'en', { author: outcome.authorName.toUpperCase(), phrase: outcome.phrase.toUpperCase() })
        )
        return
      }
      effects.reactAudience(outcome.correct ? 'clap' : 'shrug')
      effects.playPerformerEmote('wave')
      effects.playSound(outcome.correct ? 'applause' : 'gasp')
    }
  },
  {
    at: 2.3,
    beat: 'stats',
    run(effects, outcome) {
      if (!outcome) return
      effects.showStats(outcome.stats)
      effects.animateTitleProgress(outcome.titleProgress, outcome.unlockedTitle)
    }
  },
  {
    at: ORDINARY_REVEAL_DURATION_SECONDS,
    beat: 'complete',
    run(effects) {
      returnToCleanState(effects)
      effects.complete()
    }
  }
]

export const REDUCED_MOTION_REVEAL_TIMELINE: readonly RevealTimelineEntry[] = [
  {
    at: 0,
    beat: 'lock',
    run(effects) {
      effects.playSound('tick')
      effects.lockAnswers()
      effects.setLights('tension')
      effects.duckAudio()
      effects.playSound('drumroll')
    }
  },
  {
    at: 0.4,
    beat: 'sting',
    run(effects) {
      effects.playSound('sting')
      effects.fadeWrongAnswers()
      effects.setSpotlightColor('white')
    }
  },
  {
    at: REDUCED_MOTION_REVEAL_OUTCOME_SECONDS,
    beat: 'verdict',
    run(effects, outcome) {
      if (!outcome) return
      if (outcome.correct) {
        effects.setLights('hit')
        effects.playSound('hit')
        effects.showFloatingVerdict(outcome.hitText ?? t('reveal.hit', 'en'))
        return
      }

      effects.setLights('miss')
      if (outcome.attempt === 2) {
        effects.playSound('laugh')
        effects.showGhostGotYou(outcome.gotYouText ?? t('reveal.gotYou', 'en'))
        effects.reactAudience('laugh')
        effects.playPerformerEmote('fistpump')
        return
      }
      effects.playSound('miss')
      effects.showMissVerdictCard(
        outcome.missText ??
          t('reveal.miss', 'en', { author: outcome.authorName.toUpperCase(), phrase: outcome.phrase.toUpperCase() })
      )
    }
  },
  {
    at: 1.3,
    beat: 'reaction',
    run(effects, outcome) {
      if (!outcome) return
      if (!outcome.correct && outcome.attempt === 2) {
        effects.playSound('miss')
        effects.showMissVerdictCard(
          outcome.missText ??
            t('reveal.miss', 'en', { author: outcome.authorName.toUpperCase(), phrase: outcome.phrase.toUpperCase() })
        )
        return
      }
      effects.playSound(outcome.correct ? 'applause' : 'gasp')
    }
  },
  {
    at: 1.8,
    beat: 'stats',
    run(effects, outcome) {
      if (!outcome) return
      effects.showStats(outcome.stats)
      effects.animateTitleProgress(outcome.titleProgress, outcome.unlockedTitle)
    }
  },
  {
    at: REDUCED_MOTION_REVEAL_RESET_SECONDS,
    beat: 'reset',
    run(effects) {
      returnToCleanState(effects)
    }
  },
  {
    at: REDUCED_MOTION_REVEAL_DURATION_SECONDS,
    beat: 'complete',
    run(effects) {
      effects.complete()
    }
  }
]

type RevealSequence = {
  timeline: readonly RevealTimelineEntry[]
  outcomeAt: number
  resetAt: number
}

const STANDARD_REVEAL_SEQUENCE: RevealSequence = {
  timeline: REVEAL_TIMELINE,
  outcomeAt: REVEAL_OUTCOME_SECONDS,
  resetAt: REVEAL_RESET_SECONDS
}

const ORDINARY_REVEAL_SEQUENCE: RevealSequence = {
  timeline: ORDINARY_REVEAL_TIMELINE,
  outcomeAt: ORDINARY_REVEAL_OUTCOME_SECONDS,
  resetAt: ORDINARY_REVEAL_DURATION_SECONDS
}

const REDUCED_MOTION_REVEAL_SEQUENCE: RevealSequence = {
  timeline: REDUCED_MOTION_REVEAL_TIMELINE,
  outcomeAt: REDUCED_MOTION_REVEAL_OUTCOME_SECONDS,
  resetAt: REDUCED_MOTION_REVEAL_RESET_SECONDS
}

const SYSTEM_CLOCK: RevealClock = {
  now: Date.now,
  setTimeout: (run, delayMilliseconds) => setTimeout(run, delayMilliseconds),
  clearTimeout: (timer) => clearTimeout(timer)
}

export function createRevealController(
  effects: RevealEffects,
  clock: RevealClock = SYSTEM_CLOCK,
  options: RevealControllerOptions = {}
) {
  let status: RevealStatus = 'idle'
  let timers: number[] = []
  let deferredEntries: RevealTimelineEntry[] = []
  let outcome: RevealOutcome | null = null
  let generation = 0
  let clean = true
  let sequence = STANDARD_REVEAL_SEQUENCE
  let startedAt = 0
  let verdictFired = false
  let firstVerdictPending = true
  let adaptiveOrdinary = false
  const completedBeats = new Set<RevealTimelineEntry['beat']>()

  function cancelTimers() {
    for (const timer of timers) clock.clearTimeout(timer)
    timers = []
  }

  function cleanActiveReveal() {
    if (clean) return
    clean = true
    returnToCleanState(effects)
  }

  function reset() {
    if (status === 'idle') return false
    cancelTimers()
    generation += 1
    cleanActiveReveal()
    deferredEntries = []
    outcome = null
    status = 'idle'
    verdictFired = false
    completedBeats.clear()
    return true
  }

  function runEntry(entry: RevealTimelineEntry) {
    if (completedBeats.has(entry.beat)) return
    if (entry.at >= sequence.outcomeAt && outcome === null) {
      deferredEntries.push(entry)
      return
    }
    completedBeats.add(entry.beat)
    entry.run(effects, outcome ?? undefined)
    if (entry.beat === 'verdict') {
      verdictFired = true
      firstVerdictPending = false
    }
    if (entry.at === sequence.resetAt) clean = true
    if (entry.beat === 'complete') {
      status = 'complete'
      timers = []
    }
  }

  function scheduleEntry(entry: RevealTimelineEntry, delayMilliseconds: number, runGeneration: number) {
    const timer = clock.setTimeout(() => {
      if (status !== 'running' || generation !== runGeneration) return
      runEntry(entry)
    }, delayMilliseconds)
    timers.push(timer)
  }

  function begin(runOptions: RevealRunOptions = {}) {
    if (status === 'running') reset()
    else cancelTimers()

    const reducedMotion = options.reducedMotion?.() === true
    sequence = reducedMotion ? REDUCED_MOTION_REVEAL_SEQUENCE : STANDARD_REVEAL_SEQUENCE
    adaptiveOrdinary = !reducedMotion && !firstVerdictPending && runOptions.isFinale !== true

    generation += 1
    const runGeneration = generation
    status = 'running'
    clean = false
    outcome = null
    deferredEntries = []
    startedAt = clock.now()
    verdictFired = false
    completedBeats.clear()

    for (const entry of sequence.timeline) {
      if (entry.at === 0) continue
      scheduleEntry(entry, entry.at * 1_000, runGeneration)
    }

    for (const entry of sequence.timeline) {
      if (entry.at !== 0 || status !== 'running' || generation !== runGeneration) continue
      runEntry(entry)
    }
  }

  function switchToOrdinarySequence() {
    cancelTimers()
    generation += 1
    const runGeneration = generation
    sequence = ORDINARY_REVEAL_SEQUENCE
    deferredEntries = []
    const elapsed = Math.max(0, (clock.now() - startedAt) / 1_000)
    const delayedOutcome = elapsed >= sequence.outcomeAt

    for (const entry of sequence.timeline) {
      if (entry.at === 0 || completedBeats.has(entry.beat)) continue
      if (entry.at < sequence.outcomeAt && entry.at <= elapsed) {
        runEntry(entry)
        continue
      }
      if (entry.at === sequence.outcomeAt && delayedOutcome) {
        runEntry(entry)
        continue
      }
      const delaySeconds =
        delayedOutcome && entry.at > sequence.outcomeAt ? entry.at - sequence.outcomeAt : entry.at - elapsed
      scheduleEntry(entry, Math.max(0, delaySeconds * 1_000), runGeneration)
    }
  }

  function resolve(nextOutcome: RevealOutcome) {
    if (status !== 'running' || outcome !== null) return false
    outcome = nextOutcome
    if (adaptiveOrdinary && !nextOutcome.unlockedTitle && !nextOutcome.stampAwarded) {
      switchToOrdinarySequence()
      return true
    }
    if (deferredEntries.length === 0) return true

    cancelTimers()
    generation += 1
    const runGeneration = generation
    deferredEntries = []
    const outcomeEntries = sequence.timeline.filter((entry) => entry.at >= sequence.outcomeAt)
    const firstAt = outcomeEntries[0].at
    runEntry(outcomeEntries[0])
    for (const entry of outcomeEntries.slice(1)) {
      scheduleEntry(entry, (entry.at - firstAt) * 1_000, runGeneration)
    }
    return true
  }

  function start(nextOutcome: RevealOutcome, runOptions: RevealRunOptions = {}) {
    begin(runOptions)
    resolve(nextOutcome)
  }

  function skipToEnd() {
    if (status !== 'running' || !verdictFired) return false
    cancelTimers()
    generation += 1
    cleanActiveReveal()
    deferredEntries = []
    outcome = null
    status = 'complete'
    completedBeats.add('complete')
    effects.complete()
    return true
  }

  return {
    begin,
    resolve,
    start,
    reset,
    cancel: reset,
    skipToEnd,
    getStatus: () => status,
    hasShownVerdict: () => verdictFired
  }
}
