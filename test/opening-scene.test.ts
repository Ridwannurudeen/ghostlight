import { describe, expect, it, vi } from 'vitest'

const scene = vi.hoisted(() => ({
  play: vi.fn(),
  switchTheaterCamera: vi.fn(),
  releaseTheaterCamera: vi.fn(),
  openDoors: vi.fn(),
  setMarquee: vi.fn()
}))

vi.mock('../src/client/sound', () => ({ play: scene.play }))
vi.mock('../src/client/setup', () => ({
  switchTheaterCamera: scene.switchTheaterCamera,
  releaseTheaterCamera: scene.releaseTheaterCamera
}))
vi.mock('../src/client/theater', () => ({
  foyerDoors: { open: scene.openDoors },
  marquee: { setText: scene.setMarquee }
}))

import { createSceneOpeningController, getOpeningViewState, skipOpening } from '../src/client/opening-scene'

describe('cold-open scene adapter', () => {
  it('coordinates the rig, curtain sound, skippable UI, and final decode state', () => {
    const enterPerformer = vi.fn()
    const showDecode = vi.fn()
    const controller = createSceneOpeningController(enterPerformer, showDecode)

    expect(controller.start('Opening Night')).toBe(true)
    expect(getOpeningViewState()).toEqual({ active: true, instruction: '' })
    expect(scene.switchTheaterCamera).toHaveBeenCalledWith('foyer')

    controller.tick(2.5)
    expect(scene.setMarquee).toHaveBeenCalledWith("TONIGHT'S SHOW: Opening Night")
    expect(scene.play).toHaveBeenCalledWith('curtain')
    expect(scene.openDoors).toHaveBeenCalledTimes(1)

    expect(skipOpening()).toBe(true)
    expect(scene.switchTheaterCamera).toHaveBeenLastCalledWith('stage')
    expect(scene.releaseTheaterCamera).toHaveBeenCalledTimes(1)
    expect(enterPerformer).toHaveBeenCalledTimes(1)
    expect(showDecode).toHaveBeenCalledTimes(1)
    expect(getOpeningViewState()).toEqual({ active: false, instruction: '' })
    expect(controller.hasPlayed()).toBe(true)
    expect(controller.start('Second Show')).toBe(false)
  })

  it('releases camera ownership when a running opening is invalidated', () => {
    const controller = createSceneOpeningController(vi.fn(), vi.fn())
    expect(controller.start('Opening Night')).toBe(true)

    expect(controller.cancel()).toBe(true)

    expect(scene.releaseTheaterCamera).toHaveBeenCalled()
    expect(getOpeningViewState()).toEqual({ active: false, instruction: '' })
  })
})
