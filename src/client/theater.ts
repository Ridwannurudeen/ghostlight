import { Material, MeshCollider, MeshRenderer, Transform, engine, type Entity } from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3, type Vector3 as Vector3Type } from '@dcl/sdk/math'

export type TheaterRegion = 'outside' | 'foyer' | 'house' | 'stage'

export const STAGE_PERFORMER_POSITION = Vector3.create(8, 0.72, 13.25)
export const STAGE_PREVIEW_POSITION = Vector3.create(11.6, 0.72, 12.9)
export const STAGE_CAMERA_POSITION = Vector3.create(8, 3.2, 7.25)

export const AUDIENCE_POSITIONS = [
  Vector3.create(3.3, 0, 9.45),
  Vector3.create(5.15, 0, 9.45),
  Vector3.create(7, 0, 9.45),
  Vector3.create(9, 0, 9.45),
  Vector3.create(10.85, 0, 9.45),
  Vector3.create(12.7, 0, 9.45)
] as const

const FOYER_CENTER = Vector3.create(8, 0, 3.6)
const HOUSE_CENTER = Vector3.create(8, 0, 10.7)
const STAGE_CENTER = Vector3.create(8, 0, 13.25)
const DECODE_AREA_CENTER = Vector3.create(8, 0, 7.7)

const FOYER_RADIUS = 6.1
const HOUSE_RADIUS = 5.6
const STAGE_RADIUS = 2.35
const DECODE_AREA_RADIUS = 2.4

const MIDNIGHT = Color4.create(0.035, 0.025, 0.055, 1)
const NIGHT_PLUM = Color4.create(0.09, 0.045, 0.12, 1)
const VELVET = Color4.create(0.34, 0.025, 0.07, 1)
const VELVET_DARK = Color4.create(0.16, 0.018, 0.045, 1)
const ANTIQUE_GOLD = Color4.create(0.76, 0.52, 0.16, 1)
const WARM_IVORY = Color4.create(0.82, 0.74, 0.58, 1)
const SEAT_INK = Color4.create(0.12, 0.055, 0.11, 1)

let theaterCreated = false

export function createTheater() {
  if (theaterCreated) return
  theaterCreated = true

  createBox(Vector3.create(8, -0.06, 8), Vector3.create(15.8, 0.12, 15.8), MIDNIGHT)
  createBox(Vector3.create(8, 0.015, 3.65), Vector3.create(15.4, 0.03, 7.1), NIGHT_PLUM)
  createBox(Vector3.create(8, 0.025, 2.15), Vector3.create(11.8, 0.05, 0.8), WARM_IVORY)
  createBox(Vector3.create(13.25, 0.025, 4.4), Vector3.create(1.3, 0.05, 5.3), WARM_IVORY)
  createBox(Vector3.create(7.5, 0.025, 6.4), Vector3.create(10.2, 0.05, 0.8), WARM_IVORY)

  createBox(Vector3.create(5.4, 0.55, 3.35), Vector3.create(10.8, 1.1, 0.18), ANTIQUE_GOLD, true)
  createBox(Vector3.create(10.6, 0.55, 5.45), Vector3.create(10.8, 1.1, 0.18), ANTIQUE_GOLD, true)

  createBox(Vector3.create(2.5, 1.55, 7.25), Vector3.create(5, 3.1, 0.24), VELVET_DARK, true)
  createBox(Vector3.create(13.5, 1.55, 7.25), Vector3.create(5, 3.1, 0.24), VELVET_DARK, true)
  createBox(Vector3.create(8, 3.02, 7.25), Vector3.create(6, 0.24, 0.28), ANTIQUE_GOLD)

  createBox(Vector3.create(8, 0.02, 11.45), Vector3.create(15.4, 0.04, 8.2), NIGHT_PLUM)
  createBox(Vector3.create(0.15, 2.25, 11.6), Vector3.create(0.3, 4.5, 8.6), VELVET_DARK, true)
  createBox(Vector3.create(15.85, 2.25, 11.6), Vector3.create(0.3, 4.5, 8.6), VELVET_DARK, true)

  createBox(Vector3.create(8, 0.35, 13.3), Vector3.create(12.6, 0.7, 4.3), VELVET_DARK, true)
  createBox(Vector3.create(8, 0.73, 11.2), Vector3.create(12.6, 0.16, 0.18), ANTIQUE_GOLD)
  createBox(Vector3.create(8, 2.6, 15.7), Vector3.create(15.4, 5.2, 0.25), VELVET_DARK, true)
  createBox(Vector3.create(2.25, 2.75, 15.45), Vector3.create(3.2, 4.8, 0.34), VELVET)
  createBox(Vector3.create(13.75, 2.75, 15.45), Vector3.create(3.2, 4.8, 0.34), VELVET)
  createBox(Vector3.create(1.75, 2.75, 12.8), Vector3.create(0.46, 5.1, 0.65), ANTIQUE_GOLD)
  createBox(Vector3.create(14.25, 2.75, 12.8), Vector3.create(0.46, 5.1, 0.65), ANTIQUE_GOLD)
  createBox(Vector3.create(8, 5.15, 12.8), Vector3.create(12.9, 0.36, 0.65), ANTIQUE_GOLD)

  for (const position of AUDIENCE_POSITIONS) {
    createBox(Vector3.create(position.x, 0.34, position.z - 0.45), Vector3.create(1.15, 0.68, 0.9), SEAT_INK)
    createBox(Vector3.create(position.x, 0.92, position.z - 0.78), Vector3.create(1.15, 1.2, 0.22), VELVET)
  }
}

export function getTheaterRegion(position: Vector3Type): TheaterRegion {
  if (isWithin(position, STAGE_CENTER, STAGE_RADIUS)) return 'stage'
  if (isWithin(position, HOUSE_CENTER, HOUSE_RADIUS)) return 'house'
  if (isWithin(position, FOYER_CENTER, FOYER_RADIUS)) return 'foyer'
  return 'outside'
}

export function isInDecodeArea(position: Vector3Type) {
  return isWithin(position, DECODE_AREA_CENTER, DECODE_AREA_RADIUS)
}

function isWithin(position: Vector3Type, center: Vector3Type, radius: number) {
  const x = position.x - center.x
  const z = position.z - center.z
  return x * x + z * z <= radius * radius
}

function createBox(position: Vector3Type, scale: Vector3Type, color: Color4, collidable = false): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, {
    position,
    scale,
    rotation: Quaternion.Identity()
  })
  MeshRenderer.setBox(entity)
  Material.setPbrMaterial(entity, {
    albedoColor: color,
    metallic: color === ANTIQUE_GOLD ? 0.55 : 0.05,
    roughness: color === ANTIQUE_GOLD ? 0.32 : 0.82
  })
  if (collidable) MeshCollider.setBox(entity)
  return entity
}
