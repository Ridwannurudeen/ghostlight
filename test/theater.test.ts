import { GltfContainer, GltfNodeModifiers, TextShape, Tween } from '@dcl/sdk/ecs'
import { describe, expect, it, vi } from 'vitest'
import { createTheater, curtains, foyerDoors, getTheaterRegion, lights, marquee } from '../src/client/theater'

vi.mock('@dcl/sdk/ecs', () => {
  let nextEntity = 0
  return {
    Billboard: { create: vi.fn() },
    EasingFunction: { EF_EASEOUTQUAD: 2 },
    GltfContainer: { create: vi.fn() },
    GltfNodeModifiers: { createOrReplace: vi.fn() },
    MaterialTransparencyMode: { MTM_OPAQUE: 0, MTM_ALPHA_BLEND: 2 },
    TextShape: { createOrReplace: vi.fn() },
    Transform: { create: vi.fn(), createOrReplace: vi.fn() },
    Tween: { setMove: vi.fn(), setScale: vi.fn() },
    engine: { addEntity: vi.fn(() => ++nextEntity) }
  }
})

vi.mock('@dcl/sdk/math', () => ({
  Color3: { create: (r: number, g: number, b: number) => ({ r, g, b }) },
  Color4: { create: (r: number, g: number, b: number, a: number) => ({ r, g, b, a }) },
  Quaternion: { Identity: () => ({ x: 0, y: 0, z: 0, w: 1 }) },
  Vector3: { create: (x: number, y: number, z: number) => ({ x, y, z }) }
}))

describe('generated theater rig', () => {
  it('builds the complete GLB kit and reuses its entities for show controls', () => {
    createTheater()

    const sources = vi.mocked(GltfContainer.create).mock.calls.map(([, value]) => value.src)
    expect(sources).toHaveLength(21)
    expect(sources.filter((source) => source === 'assets/models/seat_row.glb')).toHaveLength(6)
    expect(new Set(sources)).toEqual(
      new Set([
        'assets/models/chandelier.glb',
        'assets/models/curtain_left.glb',
        'assets/models/curtain_right.glb',
        'assets/models/footlight.glb',
        'assets/models/foyer_doors.glb',
        'assets/models/marquee.glb',
        'assets/models/pedestal.glb',
        'assets/models/poster_frame.glb',
        'assets/models/proscenium.glb',
        'assets/models/seat_row.glb',
        'assets/models/spotlight_cone.glb',
        'assets/models/stage.glb'
      ])
    )

    lights.set('hit')
    expect(GltfNodeModifiers.createOrReplace).toHaveBeenCalledTimes(14)
    lights.setSpotlightColor('white')
    expect(GltfNodeModifiers.createOrReplace).toHaveBeenCalledTimes(15)

    curtains.close()
    curtains.open()
    curtains.twitch()
    expect(Tween.setMove).toHaveBeenCalledTimes(4)
    expect(Tween.setScale).toHaveBeenCalledTimes(2)

    foyerDoors.open()
    foyerDoors.close()
    expect(Tween.setScale).toHaveBeenCalledTimes(4)

    marquee.setText("TONIGHT'S SHOW: AFTER HOURS")
    expect(TextShape.createOrReplace).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.objectContaining({ text: "TONIGHT'S SHOW: AFTER HOURS" })
    )

    expect(getTheaterRegion({ x: 8, y: 0, z: 13.25 })).toBe('stage')
    expect(getTheaterRegion({ x: 8, y: 0, z: 10.7 })).toBe('house')
    expect(getTheaterRegion({ x: 8, y: 0, z: 3.6 })).toBe('foyer')
    expect(getTheaterRegion({ x: 20, y: 0, z: 20 })).toBe('outside')
  })
})
