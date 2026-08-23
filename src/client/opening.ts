export const OPENING_DURATION_SECONDS = 10
export const OPENING_INSTRUCTION = "Guess what they're saying"

export type OpeningCamera = 'foyer' | 'stage'

export type OpeningEffects = {
  switchCamera(camera: OpeningCamera): void
  setMarquee(text: string): void
  openDoors(): void
  enterPerformer(): void
  showInstruction(text: string): void
  showDecode(): void
}

export type OpeningContext = {
  effects: OpeningEffects
  themeLabel: string
}

export type OpeningBeat = {
  name: 'foyer-camera' | 'marquee' | 'doors-open' | 'stage-camera' | 'performer-entrance' | 'instruction' | 'decode'
  at: number
  run(context: OpeningContext): void
}

export const OPENING_TIMELINE: readonly OpeningBeat[] = [
  {
    name: 'foyer-camera',
    at: 0,
    run: ({ effects }) => effects.switchCamera('foyer')
  },
  {
    name: 'marquee',
    at: 1,
    run: ({ effects, themeLabel }) => effects.setMarquee(`TONIGHT'S SHOW: ${themeLabel}`)
  },
  {
    name: 'doors-open',
    at: 2.5,
    run: ({ effects }) => effects.openDoors()
  },
  {
    name: 'stage-camera',
    at: 4.5,
    run: ({ effects }) => effects.switchCamera('stage')
  },
  {
    name: 'performer-entrance',
    at: 6,
    run: ({ effects }) => effects.enterPerformer()
  },
  {
    name: 'instruction',
    at: 8,
    run: ({ effects }) => effects.showInstruction(OPENING_INSTRUCTION)
  },
  {
    name: 'decode',
    at: OPENING_DURATION_SECONDS,
    run: ({ effects }) => effects.showDecode()
  }
] as const

export type OpeningSession = {
  played: boolean
}

export function createOpeningSession(): OpeningSession {
  return { played: false }
}

export function createOpeningController(effects: OpeningEffects, session = createOpeningSession()) {
  let elapsedSeconds = 0
  let nextBeat = 0
  let running = false
  let themeLabel = ''

  function runDueBeats() {
    const context = { effects, themeLabel }
    while (nextBeat < OPENING_TIMELINE.length && OPENING_TIMELINE[nextBeat].at <= elapsedSeconds) {
      OPENING_TIMELINE[nextBeat].run(context)
      nextBeat += 1
    }
    if (nextBeat === OPENING_TIMELINE.length) running = false
  }

  return {
    start(nextThemeLabel: string) {
      if (session.played) return false
      session.played = true
      themeLabel = nextThemeLabel
      running = true
      runDueBeats()
      return true
    },
    tick(deltaSeconds: number) {
      if (!running) return
      elapsedSeconds = Math.min(elapsedSeconds + deltaSeconds, OPENING_DURATION_SECONDS)
      runDueBeats()
    },
    skip() {
      if (!running) return false
      elapsedSeconds = OPENING_DURATION_SECONDS
      runDueBeats()
      return true
    },
    isRunning() {
      return running
    },
    hasPlayed() {
      return session.played
    }
  }
}
