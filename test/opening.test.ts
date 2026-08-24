import { describe, expect, it } from 'vitest'
import {
  OPENING_DURATION_SECONDS,
  OPENING_INSTRUCTION,
  OPENING_TIMELINE,
  createOpeningController,
  createOpeningSession,
  type OpeningEffects
} from '../src/client/opening'

function createOpeningHarness() {
  const events: string[] = []
  const effects: OpeningEffects = {
    switchCamera: (camera) => events.push(`camera:${camera}`),
    setMarquee: (text) => events.push(`marquee:${text}`),
    openDoors: () => events.push('doors:open'),
    enterPerformer: () => events.push('performer:enter'),
    showInstruction: (text) => events.push(`instruction:${text}`),
    showDecode: () => events.push('decode')
  }
  return { events, effects }
}

describe('cold open', () => {
  it('runs every beat at its exact time and in order', () => {
    const { events, effects } = createOpeningHarness()
    const controller = createOpeningController(effects)

    expect(OPENING_TIMELINE.map(({ name, at }) => ({ name, at }))).toEqual([
      { name: 'foyer-camera', at: 0 },
      { name: 'marquee', at: 1 },
      { name: 'doors-open', at: 2.5 },
      { name: 'stage-camera', at: 4.5 },
      { name: 'performer-entrance', at: 6 },
      { name: 'instruction', at: 8 },
      { name: 'decode', at: 10 }
    ])

    expect(controller.start('First Impressions')).toBe(true)
    expect(events).toEqual(['camera:foyer'])

    let elapsed = 0
    for (const beat of OPENING_TIMELINE.slice(1)) {
      const beforeBeat = beat.at - elapsed - 0.001
      controller.tick(beforeBeat)
      expect(events).toHaveLength(OPENING_TIMELINE.indexOf(beat))
      controller.tick(0.001)
      elapsed = beat.at
      expect(events).toHaveLength(OPENING_TIMELINE.indexOf(beat) + 1)
    }

    expect(events).toEqual([
      'camera:foyer',
      "marquee:TONIGHT'S SHOW: First Impressions",
      'doors:open',
      'camera:stage',
      'performer:enter',
      `instruction:${OPENING_INSTRUCTION}`,
      'decode'
    ])
    expect(controller.isRunning()).toBe(false)
  })

  it('skips immediately to the same completed scene state', () => {
    const { events, effects } = createOpeningHarness()
    const controller = createOpeningController(effects)

    controller.start('Main Character Energy')
    controller.tick(1)

    expect(controller.skip()).toBe(true)
    expect(events).toEqual([
      'camera:foyer',
      "marquee:TONIGHT'S SHOW: Main Character Energy",
      'doors:open',
      'camera:stage',
      'performer:enter',
      `instruction:${OPENING_INSTRUCTION}`,
      'decode'
    ])
    expect(controller.skip()).toBe(false)
    expect(controller.isRunning()).toBe(false)
  })

  it('renders the marquee and instruction in the selected language', () => {
    const { events, effects } = createOpeningHarness()
    const controller = createOpeningController(effects)

    controller.start('Grandes emociones', 'es')
    controller.tick(OPENING_DURATION_SECONDS)

    expect(events).toContain('marquee:FUNCIÓN DE HOY: Grandes emociones')
    expect(events).toContain('instruction:Adivina qué están diciendo')
  })

  it('never runs twice in one session, including across controllers', () => {
    const first = createOpeningHarness()
    const second = createOpeningHarness()
    const session = createOpeningSession()
    const firstController = createOpeningController(first.effects, session)
    const secondController = createOpeningController(second.effects, session)

    expect(firstController.start('Fashionably Haunted')).toBe(true)
    firstController.tick(OPENING_DURATION_SECONDS)
    expect(firstController.start('Final Encore')).toBe(false)
    expect(secondController.start('Final Encore')).toBe(false)
    expect(first.events).toHaveLength(OPENING_TIMELINE.length)
    expect(second.events).toEqual([])
    expect(firstController.hasPlayed()).toBe(true)
  })
})
