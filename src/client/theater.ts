import {
  Billboard,
  EasingFunction,
  GltfContainer,
  GltfNodeModifiers,
  MaterialTransparencyMode,
  TextShape,
  Transform,
  Tween,
  engine,
  type Entity
} from '@dcl/sdk/ecs'
import {
  Color3,
  Color4,
  Quaternion,
  Vector3,
  type Color3 as Color3Type,
  type Vector3 as Vector3Type
} from '@dcl/sdk/math'

export type TheaterRegion = 'outside' | 'foyer' | 'house' | 'stage'
export type LightMood = 'house' | 'tension' | 'hit' | 'miss' | 'applause'
export type SpotlightColor = 'white'

export const STAGE_PERFORMER_POSITION = Vector3.create(8, 0.8, 13.25)
export const STAGE_PREVIEW_POSITION = Vector3.create(11.6, 0.8, 12.9)
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

const CURTAIN_LEFT_CLOSED = Vector3.create(6.36, 0.8, 11.15)
const CURTAIN_RIGHT_CLOSED = Vector3.create(9.64, 0.8, 11.15)
const CURTAIN_LEFT_OPEN = Vector3.create(4.8, 0.8, 11.15)
const CURTAIN_RIGHT_OPEN = Vector3.create(11.2, 0.8, 11.15)
const CURTAIN_SCALE = Vector3.create(1, 1, 1)
const CURTAIN_TWITCH_SCALE = Vector3.create(1.04, 0.96, 1)
const DOORS_CLOSED_SCALE = Vector3.create(1, 1, 1)
const DOORS_OPEN_SCALE = Vector3.create(0.08, 1, 1)

type MoodSettings = {
  color: Color3Type
  intensity: number
  spotlightAlpha: number
}

const MOODS: Record<LightMood, MoodSettings> = {
  house: { color: Color3.create(0.06, 0.88, 1), intensity: 2.4, spotlightAlpha: 0.14 },
  tension: { color: Color3.create(1, 0.58, 0.08), intensity: 3.2, spotlightAlpha: 0.2 },
  hit: { color: Color3.create(0.18, 1, 0.62), intensity: 4.2, spotlightAlpha: 0.28 },
  miss: { color: Color3.create(1, 0.08, 0.16), intensity: 3.6, spotlightAlpha: 0.2 },
  applause: { color: Color3.create(1, 0.72, 0.18), intensity: 4.6, spotlightAlpha: 0.3 }
}

let theaterCreated = false
let curtainsOpen = true
let doorsOpen = false
let curtainLeftEntity: Entity | null = null
let curtainRightEntity: Entity | null = null
let foyerDoorsEntity: Entity | null = null
let marqueeEntity: Entity | null = null
let marqueeTextEntity: Entity | null = null
let spotlightEntity: Entity | null = null
const lightEntities: Entity[] = []

export const curtains = {
  open() {
    createTheater()
    if (curtainsOpen || curtainLeftEntity === null || curtainRightEntity === null) return
    Tween.setMove(curtainLeftEntity, CURTAIN_LEFT_CLOSED, CURTAIN_LEFT_OPEN, 850, EasingFunction.EF_EASEOUTQUAD)
    Tween.setMove(curtainRightEntity, CURTAIN_RIGHT_CLOSED, CURTAIN_RIGHT_OPEN, 850, EasingFunction.EF_EASEOUTQUAD)
    curtainsOpen = true
  },
  close() {
    createTheater()
    if (!curtainsOpen || curtainLeftEntity === null || curtainRightEntity === null) return
    Tween.setMove(curtainLeftEntity, CURTAIN_LEFT_OPEN, CURTAIN_LEFT_CLOSED, 850, EasingFunction.EF_EASEOUTQUAD)
    Tween.setMove(curtainRightEntity, CURTAIN_RIGHT_OPEN, CURTAIN_RIGHT_CLOSED, 850, EasingFunction.EF_EASEOUTQUAD)
    curtainsOpen = false
  },
  twitch() {
    createTheater()
    if (curtainLeftEntity === null || curtainRightEntity === null) return
    const leftPosition = curtainsOpen ? CURTAIN_LEFT_OPEN : CURTAIN_LEFT_CLOSED
    const rightPosition = curtainsOpen ? CURTAIN_RIGHT_OPEN : CURTAIN_RIGHT_CLOSED
    Transform.createOrReplace(curtainLeftEntity, { position: leftPosition, scale: CURTAIN_TWITCH_SCALE })
    Transform.createOrReplace(curtainRightEntity, { position: rightPosition, scale: CURTAIN_TWITCH_SCALE })
    Tween.setScale(curtainLeftEntity, CURTAIN_TWITCH_SCALE, CURTAIN_SCALE, 220, EasingFunction.EF_EASEOUTQUAD)
    Tween.setScale(curtainRightEntity, CURTAIN_TWITCH_SCALE, CURTAIN_SCALE, 220, EasingFunction.EF_EASEOUTQUAD)
  }
}

