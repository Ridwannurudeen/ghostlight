import { beforeEach, describe, expect, it, vi } from 'vitest'

const scene = vi.hoisted(() => {
  const events: string[] = []
  return {
    events,
    performerComplete: false,
    play: vi.fn(),
    switchTheaterCamera: vi.fn((camera: string) => events.push(`camera:${camera}`)),
    releaseTheaterCamera: vi.fn(() => events.push('camera:release')),
    openDoors: vi.fn(),
    setMarquee: vi.fn()
  }
})

vi.mock('@dcl/sdk/ecs', () => ({
  engine: { addSystem: vi.fn() },
  Schemas: {
    Map: (value: unknown) => value,
    Array: (value: unknown) => value,
    Optional: (value: unknown) => value,
    String: 'string',
    Boolean: 'boolean',
    Number: 'number',
    Int: 'int',
    Int64: 'int64'
  }
}))
vi.mock('@dcl/sdk/network', () => ({
  registerMessages: () => ({ send: vi.fn(), onMessage: vi.fn(), onReady: vi.fn(), isReady: () => false })
}))
vi.mock('@dcl/sdk/src/players', () => ({ getPlayer: () => null }))

vi.mock('../src/client/sound', () => ({ play: scene.play }))
vi.mock('../src/client/setup', () => ({
  switchTheaterCamera: scene.switchTheaterCamera,
  releaseTheaterCamera: scene.releaseTheaterCamera
}))
vi.mock('../src/client/theater', () => ({
  foyerDoors: { open: scene.openDoors },
  marquee: { setText: scene.setMarquee }
}))
vi.mock('../src/client/ghosts', () => ({
  hasPerformerCompletedSequence: () => scene.performerComplete
}))

import { createSceneOpeningController, getOpeningViewState, skipOpening } from '../src/client/opening-scene'
import { OPENING_INSTRUCTION } from '../src/client/opening'
import { createFlowRuntime, type OutboundMessage, type ServerMessage } from '../src/client/flow'
import { showPolicyForTimestamp } from '../src/shared/show-policy'
import { FIXED_NOW, makeLook } from './test-helpers'

