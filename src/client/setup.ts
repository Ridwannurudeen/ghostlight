import { MainCamera, TouchScreenControls, Transform, VirtualCamera, engine, type Entity } from '@dcl/sdk/ecs'
import { getPlatform, isMobile, type Platform } from '@dcl/sdk/platform'
import { ReactEcsRenderer, type UiComponent } from '@dcl/sdk/react-ecs'
import { getPerformerEntity, initializeGhosts } from './ghosts'
import { STAGE_CAMERA_POSITION, createTheater, getTheaterRegion, isInDecodeArea, type TheaterRegion } from './theater'

const SETUP_SYSTEM = 'ghost-charades::client-setup'

let started = false
let platform: Platform | null = null
let mobile = false
let currentRegion: TheaterRegion = 'outside'
let stageCameraActive = false
let cameraEntity: Entity | null = null
let uiRenderer: UiComponent | null = null

export function startClientSetup(renderer: UiComponent) {
  if (started) return
  started = true
  uiRenderer = renderer

  createTheater()
  initializeGhosts()

  cameraEntity = engine.addEntity()
  Transform.create(cameraEntity, { position: STAGE_CAMERA_POSITION })
  VirtualCamera.create(cameraEntity, { lookAtEntity: getPerformerEntity() })

  engine.addSystem(clientSetupSystem, undefined, SETUP_SYSTEM)
}

function engageStageCamera() {
  if (stageCameraActive || cameraEntity === null) return
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: cameraEntity })
  stageCameraActive = true
}

function releaseStageCamera() {
  if (!stageCameraActive) return
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  stageCameraActive = false
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
  const playerPosition = playerTransform.position
  currentRegion = getTheaterRegion(playerPosition)
  if (isInDecodeArea(playerPosition)) engageStageCamera()
  else releaseStageCamera()
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
