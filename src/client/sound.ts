import { AudioSource, engine, type Entity } from '@dcl/sdk/ecs'

export const SOUND_CLIPS = {
  roomTone: 'assets/sounds/room_tone.mp3',
  tick: 'assets/sounds/tick.mp3',
  drumroll: 'assets/sounds/drumroll.mp3',
  sting: 'assets/sounds/sting.mp3',
  hit: 'assets/sounds/hit.mp3',
  miss: 'assets/sounds/miss.mp3',
  applause: 'assets/sounds/applause.mp3',
  gasp: 'assets/sounds/gasp.mp3',
  unlock: 'assets/sounds/unlock.mp3',
  curtain: 'assets/sounds/curtain.mp3',
  stamp: 'assets/sounds/stamp.mp3'
} as const

export type SoundName = keyof typeof SOUND_CLIPS

export type SoundSource = {
  audioClipUrl: string
  playing: boolean
  loop: boolean
  volume: number
  global: boolean
  currentTime?: number
}

export type SoundPort<TEntity> = {
  createEntity(): TEntity
  createSource(entity: TEntity, source: SoundSource): void
  playSource(entity: TEntity, source: string): void
  getMutableSource(entity: TEntity): SoundSource
}

const ROOM_TONE_VOLUME = 0.28
const DUCKED_ROOM_TONE_VOLUME = 0.07

const SOUND_NAMES = Object.keys(SOUND_CLIPS) as SoundName[]

export function createSoundController<TEntity>(port: SoundPort<TEntity>) {
  const entities = new Map<SoundName, TEntity>()
  let roomToneStarted = false
  let revealDucked = false

  function initialize() {
    if (entities.size > 0) return

    for (const name of SOUND_NAMES) {
      const entity = port.createEntity()
      port.createSource(entity, {
        audioClipUrl: SOUND_CLIPS[name],
        playing: false,
        loop: name === 'roomTone',
        volume: name === 'roomTone' ? ROOM_TONE_VOLUME : 1,
        global: true
      })
      entities.set(name, entity)
    }
  }

  function getEntity(name: SoundName) {
    initialize()
    return entities.get(name)!
  }

  return {
    initialize,
    play(name: SoundName) {
      port.playSource(getEntity(name), SOUND_CLIPS[name])
    },
    startRoomTone() {
      if (roomToneStarted) return
      const roomTone = port.getMutableSource(getEntity('roomTone'))
      roomTone.currentTime = 0
      roomTone.playing = true
      roomToneStarted = true
    },
    duckForReveal() {
      if (revealDucked) return
      port.getMutableSource(getEntity('roomTone')).volume = DUCKED_ROOM_TONE_VOLUME
      revealDucked = true
    },
    restoreAfterReveal() {
      if (!revealDucked) return
      port.getMutableSource(getEntity('roomTone')).volume = ROOM_TONE_VOLUME
      revealDucked = false
    }
  }
}

const ecsSoundPort: SoundPort<Entity> = {
  createEntity: () => engine.addEntity(),
  createSource: (entity, source) => AudioSource.create(entity, source),
  playSource: (entity, source) => {
    AudioSource.playSound(entity, source, true)
  },
  getMutableSource: (entity) => AudioSource.getMutable(entity) as SoundSource
}

let soundController: ReturnType<typeof createSoundController<Entity>> | null = null

function getSoundController() {
  soundController ??= createSoundController(ecsSoundPort)
  return soundController
}

export function initializeSounds() {
  getSoundController().initialize()
}

export function play(name: SoundName) {
  getSoundController().play(name)
}

export function startRoomTone() {
  getSoundController().startRoomTone()
}

export function duckForReveal() {
  getSoundController().duckForReveal()
}

export function restoreAfterReveal() {
  getSoundController().restoreAfterReveal()
}