describe('cold-open scene adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scene.events.length = 0
    scene.performerComplete = false
  })

  it('coordinates the rig, curtain sound, skippable UI, and final decode state', () => {
    const enterPerformer = vi.fn(() => {
      scene.events.push('performer:enter')
      expect(getOpeningViewState()).toEqual({ active: false, instruction: '' })
    })
    const showDecode = vi.fn()
    const controller = createSceneOpeningController(enterPerformer, showDecode)

    expect(controller.start('Opening Night')).toBe(true)
    expect(getOpeningViewState()).toEqual({ active: true, instruction: OPENING_INSTRUCTION })
    expect(scene.switchTheaterCamera).toHaveBeenCalledWith('foyer')

    controller.tick(2.5)
    expect(scene.setMarquee).toHaveBeenCalledWith("TONIGHT'S SHOW: Opening Night")
    expect(scene.play).toHaveBeenCalledWith('curtain')
    expect(scene.openDoors).toHaveBeenCalledTimes(1)

    expect(skipOpening()).toBe(true)
    expect(scene.switchTheaterCamera).toHaveBeenLastCalledWith('stage')
    expect(scene.events.indexOf('camera:stage')).toBeLessThan(scene.events.indexOf('performer:enter'))
    expect(scene.releaseTheaterCamera).not.toHaveBeenCalled()
    expect(enterPerformer).toHaveBeenCalledTimes(1)
    expect(showDecode).toHaveBeenCalledTimes(1)
    expect(getOpeningViewState()).toEqual({ active: false, instruction: '' })
    expect(controller.hasPlayed()).toBe(true)
    expect(controller.start('Second Show')).toBe(false)

    controller.tick(7.4)
    expect(scene.releaseTheaterCamera).not.toHaveBeenCalled()
    scene.performerComplete = true
    controller.tick(0.1)
    expect(scene.releaseTheaterCamera).toHaveBeenCalledTimes(1)
  })

  it('keeps the scheduled stage camera after the overlay closes until the first performer completes', () => {
    const enterPerformer = vi.fn()
    const showDecode = vi.fn()
    const controller = createSceneOpeningController(enterPerformer, showDecode)

    expect(controller.start('Opening Night')).toBe(true)
    controller.tick(4)

    expect(getOpeningViewState()).toEqual({ active: false, instruction: '' })
    expect(scene.switchTheaterCamera).toHaveBeenLastCalledWith('stage')
    expect(enterPerformer).toHaveBeenCalledTimes(1)
    expect(showDecode).toHaveBeenCalledTimes(1)
    expect(scene.releaseTheaterCamera).not.toHaveBeenCalled()

    scene.performerComplete = true
    controller.tick(0)

    expect(scene.releaseTheaterCamera).toHaveBeenCalledTimes(1)
  })

  it('runs the production opening outside the decode area and releases its camera after playback', () => {
    const sent: OutboundMessage[] = []
    const performer = vi.fn()
    let stagedPerformer: Parameters<typeof performer> | null = null
    let openingReadyForPerformer = false
    let requestSequence = 0
    const opening = createSceneOpeningController(() => {
      openingReadyForPerformer = true
      if (!stagedPerformer) return
      performer(...stagedPerformer)
      stagedPerformer = null
    }, vi.fn())
    const runtime = createFlowRuntime({
      send: (message) => sent.push(message),
      now: () => FIXED_NOW,
      createRequestId: () => `opening-${++requestSequence}`,
      canDecode: () => false,
      effects: {
        showPerformer: (look, emotes) => {
          if (opening.isRunning() && !openingReadyForPerformer) {
            stagedPerformer = [look, emotes]
            return
          }
          performer(look, emotes)
        },
        cancelOpening: opening.cancel
      }
    })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const policy = showPolicyForTimestamp(FIXED_NOW)!
    runtime.receive({
      type: 'showSchedule',
      data: {
        instanceId: 'server',
        serverTime: FIXED_NOW,
        showKey: policy.showKey,
        ...(policy.kind === 'season-zero' ? { season: policy.season } : {})
      }
    })

    expect(opening.start('Opening Night')).toBe(true)
    expect(runtime.requestNextCharade()).toBe(false)
    expect(runtime.requestOpeningCharade()).toBe(true)
    expect(runtime.requestOpeningCharade()).toBe(false)
    const requestId = runtime.getState().pending[0].requestId
    expect(sent.filter((message) => message.type === 'nextCharade')).toHaveLength(1)
    const charade: Extract<ServerMessage, { type: 'charade' }> = {
      type: 'charade',
      data: {
        requestId,
        id: 'opening-house',
        authorName: 'House Ghost',
        authorAddress: 'house',
        look: makeLook('house', 'House Ghost'),
        emotes: ['wave', 'clap', 'dab'],
        answers: ['Answer one', 'Answer two', 'Answer three'],
        createdAt: FIXED_NOW,
        isHouse: true
      }
    }
    runtime.receive(charade)

    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: 'opening-house' } })
    expect(runtime.guess(0)).toBe(false)
    expect(performer).not.toHaveBeenCalled()
    opening.tick(4)
    expect(performer).toHaveBeenCalledTimes(1)
    expect(scene.releaseTheaterCamera).not.toHaveBeenCalled()

    scene.performerComplete = true
    opening.tick(0)
    expect(scene.releaseTheaterCamera).toHaveBeenCalledTimes(1)
  })

  it('releases camera ownership when a running or performer-held opening is invalidated', () => {
    const controller = createSceneOpeningController(vi.fn(), vi.fn())
    expect(controller.start('Opening Night')).toBe(true)

    expect(controller.cancel()).toBe(true)

    expect(scene.releaseTheaterCamera).toHaveBeenCalledTimes(1)
    expect(getOpeningViewState()).toEqual({ active: false, instruction: '' })

    const heldController = createSceneOpeningController(vi.fn(), vi.fn())
    expect(heldController.start('Next Opening')).toBe(true)
    expect(heldController.skip()).toBe(true)
    expect(scene.releaseTheaterCamera).toHaveBeenCalledTimes(1)

    expect(heldController.cancel()).toBe(true)
    expect(scene.releaseTheaterCamera).toHaveBeenCalledTimes(2)
    expect(heldController.cancel()).toBe(false)
    expect(scene.releaseTheaterCamera).toHaveBeenCalledTimes(2)
  })
})
