import { describe, expect, it, vi } from 'vitest'
import { SOUND_CLIPS, createSoundController, type SoundSource } from '../src/client/sound'

function createSoundHarness() {
  let nextEntity = 0
  const sources = new Map<number, SoundSource>()
  const playSource = vi.fn()
  const controller = createSoundController({
    createEntity: () => ++nextEntity,
    createSource: (entity, source) => sources.set(entity, { ...source }),
    playSource,
    getMutableSource: (entity) => sources.get(entity)!
  })
  return { controller, sources, playSource, entityCount: () => nextEntity }
}

describe('sound controller', () => {
  it('creates one persistent source per clip and reuses it for every play', () => {
    const { controller, sources, playSource, entityCount } = createSoundHarness()

    controller.initialize()
    controller.initialize()
    controller.play('tick')
    controller.play('tick')
    controller.play('hit')
    controller.play('laugh')

    expect(entityCount()).toBe(Object.keys(SOUND_CLIPS).length)
    expect(sources.size).toBe(Object.keys(SOUND_CLIPS).length)
    expect(playSource.mock.calls[0][0]).toBe(playSource.mock.calls[1][0])
    expect(playSource.mock.calls[2][0]).not.toBe(playSource.mock.calls[0][0])
    expect(playSource.mock.calls[3][0]).not.toBe(playSource.mock.calls[2][0])
    expect(playSource.mock.calls.map((call) => call[1])).toEqual([
      'assets/sounds/tick.mp3',
      'assets/sounds/tick.mp3',
      'assets/sounds/hit.mp3',
      'assets/sounds/laugh.mp3'
    ])
  })

  it('starts looping room tone only when requested and ducks it idempotently during reveal', () => {
    const { controller, sources } = createSoundHarness()

    controller.initialize()
    const roomTone = [...sources.values()].find((source) => source.audioClipUrl === SOUND_CLIPS.roomTone)!
    expect(roomTone).toMatchObject({ playing: false, loop: true, volume: 0.28, global: true })

    controller.startRoomTone()
    controller.startRoomTone()
    expect(roomTone).toMatchObject({ playing: true, currentTime: 0, volume: 0.28 })

    controller.duckForReveal()
    controller.duckForReveal()
    expect(roomTone.volume).toBe(0.07)

    controller.restoreAfterReveal()
    controller.restoreAfterReveal()
    expect(roomTone.volume).toBe(0.28)
  })

  it('mutes active sources and applies the selected coarse volume when sound is enabled', () => {
    const { controller, sources, playSource } = createSoundHarness()

    controller.initialize()
    controller.startRoomTone()
    controller.setSettings({ soundEnabled: true, soundVolume: 0.5 })

    const roomTone = [...sources.values()].find((source) => source.audioClipUrl === SOUND_CLIPS.roomTone)!
    const tick = [...sources.values()].find((source) => source.audioClipUrl === SOUND_CLIPS.tick)!
    expect(roomTone.volume).toBeCloseTo(0.14)
    expect(tick.volume).toBeCloseTo(0.5)

    controller.play('tick')
    expect(playSource).toHaveBeenCalledTimes(1)

    controller.setSettings({ soundEnabled: false, soundVolume: 0.5 })
    expect([...sources.values()].every((source) => source.playing === false && source.currentTime === 0)).toBe(true)
    controller.play('hit')
    expect(playSource).toHaveBeenCalledTimes(1)

    controller.setSettings({ soundEnabled: true, soundVolume: 0.5 })
    expect(roomTone.playing).toBe(true)
    controller.duckForReveal()
    expect(roomTone.volume).toBeCloseTo(0.035)
    controller.restoreAfterReveal()
    expect(roomTone.volume).toBeCloseTo(0.14)
  })
})
