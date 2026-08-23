import { describe, expect, it } from 'vitest'
import {
  REVEAL_DURATION_SECONDS,
  REVEAL_TIMELINE,
  createRevealController,
  type RevealClock,
  type RevealEffects,
  type RevealOutcome
} from '../src/client/reveal'

class FakeClock implements RevealClock {
  currentTime = 0
  private nextTimer = 0
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  setTimeout(run: () => void, delayMilliseconds: number) {
    const timer = ++this.nextTimer
    this.timers.set(timer, { at: this.currentTime + delayMilliseconds, run })
    return timer
  }

  clearTimeout(timer: number) {
    this.timers.delete(timer)
  }

  advanceTo(milliseconds: number) {
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= milliseconds)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0]
      if (!next) break
      const [timerId, timer] = next
      this.timers.delete(timerId)
      this.currentTime = timer.at
      timer.run()
    }
    this.currentTime = milliseconds
  }

  pendingCount() {
    return this.timers.size
  }
}

const CORRECT_OUTCOME: RevealOutcome = {
  correct: true,
  authorName: 'Maya',
  phrase: 'Flying a kite',
  stats: { correct: 7, total: 11 },
  titleProgress: 0.4,
  unlockedTitle: '',
  stampAwarded: false
}

function createHarness() {
  const clock = new FakeClock()
  const events: string[] = []
  const record = (effect: string) => events.push(`${clock.currentTime}:${effect}`)
  const effects: RevealEffects = {
    playSound: (name) => record(`sound:${name}`),
    lockAnswers: () => record('answers:lock'),
    setLights: (mood) => record(`lights:${mood}`),
    duckAudio: () => record('audio:duck'),
    twitchCurtains: () => record('curtains:twitch'),
    freezePerformer: () => record('performer:freeze'),
    setCamera: (camera) => record(`camera:${camera}`),
    fadeWrongAnswers: () => record('answers:fade-wrong'),
    setSpotlightColor: (color) => record(`spotlight:${color}`),
    showFloatingVerdict: (text) => record(`floating:${text}`),
    showMissVerdictCard: (text) => record(`card:${text}`),
    reactAudience: (reaction) => record(`audience:${reaction}`),
    playPerformerEmote: (emote) => record(`performer:${emote}`),
    showStats: (stats) => record(`stats:${stats.correct}/${stats.total}`),
    animateTitleProgress: () => record('title:animate'),
    resetRevealVisuals: () => record('visuals:reset'),
    restoreAudio: () => record('audio:restore'),
    complete: () => record('complete')
  }
  return { clock, events, controller: createRevealController(effects, clock) }
}

describe('reveal timeline', () => {
  it('declares every beat at the exact planned second', () => {
    expect(REVEAL_TIMELINE.map(({ at }) => at)).toEqual([0, 1.2, 2, 2.6, 4, 6, 7.5, 8])
    expect(REVEAL_DURATION_SECONDS).toBe(8)
  })

  it('runs the complete correct choreography in order and at exact times', () => {
    const { clock, events, controller } = createHarness()

    controller.start(CORRECT_OUTCOME)
    expect(events).toEqual([
      '0:sound:tick',
      '0:answers:lock',
      '0:lights:tension',
      '0:audio:duck',
      '0:sound:drumroll',
      '0:curtains:twitch'
    ])

    for (const milliseconds of [
      1_199, 1_200, 1_999, 2_000, 2_599, 2_600, 3_999, 4_000, 5_999, 6_000, 7_499, 7_500, 7_999, 8_000
    ]) {
      clock.advanceTo(milliseconds)
    }

    expect(events).toEqual([
      '0:sound:tick',
      '0:answers:lock',
      '0:lights:tension',
      '0:audio:duck',
      '0:sound:drumroll',
      '0:curtains:twitch',
      '1200:performer:freeze',
      '1200:camera:push-in',
      '2000:sound:sting',
      '2000:answers:fade-wrong',
      '2000:spotlight:white',
      '2600:lights:hit',
      '2600:sound:hit',
      '2600:floating:YOU GOT IT',
      '2600:audience:clap',
      '4000:performer:wave',
      '4000:sound:applause',
      '6000:stats:7/11',
      '6000:title:animate',
      '7500:camera:stage',
      '7500:lights:house',
      '7500:visuals:reset',
      '7500:audio:restore',
      '8000:complete'
    ])
    expect(controller.getStatus()).toBe('complete')
    expect(clock.pendingCount()).toBe(0)
  })

  it('runs every miss-specific verdict and reaction effect', () => {
    const { clock, events, controller } = createHarness()

    controller.start({ ...CORRECT_OUTCOME, correct: false })
    clock.advanceTo(4_000)

    expect(events).toContain('2600:lights:miss')
    expect(events).toContain('2600:sound:miss')
    expect(events).toContain('2600:card:MAYA MEANT: FLYING A KITE')
    expect(events).toContain('2600:audience:shrug')
    expect(events).toContain('4000:performer:wave')
    expect(events).toContain('4000:sound:gasp')
    expect(events.some((event) => event.includes('YOU GOT IT'))).toBe(false)
  })
})

