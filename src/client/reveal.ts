export const REVEAL_DURATION_SECONDS = 8

const REVEAL_RESET_SECONDS = 7.5

export type RevealLightMood = 'house' | 'tension' | 'hit' | 'miss'
export type RevealSoundName = 'tick' | 'drumroll' | 'sting' | 'hit' | 'miss' | 'applause' | 'gasp'
export type RevealCamera = 'push-in' | 'stage'
export type RevealAudienceReaction = 'clap' | 'shrug'
export type RevealStatus = 'idle' | 'running' | 'complete'

export type RevealStats = {
  correct: number
  total: number
}

export type RevealOutcome = {
  correct: boolean
  authorName: string
  phrase: string
  stats: RevealStats
}

export type RevealEffects = {
  playSound: (name: RevealSoundName) => void
  lockAnswers: () => void
  setLights: (mood: RevealLightMood) => void
  duckAudio: () => void
  twitchCurtains: () => void
  freezePerformer: () => void
  setCamera: (camera: RevealCamera) => void
  fadeWrongAnswers: () => void
  setSpotlightColor: (color: 'white') => void
  showFloatingVerdict: (text: 'YOU GOT IT') => void
  showMissVerdictCard: (text: string) => void
  reactAudience: (reaction: RevealAudienceReaction) => void
  playPerformerEmote: (emote: 'wave') => void
  showStats: (stats: RevealStats) => void
  animateTitleProgress: () => void
  resetRevealVisuals: () => void
  restoreAudio: () => void
  complete: () => void
}

export type RevealTimelineEntry = {
  at: number
  run: (effects: RevealEffects, outcome?: RevealOutcome) => void
}

export type RevealClock = {
  setTimeout: (run: () => void, delayMilliseconds: number) => number
  clearTimeout: (timer: number) => void
}

function returnToCleanState(effects: RevealEffects) {
  effects.setCamera('stage')
  effects.setLights('house')
  effects.resetRevealVisuals()
  effects.restoreAudio()
}

export const REVEAL_TIMELINE: readonly RevealTimelineEntry[] = [
  {
    at: 0,
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
    run(effects) {
      effects.freezePerformer()
      effects.setCamera('push-in')
    }
  },
  {
    at: 2,
    run(effects) {
      effects.playSound('sting')
      effects.fadeWrongAnswers()
      effects.setSpotlightColor('white')
    }
  },
  {
    at: 2.6,
    run(effects, outcome) {
      if (!outcome) return
      if (outcome.correct) {
        effects.setLights('hit')
        effects.playSound('hit')
        effects.showFloatingVerdict('YOU GOT IT')
        effects.reactAudience('clap')
        return
      }

      effects.setLights('miss')
      effects.playSound('miss')
      effects.showMissVerdictCard(`${outcome.authorName.toUpperCase()} MEANT: ${outcome.phrase.toUpperCase()}`)
      effects.reactAudience('shrug')
    }
  },
  {
    at: 4,
    run(effects, outcome) {
      if (!outcome) return
      effects.playPerformerEmote('wave')
      effects.playSound(outcome.correct ? 'applause' : 'gasp')
    }
  },
  {
    at: 6,
    run(effects, outcome) {
      if (!outcome) return
      effects.showStats(outcome.stats)
      effects.animateTitleProgress()
    }
  },
  {
    at: REVEAL_RESET_SECONDS,
    run(effects) {
      returnToCleanState(effects)
    }
  },
  {
    at: REVEAL_DURATION_SECONDS,
    run(effects) {
      effects.complete()
    }
  }
]

const SYSTEM_CLOCK: RevealClock = {
  setTimeout: (run, delayMilliseconds) => setTimeout(run, delayMilliseconds),
  clearTimeout: (timer) => clearTimeout(timer)
}

export function createRevealController(effects: RevealEffects, clock: RevealClock = SYSTEM_CLOCK) {
  let status: RevealStatus = 'idle'
  let timers: number[] = []
  let deferredEntries: RevealTimelineEntry[] = []
  let outcome: RevealOutcome | null = null
  let generation = 0
  let clean = true

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
    return true
  }

  function runEntry(entry: RevealTimelineEntry) {
    if (entry.at >= 2.6 && outcome === null) {
      deferredEntries.push(entry)
      return
    }
    if (entry.at === REVEAL_RESET_SECONDS) clean = true
    if (entry.at === REVEAL_DURATION_SECONDS) {
      status = 'complete'
      timers = []
    }
    entry.run(effects, outcome ?? undefined)
  }

  function begin() {
    if (status === 'running') reset()
    else cancelTimers()

    generation += 1
    const runGeneration = generation
    status = 'running'
    clean = false
    outcome = null
    deferredEntries = []

    for (const entry of REVEAL_TIMELINE) {
      if (entry.at === 0) continue
      const timer = clock.setTimeout(() => {
        if (status !== 'running' || generation !== runGeneration) return
        runEntry(entry)
      }, entry.at * 1_000)
      timers.push(timer)
    }

    for (const entry of REVEAL_TIMELINE) {
      if (entry.at !== 0 || status !== 'running' || generation !== runGeneration) continue
      runEntry(entry)
    }
  }

  function resolve(nextOutcome: RevealOutcome) {
    if (status !== 'running') return false
    outcome = nextOutcome
    const dueEntries = deferredEntries
    deferredEntries = []
    for (const entry of dueEntries) runEntry(entry)
    return true
  }

  function start(nextOutcome: RevealOutcome) {
    begin()
    resolve(nextOutcome)
  }

  function skipToEnd() {
    if (status !== 'running') return false
    cancelTimers()
    generation += 1
    cleanActiveReveal()
    deferredEntries = []
    outcome = null
    status = 'complete'
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
    getStatus: () => status
  }
}