export const foyerDoors = {
  open() {
    createTheater()
    if (doorsOpen || foyerDoorsEntity === null) return
    Tween.setScale(foyerDoorsEntity, DOORS_CLOSED_SCALE, DOORS_OPEN_SCALE, 900, EasingFunction.EF_EASEOUTQUAD)
    doorsOpen = true
  },
  close() {
    createTheater()
    if (!doorsOpen || foyerDoorsEntity === null) return
    Tween.setScale(foyerDoorsEntity, DOORS_OPEN_SCALE, DOORS_CLOSED_SCALE, 900, EasingFunction.EF_EASEOUTQUAD)
    doorsOpen = false
  }
}

export const marquee = {
  setText(text: string) {
    createTheater()
    if (marqueeTextEntity === null) return
    TextShape.createOrReplace(marqueeTextEntity, {
      text,
      fontSize: 3,
      width: 5.3,
      height: 1.05,
      textWrapping: true,
      lineCount: 2,
      textColor: Color4.create(0.95, 0.92, 0.72, 1),
      outlineWidth: 0.08,
      outlineColor: Color3.create(0.12, 0.015, 0.03)
    })
  }
}

export const lights = {
  set(mood: LightMood) {
    createTheater()
    const settings = MOODS[mood]
    for (const entity of lightEntities) setEmissiveMaterial(entity, settings, false)
    if (spotlightEntity !== null) setEmissiveMaterial(spotlightEntity, settings, true)
  },
  setSpotlightColor(color: SpotlightColor) {
    createTheater()
    if (spotlightEntity === null) return
    if (color === 'white') {
      setEmissiveMaterial(
        spotlightEntity,
        { color: Color3.create(1, 1, 1), intensity: 4.4, spotlightAlpha: 0.32 },
        true
      )
    }
  }
}

export function createTheater() {
  if (theaterCreated) return
  theaterCreated = true

  foyerDoorsEntity = createModel('foyer_doors.glb', Vector3.create(8, 0, 5.8))
  marqueeEntity = createModel('marquee.glb', Vector3.create(8, 4.55, 5.8))
  lightEntities.push(marqueeEntity)

  marqueeTextEntity = engine.addEntity()
  Transform.create(marqueeTextEntity, { position: Vector3.create(8, 5.38, 5.45) })
  Billboard.create(marqueeTextEntity, {})
  marquee.setText('GHOST CHARADES')

  createModel('poster_frame.glb', Vector3.create(2.45, 0, 3.5))
  createModel('poster_frame.glb', Vector3.create(13.55, 0, 3.5))
  createModel('pedestal.glb', Vector3.create(13.6, 0, 5.05))

  for (const z of [9.45, 8.87, 8.29, 7.71, 7.13, 6.55]) {
    createModel('seat_row.glb', Vector3.create(8, 0, z), Vector3.create(1.44, 1, 1))
  }

  const chandelier = createModel('chandelier.glb', Vector3.create(8, 2.85, 7.35), Vector3.create(0.85, 0.85, 0.85))
  lightEntities.push(chandelier)

  createModel('stage.glb', Vector3.create(8, 0, 12.55))
  createModel('proscenium.glb', Vector3.create(8, 0.72, 11.05))
  curtainLeftEntity = createModel('curtain_left.glb', CURTAIN_LEFT_OPEN)
  curtainRightEntity = createModel('curtain_right.glb', CURTAIN_RIGHT_OPEN)

  for (const x of [5, 7, 9, 11]) {
    const footlight = createModel('footlight.glb', Vector3.create(x, 0.79, 10.55))
    lightEntities.push(footlight)
  }

  spotlightEntity = createModel('spotlight_cone.glb', STAGE_PERFORMER_POSITION)
  lights.set('house')
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

function createModel(file: string, position: Vector3Type, scale = Vector3.create(1, 1, 1)): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, { position, scale, rotation: Quaternion.Identity() })
  GltfContainer.create(entity, { src: `assets/models/${file}` })
  return entity
}

function setEmissiveMaterial(entity: Entity, settings: MoodSettings, transparent: boolean) {
  GltfNodeModifiers.createOrReplace(entity, {
    modifiers: [
      {
        path: '',
        castShadows: !transparent,
        material: {
          material: {
            $case: 'pbr',
            pbr: {
              albedoColor: Color4.create(
                settings.color.r * 0.3,
                settings.color.g * 0.3,
                settings.color.b * 0.3,
                transparent ? settings.spotlightAlpha : 1
              ),
              emissiveColor: settings.color,
              emissiveIntensity: settings.intensity,
              metallic: 0.12,
              roughness: 0.35,
              castShadows: !transparent,
              transparencyMode: transparent
                ? MaterialTransparencyMode.MTM_ALPHA_BLEND
                : MaterialTransparencyMode.MTM_OPAQUE
            }
          }
        }
      }
    ]
  })
}