describe('reveal controller interruption', () => {
  it('starts tension on the guess tap and applies an authoritative verdict when it arrives', () => {
    const { clock, events, controller } = createHarness()

    controller.begin()
    clock.advanceTo(2_599)

    expect(events).toEqual([
      '0:sound:tick',
      '0:answers:lock',
      '0:lights:tension',
      '0:audio:duck',
      '0:sound:drumroll',
      '0:curtains:twitch',
      '1200:performer:freeze',
      '1200:camera:push-in',
      '2000:sound:sting',
      '2000:answers:fade-wrong',
      '2000:spotlight:white'
    ])

    controller.resolve(CORRECT_OUTCOME)
    clock.advanceTo(2_600)

    expect(events.slice(-4)).toEqual([
      '2600:lights:hit',
      '2600:sound:hit',
      '2600:floating:YOU GOT IT',
      '2600:audience:clap'
    ])
  })

  it('holds outcome-dependent beats until a delayed server verdict arrives', () => {
    const { clock, events, controller } = createHarness()

    controller.begin()
    clock.advanceTo(8_000)

    expect(controller.getStatus()).toBe('running')
    expect(events.some((event) => event.includes('lights:hit'))).toBe(false)
    expect(events.some((event) => event.endsWith('complete'))).toBe(false)

    controller.resolve(CORRECT_OUTCOME)

    expect(events.slice(-13)).toEqual([
      '8000:lights:hit',
      '8000:sound:hit',
      '8000:floating:YOU GOT IT',
      '8000:audience:clap',
      '8000:performer:wave',
      '8000:sound:applause',
      '8000:stats:7/11',
      '8000:title:animate',
      '8000:camera:stage',
      '8000:lights:house',
      '8000:visuals:reset',
      '8000:audio:restore',
      '8000:complete'
    ])
    expect(controller.getStatus()).toBe('complete')
  })

  it('resets an active reveal once and cancels every remaining beat', () => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(2_600)

    expect(controller.reset()).toBe(true)
    const afterFirstReset = [...events]
    expect(controller.reset()).toBe(false)
    clock.advanceTo(20_000)

    expect(events).toEqual(afterFirstReset)
    expect(events.slice(-4)).toEqual([
      '2600:camera:stage',
      '2600:lights:house',
      '2600:visuals:reset',
      '2600:audio:restore'
    ])
    expect(events).not.toContain('8000:complete')
    expect(controller.getStatus()).toBe('idle')
    expect(clock.pendingCount()).toBe(0)
  })

  it('cleans up the old run before restarting and cancels without stale callbacks', () => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(2_000)

    controller.start({ ...CORRECT_OUTCOME, correct: false })
    expect(events.slice(-10)).toEqual([
      '2000:camera:stage',
      '2000:lights:house',
      '2000:visuals:reset',
      '2000:audio:restore',
      '2000:sound:tick',
      '2000:answers:lock',
      '2000:lights:tension',
      '2000:audio:duck',
      '2000:sound:drumroll',
      '2000:curtains:twitch'
    ])

    clock.advanceTo(4_600)
    expect(events).toContain('4600:sound:miss')
    expect(events.some((event) => event.endsWith('sound:hit'))).toBe(false)
    expect(controller.cancel()).toBe(true)
    const afterCancel = [...events]
    clock.advanceTo(20_000)

    expect(events).toEqual(afterCancel)
    expect(controller.getStatus()).toBe('idle')
    expect(clock.pendingCount()).toBe(0)
  })

  it('NEXT skips directly to the clean end state without running omitted beats', () => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(1_200)

    expect(controller.skipToEnd()).toBe(true)
    const afterSkip = [...events]
    expect(events.slice(-5)).toEqual([
      '1200:camera:stage',
      '1200:lights:house',
      '1200:visuals:reset',
      '1200:audio:restore',
      '1200:complete'
    ])
    expect(controller.skipToEnd()).toBe(false)
    clock.advanceTo(20_000)

    expect(events).toEqual(afterSkip)
    expect(events.some((event) => event.includes('sting'))).toBe(false)
    expect(controller.getStatus()).toBe('complete')
    expect(clock.pendingCount()).toBe(0)
  })

  it('does not repeat the 7.5-second cleanup when skipped before completion', () => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(7_500)
    const cleanupCount = events.filter((event) => event.endsWith('visuals:reset')).length

    controller.skipToEnd()

    expect(events.filter((event) => event.endsWith('visuals:reset'))).toHaveLength(cleanupCount)
    expect(events.at(-1)).toBe('7500:complete')
  })
})
