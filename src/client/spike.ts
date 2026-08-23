import {
  AvatarShape,
  InputAction,
  MeshCollider,
  MeshRenderer,
  TouchScreenControls,
  Transform,
  engine,
  pointerEventsSystem
} from '@dcl/sdk/ecs'
import { Color3, Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlatform } from '@dcl/sdk/platform'
import { getPlayer } from '@dcl/sdk/src/players'
import { room } from '../shared/messages'

// Three emotes from the list the docs publish AND the mobile client ships.
export const EMOTES = ['dab', 'shrug', 'headexplode'] as const

export const spike = {
  platform: 'detecting',
  serverReady: false,
  visits: 0,
  lastPong: 0,
  emoteIndex: 0,
  triggerCount: 0,
  cubeTaps: 0,
  ghostSpawned: false,
  playerName: ''
}

let ghost = engine.RootEntity
let emoteClock = 0
let pingClock = 0
let pingSeq = 0
let platformKnown = false

export function startClient() {
  room.onMessage('pong', (data) => {
    spike.serverReady = true
    spike.visits = data.visits
    spike.lastPong = data.serverTime
  })

  // Tap-on-3D-entity probe: the docs describe aim-then-press on mobile; this shows what a plain tap does.
  const cube = engine.addEntity()
  Transform.create(cube, { position: Vector3.create(4, 1, 8), scale: Vector3.create(1.5, 1.5, 1.5) })
  MeshRenderer.setBox(cube)
  MeshCollider.setBox(cube)
  pointerEventsSystem.onPointerDown(
    { entity: cube, opts: { button: InputAction.IA_POINTER, hoverText: 'Tap me' } },
    () => {
      spike.cubeTaps += 1
    }
  )

  engine.addSystem(spikeSystem)
}

function spikeSystem(dt: number) {
  if (!platformKnown) {
    const platform = getPlatform()
    if (platform !== null) {
      platformKnown = true
      spike.platform = platform
      if (platform === 'mobile') {
        // Joystick stays; every native gamepad button goes. All actions are UI buttons.
        TouchScreenControls.hideAll()
      }
    }
  }

  if (!spike.ghostSpawned) {
    const player = getPlayer()
    if (player && player.wearables.length > 0 && player.avatar) {
      spike.playerName = player.name
      ghost = engine.addEntity()
      Transform.create(ghost, {
        position: Vector3.create(8, 0, 10),
        rotation: Quaternion.fromEulerDegrees(0, 180, 0)
      })
      AvatarShape.create(ghost, {
        id: player.userId,
        name: player.name,
        bodyShape: player.avatar.bodyShapeUrn,
        skinColor: player.avatar.skinColor ?? Color3.create(0.6, 0.46, 0.36),
        hairColor: player.avatar.hairColor ?? Color3.create(0.28, 0.14, 0),
        eyeColor: player.avatar.eyesColor ?? Color3.create(0.6, 0.46, 0.36),
        wearables: [...player.wearables],
        emotes: [],
        expressionTriggerId: EMOTES[0],
        expressionTriggerTimestamp: 0
      })
      spike.ghostSpawned = true
      void room.send('hello', { name: player.name })
    }
  }

  if (spike.ghostSpawned) {
    emoteClock += dt
    if (emoteClock >= 2.5) {
      emoteClock = 0
      playNextEmote()
    }
  }

  pingClock += dt
  if (pingClock >= (spike.serverReady ? 10 : 2)) {
    pingClock = 0
    pingSeq += 1
    void room.send('ping', { seq: pingSeq })
  }
}

export function playNextEmote() {
  if (!spike.ghostSpawned) return
  spike.emoteIndex = (spike.emoteIndex + 1) % EMOTES.length
  spike.triggerCount += 1
  const shape = AvatarShape.getMutable(ghost)
  shape.expressionTriggerId = EMOTES[spike.emoteIndex]
  // Lamport counter: raise it by one per repetition or the engine ignores the instruction.
  shape.expressionTriggerTimestamp = spike.triggerCount
}
