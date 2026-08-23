import { describe, expect, it, vi } from 'vitest'

const sound = vi.hoisted(() => ({ initializeSounds: vi.fn(), startRoomTone: vi.fn() }))

vi.mock('@dcl/sdk/ecs', () => {
  let nextEntity = 10
  return {
    MainCamera: { createOrReplace: vi.fn() },
    TouchScreenControls: { hideAll: vi.fn() },
    Transform: { create: vi.fn(), getOrNull: vi.fn(() => null) },
    VirtualCamera: {
      create: vi.fn(),
      Transition: { Time: vi.fn(() => ({})) }
    },
    engine: {
      CameraEntity: 2,
      PlayerEntity: 1,
      addEntity: vi.fn(() => ++nextEntity),
      addSystem: vi.fn()
    }
  }
})

vi.mock('@dcl/sdk/math', () => ({ Vector3: { create: (x: number, y: number, z: number) => ({ x, y, z }) } }))

vi.mock('@dcl/sdk/platform', () => ({
  getPlatform: vi.fn(() => ({ client: 'explorer' })),
  isMobile: vi.fn(() => false)
}))

vi.mock('@dcl/sdk/react-ecs', () => ({ ReactEcsRenderer: { setUiRenderer: vi.fn() } }))

vi.mock('../src/client/ghosts', () => ({
  getPerformerEntity: vi.fn(() => 20),
  initializeGhosts: vi.fn()
}))

vi.mock('../src/client/theater', () => ({
  STAGE_CAMERA_POSITION: { x: 8, y: 3.2, z: 7.25 },
  createTheater: vi.fn(),
  getTheaterRegion: vi.fn(() => 'outside'),
  isInDecodeArea: vi.fn(() => false)
}))

vi.mock('../src/client/sound', () => sound)

import { engine } from '@dcl/sdk/ecs'
import { startClientSetup } from '../src/client/setup'

describe('client setup', () => {
  it('initializes sound and starts ambience only after platform detection', () => {
    startClientSetup(() => null)

    expect(sound.initializeSounds).not.toHaveBeenCalled()
    expect(sound.startRoomTone).not.toHaveBeenCalled()

    const setupSystem = vi.mocked(engine.addSystem).mock.calls[0][0]
    setupSystem(0)
    setupSystem(0)

    expect(sound.initializeSounds).toHaveBeenCalledTimes(1)
    expect(sound.startRoomTone).toHaveBeenCalledTimes(1)
  })
})
