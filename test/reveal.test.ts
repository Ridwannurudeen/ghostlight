import { describe, expect, it } from 'vitest'
import {
  ORDINARY_REVEAL_DURATION_SECONDS,
  ORDINARY_REVEAL_TIMELINE,
  REDUCED_MOTION_REVEAL_DURATION_SECONDS,
  REDUCED_MOTION_REVEAL_TIMELINE,
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

  now = () => this.currentTime

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

function createHarness(reducedMotion = () => false) {
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
    releaseCamera: () => record('camera:release'),
    fadeWrongAnswers: () => record('answers:fade-wrong'),
    setSpotlightColor: (color) => record(`spotlight:${color}`),
    showFloatingVerdict: (text) => record(`floating:${text}`),
    showGhostGotYou: (text) => record(`got-you:${text}`),
    showMissVerdictCard: (text) => record(`card:${text}`),
    reactAudience: (reaction) => record(`audience:${reaction}`),
    playPerformerEmote: (emote) => record(`performer:${emote}`),
    showStats: (stats) => record(`stats:${stats.correct}/${stats.total}`),
    animateTitleProgress: () => record('title:animate'),
    resetRevealVisuals: () => record('visuals:reset'),
    restoreAudio: () => record('audio:restore'),
    complete: () => record('complete')
  }
  return { clock, events, controller: createRevealController(effects, clock, { reducedMotion }) }
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
      '7500:camera:release',
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

  it('shortens reduced-motion reveals while retaining verdict, sound, stats, reset, and completion', () => {
    const { clock, events, controller } = createHarness(() => true)

    expect(REDUCED_MOTION_REVEAL_TIMELINE.map(({ at }) => at)).toEqual([0, 0.4, 0.8, 1.3, 1.8, 2.5, 3])
    expect(REDUCED_MOTION_REVEAL_DURATION_SECONDS).toBe(3)

    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(3_000)

    expect(events).toEqual([
      '0:sound:tick',
      '0:answers:lock',
      '0:lights:tension',
      '0:audio:duck',
      '0:sound:drumroll',
      '400:sound:sting',
      '400:answers:fade-wrong',
      '400:spotlight:white',
      '800:lights:hit',
      '800:sound:hit',
      '800:floating:YOU GOT IT',
      '1300:sound:applause',
      '1800:stats:7/11',
      '1800:title:animate',
      '2500:camera:release',
      '2500:lights:house',
      '2500:visuals:reset',
      '2500:audio:restore',
      '3000:complete'
    ])
    expect(controller.getStatus()).toBe('complete')
    expect(clock.pendingCount()).toBe(0)
  })

  it('uses the exact three-second sequence for an ordinary reveal after the first verdict', () => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(8_000)
    events.length = 0

    expect(ORDINARY_REVEAL_TIMELINE.map(({ at }) => at)).toEqual([0, 0.6, 1, 1.7, 2.3, 3])
    expect(ORDINARY_REVEAL_DURATION_SECONDS).toBe(3)

    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(11_000)

    expect(events).toEqual([
      '8000:sound:tick',
      '8000:answers:lock',
      '8000:lights:tension',
      '8000:audio:duck',
      '8000:sound:drumroll',
      '8000:curtains:twitch',
      '8600:sound:sting',
      '8600:answers:fade-wrong',
      '8600:spotlight:white',
      '9000:lights:hit',
      '9000:sound:hit',
      '9000:floating:YOU GOT IT',
      '9700:audience:clap',
      '9700:performer:wave',
      '9700:sound:applause',
      '10300:stats:7/11',
      '10300:title:animate',
      '11000:camera:release',
      '11000:lights:house',
      '11000:visuals:reset',
      '11000:audio:restore',
      '11000:complete'
    ])
    expect(controller.getStatus()).toBe('complete')
  })

  it.each([
    ['title', { unlockedTitle: 'Scene Stealer' }],
    ['stamp', { stampAwarded: true }]
  ] as const)('keeps the full eight-second sequence for a %s unlock', (_kind, patch) => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(8_000)
    events.length = 0

    controller.start({ ...CORRECT_OUTCOME, ...patch })
    clock.advanceTo(11_000)
    expect(controller.getStatus()).toBe('running')
    expect(events).toContain('10600:floating:YOU GOT IT')
    expect(events.some((event) => event.endsWith('complete'))).toBe(false)

    clock.advanceTo(16_000)
    expect(events.at(-1)).toBe('16000:complete')
    expect(controller.getStatus()).toBe('complete')
  })

  it('keeps the full eight-second sequence when the caller marks a finale', () => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(8_000)
    events.length = 0

    controller.start(CORRECT_OUTCOME, { isFinale: true })
    clock.advanceTo(16_000)

    expect(events).toContain('10600:floating:YOU GOT IT')
    expect(events.at(-1)).toBe('16000:complete')
  })

  it('keeps the full eight-second sequence for the first reveal of a proven new set', () => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(8_000)
    events.length = 0

    controller.start(CORRECT_OUTCOME, { isSetStart: true })
    clock.advanceTo(11_000)

    expect(controller.getStatus()).toBe('running')
    expect(events.some((event) => event.endsWith('complete'))).toBe(false)
    clock.advanceTo(16_000)
    expect(events.at(-1)).toBe('16000:complete')
  })
})

