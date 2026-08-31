import { describe, expect, it } from 'vitest'
import {
  OPENING_DURATION_SECONDS,
  OPENING_INSTRUCTION,
  OPENING_TIMELINE,
  createOpeningController,
  createOpeningSession,
  type OpeningEffects
} from '../src/client/opening'
import { t } from '../src/shared/i18n'

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
  it('puts useful first-play guidance on screen immediately and reaches decode within four seconds', () => {
    const { events, effects } = createOpeningHarness()
    const controller = createOpeningController(effects)

    expect(OPENING_DURATION_SECONDS).toBeLessThanOrEqual(4)
    expect(controller.start('First Impressions')).toBe(true)
    expect(events).toContain(`instruction:${OPENING_INSTRUCTION}`)

    controller.tick(OPENING_DURATION_SECONDS)
    expect(events.slice(-2)).toEqual(['decode', 'performer:enter'])
  })

  it('runs every beat at its exact time and in order', () => {
    const { events, effects } = createOpeningHarness()
    const controller = createOpeningController(effects)

    expect(OPENING_TIMELINE.map(({ name, at }) => ({ name, at }))).toEqual([
      { name: 'foyer-camera', at: 0 },
      { name: 'instruction', at: 0 },
      { name: 'marquee', at: 0.5 },
      { name: 'doors-open', at: 1 },
      { name: 'stage-camera', at: 1.75 },
      { name: 'decode', at: 4 },
      { name: 'performer-entrance', at: 4 }
    ])

    expect(controller.start('First Impressions')).toBe(true)
    expect(events).toEqual(['camera:foyer', `instruction:${OPENING_INSTRUCTION}`])

    controller.tick(0.499)
    expect(events).toHaveLength(2)
    controller.tick(0.001)
    expect(events).toHaveLength(3)
    controller.tick(0.5)
    expect(events).toHaveLength(4)
    controller.tick(0.75)
    expect(events).toHaveLength(5)
    controller.tick(OPENING_DURATION_SECONDS - 1.75)
    expect(events).toHaveLength(7)

    expect(events).toEqual([
      'camera:foyer',
      `instruction:${OPENING_INSTRUCTION}`,
      "marquee:TONIGHT'S SHOW: First Impressions",
      'doors:open',
      'camera:stage',
      'decode',
      'performer:enter'
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
      `instruction:${OPENING_INSTRUCTION}`,
      "marquee:TONIGHT'S SHOW: Main Character Energy",
      'doors:open',
      'camera:stage',
      'decode',
      'performer:enter'
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
    expect(events).toContain(`instruction:${t('opening.instruction', 'es')}`)
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
