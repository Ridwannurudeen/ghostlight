import { AudioSource, engine, type Entity } from '@dcl/sdk/ecs'
import { DEFAULT_CLIENT_SETTINGS, getClientSettings, subscribeClientSettings, type ClientSettings } from './settings'

export const SOUND_CLIPS = {
  roomTone: 'assets/sounds/room_tone.mp3',
  tick: 'assets/sounds/tick.mp3',
  drumroll: 'assets/sounds/drumroll.mp3',
  sting: 'assets/sounds/sting.mp3',
  hit: 'assets/sounds/hit.mp3',
  miss: 'assets/sounds/miss.mp3',
  applause: 'assets/sounds/applause.mp3',
  gasp: 'assets/sounds/gasp.mp3',
  laugh: 'assets/sounds/laugh.mp3',
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

export type SoundSettings = Pick<ClientSettings, 'soundEnabled' | 'soundVolume'>

const ROOM_TONE_VOLUME = 0.28
const DUCKED_ROOM_TONE_VOLUME = 0.07

const SOUND_NAMES = Object.keys(SOUND_CLIPS) as SoundName[]

export function createSoundController<TEntity>(
  port: SoundPort<TEntity>,
  initialSettings: SoundSettings = DEFAULT_CLIENT_SETTINGS
) {
  const entities = new Map<SoundName, TEntity>()
  let settings = initialSettings
  let roomToneRequested = false
  let revealDucked = false

  function volumeFor(name: SoundName) {
    const baseVolume = name === 'roomTone' ? (revealDucked ? DUCKED_ROOM_TONE_VOLUME : ROOM_TONE_VOLUME) : 1
    return baseVolume * settings.soundVolume
  }

  function applyVolumes() {
    for (const [name, entity] of entities) {
      port.getMutableSource(entity).volume = volumeFor(name)
    }
  }

  function initialize() {
    if (entities.size > 0) return

    for (const name of SOUND_NAMES) {
      const entity = port.createEntity()
      port.createSource(entity, {
        audioClipUrl: SOUND_CLIPS[name],
        playing: false,
        loop: name === 'roomTone',
        volume: volumeFor(name),
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
      if (!settings.soundEnabled) return
      port.getMutableSource(getEntity(name)).volume = volumeFor(name)
      port.playSource(getEntity(name), SOUND_CLIPS[name])
    },
    startRoomTone() {
      roomToneRequested = true
      if (!settings.soundEnabled) return
      const roomTone = port.getMutableSource(getEntity('roomTone'))
      if (roomTone.playing) return
      roomTone.currentTime = 0
      roomTone.playing = true
    },
    duckForReveal() {
      if (revealDucked) return
      revealDucked = true
      port.getMutableSource(getEntity('roomTone')).volume = volumeFor('roomTone')
    },
    restoreAfterReveal() {
      if (!revealDucked) return
      revealDucked = false
      port.getMutableSource(getEntity('roomTone')).volume = volumeFor('roomTone')
    },
    setSettings(nextSettings: SoundSettings) {
      settings = nextSettings
      if (entities.size === 0) return
      applyVolumes()

      if (!settings.soundEnabled) {
        for (const entity of entities.values()) {
          const source = port.getMutableSource(entity)
          source.playing = false
          source.currentTime = 0
        }
        return
      }

      if (roomToneRequested) {
        const roomTone = port.getMutableSource(getEntity('roomTone'))
        if (!roomTone.playing) {
          roomTone.currentTime = 0
          roomTone.playing = true
        }
      }
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
  if (soundController !== null) return soundController
  const settings = getClientSettings()
  soundController = createSoundController(ecsSoundPort, settings)
  subscribeClientSettings((nextSettings) => soundController?.setSettings(nextSettings))
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