describe('second-miss reveal choreography', () => {
  const SECOND_MISS: RevealOutcome = {
    correct: false,
    authorName: 'Maya',
    phrase: 'Flying a kite',
    stats: { correct: 7, total: 12 },
    titleProgress: 0.4,
    unlockedTitle: '',
    stampAwarded: false,
    attempt: 2,
    gotYouText: 'THE GHOST GOT YOU'
  }

  it('plays the laugh and fist-pump before revealing the phrase', () => {
    const { clock, events, controller } = createHarness()
    controller.start(SECOND_MISS)

    clock.advanceTo(2_600)
    expect(events).toContain('2600:got-you:THE GHOST GOT YOU')
    expect(events).toContain('2600:sound:laugh')
    expect(events).toContain('2600:audience:laugh')
    expect(events).toContain('2600:performer:fistpump')
    expect(events.some((event) => event.startsWith('2600:card:'))).toBe(false)

    clock.advanceTo(4_000)
    const gotYouIndex = events.indexOf('2600:got-you:THE GHOST GOT YOU')
    const phraseIndex = events.findIndex((event) => event.startsWith('4000:card:'))
    expect(phraseIndex).toBeGreaterThan(gotYouIndex)
  })

  it('retains the staged verdict and phrase under reduced motion timing', () => {
    const { clock, events, controller } = createHarness(() => true)
    controller.start(SECOND_MISS)

    clock.advanceTo(800)
    expect(events).toContain('800:got-you:THE GHOST GOT YOU')
    expect(events.some((event) => event.startsWith('800:card:'))).toBe(false)
    clock.advanceTo(1_300)
    expect(events.some((event) => event.startsWith('1300:card:'))).toBe(true)
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

    expect(events.slice(-4)).toEqual([
      '8000:lights:hit',
      '8000:sound:hit',
      '8000:floating:YOU GOT IT',
      '8000:audience:clap'
    ])
    clock.advanceTo(13_400)
    expect(events.slice(-9)).toEqual([
      '9400:performer:wave',
      '9400:sound:applause',
      '11400:stats:7/11',
      '11400:title:animate',
      '12900:camera:release',
      '12900:lights:house',
      '12900:visuals:reset',
      '12900:audio:restore',
      '13400:complete'
    ])
    expect(controller.getStatus()).toBe('complete')
  })

  it('shifts an ordinary tail behind a delayed server verdict without losing the result', () => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(8_000)
    events.length = 0

    controller.begin()
    clock.advanceTo(9_500)
    expect(controller.hasShownVerdict()).toBe(false)

    expect(controller.resolve(CORRECT_OUTCOME)).toBe(true)
    expect(events.slice(-6)).toEqual([
      '9500:sound:sting',
      '9500:answers:fade-wrong',
      '9500:spotlight:white',
      '9500:lights:hit',
      '9500:sound:hit',
      '9500:floating:YOU GOT IT'
    ])
    expect(controller.hasShownVerdict()).toBe(true)

    clock.advanceTo(11_500)
    expect(events).toContain('10200:audience:clap')
    expect(events).toContain('10800:stats:7/11')
    expect(events.at(-1)).toBe('11500:complete')
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
      '2600:camera:release',
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
      '2000:camera:release',
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

  it('refuses NEXT before the verdict and skips only the tail after the verdict', () => {
    const { clock, events, controller } = createHarness()
    controller.start(CORRECT_OUTCOME)
    clock.advanceTo(1_200)

    expect(controller.hasShownVerdict()).toBe(false)
    expect(controller.skipToEnd()).toBe(false)
    clock.advanceTo(2_600)
    expect(controller.hasShownVerdict()).toBe(true)
    expect(events).toContain('2600:floating:YOU GOT IT')

    expect(controller.skipToEnd()).toBe(true)
    const afterSkip = [...events]
    expect(events.slice(-5)).toEqual([
      '2600:camera:release',
      '2600:lights:house',
      '2600:visuals:reset',
      '2600:audio:restore',
      '2600:complete'
    ])
    expect(controller.skipToEnd()).toBe(false)
    clock.advanceTo(20_000)

    expect(events).toEqual(afterSkip)
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
