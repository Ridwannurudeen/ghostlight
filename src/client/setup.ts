import { MainCamera, TouchScreenControls, Transform, VirtualCamera, engine, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { getPlatform, isMobile, type Platform } from '@dcl/sdk/platform'
import { ReactEcsRenderer, type UiComponent } from '@dcl/sdk/react-ecs'
import { getPerformerEntity, initializeGhosts } from './ghosts'
import { STAGE_CAMERA_POSITION, createTheater, getTheaterRegion, isInDecodeArea, type TheaterRegion } from './theater'

const SETUP_SYSTEM = 'ghost-charades::client-setup'

export type TheaterCamera = 'foyer' | 'stage' | 'reveal'

const CAMERA_POSITIONS: Record<TheaterCamera, ReturnType<typeof Vector3.create>> = {
  foyer: Vector3.create(8, 3.55, 0.75),
  stage: STAGE_CAMERA_POSITION,
  reveal: Vector3.create(8, 2.25, 9.15)
}

let started = false
let platform: Platform | null = null
let mobile = false
let currentRegion: TheaterRegion = 'outside'
let currentCamera: TheaterCamera | 'player' = 'player'
let cameraOverride: TheaterCamera | null = null
let cameraEntities: Partial<Record<TheaterCamera, Entity>> = {}
let uiRenderer: UiComponent | null = null

export function startClientSetup(renderer: UiComponent) {
  if (started) return
  started = true
  uiRenderer = renderer

  createTheater()
  initializeGhosts()

  const lookAtEntity = getPerformerEntity()
  cameraEntities = {
    foyer: createVirtualCamera('foyer', lookAtEntity),
    stage: createVirtualCamera('stage', lookAtEntity),
    reveal: createVirtualCamera('reveal', lookAtEntity)
  }
  applyRequestedCamera()

  engine.addSystem(clientSetupSystem, undefined, SETUP_SYSTEM)
}

export function switchTheaterCamera(camera: TheaterCamera) {
  cameraOverride = camera
  applyRequestedCamera()
}

export function releaseTheaterCamera() {
  cameraOverride = null
  applyRequestedCamera()
}

export function getCurrentTheaterRegion() {
  return currentRegion
}

function clientSetupSystem() {
  if (platform === null) {
    const detectedPlatform = getPlatform()
    if (detectedPlatform === null) return
    configurePlatform(detectedPlatform)
  }

  const playerTransform = Transform.getOrNull(engine.PlayerEntity)
  if (playerTransform === null) return
  currentRegion = getTheaterRegion(playerTransform.position)
  if (cameraOverride === null) applyRequestedCamera()
}

function applyRequestedCamera() {
  const requestedCamera = cameraOverride ?? getAutomaticCamera()
  if (requestedCamera === currentCamera) return
  if (requestedCamera === 'player') {
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
    currentCamera = 'player'
    return
  }

  const entity = cameraEntities[requestedCamera]
  if (entity === undefined) return
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: entity })
  currentCamera = requestedCamera
}

function getAutomaticCamera(): TheaterCamera | 'player' {
  const playerTransform = Transform.getOrNull(engine.PlayerEntity)
  return playerTransform !== null && isInDecodeArea(playerTransform.position) ? 'stage' : 'player'
}

function createVirtualCamera(camera: TheaterCamera, lookAtEntity: Entity) {
  const entity = engine.addEntity()
  Transform.create(entity, { position: CAMERA_POSITIONS[camera] })
  VirtualCamera.create(entity, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.6) },
    lookAtEntity
  })
  return entity
}

function configurePlatform(detectedPlatform: Platform) {
  platform = detectedPlatform
  mobile = isMobile()
  if (mobile) {
    TouchScreenControls.hideAll()
  }

  if (uiRenderer === null) return
  if (mobile) {
    ReactEcsRenderer.setUiRenderer(uiRenderer, {
      screenInset: 'interactable',
      virtualWidth: 1600,
      virtualHeight: 720
    })
  } else {
    ReactEcsRenderer.setUiRenderer(uiRenderer, { screenInset: 'device' })
  }
}
