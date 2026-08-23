import { AvatarAnchorPointType, AvatarAttach, GltfContainer, Transform, engine, type Entity } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/src/players'
import { REWARD_PROPS, type PlayerTitle } from '../shared/config'

export const MAX_VISIBLE_REWARD_PROPS = 16

type RewardTitle = Exclude<PlayerTitle, ''>

type Vector3 = {
  x: number
  y: number
  z: number
}

export type RewardPort<TEntity> = {
  createEntity(): TEntity
  attach(entity: TEntity, avatarId: string, anchorPointId: AvatarAnchorPointType): void
  setTransform(entity: TEntity, parent: TEntity, position: Vector3, scale: Vector3): void
  setModel(entity: TEntity, src: string): void
  clearModel(entity: TEntity): void
  distanceToPlayer(address: string): number | null
}

type RewardSpec = {
  anchorPointId: AvatarAnchorPointType
  position: Vector3
  scale: Vector3
}

type RewardEntities<TEntity> = {
  anchor: TEntity
  prop: TEntity
}

type RewardSlot<TEntity> = RewardEntities<TEntity> & {
  address: string
}

const REWARD_SPECS: Record<RewardTitle, RewardSpec> = {
  Understudy: {
    anchorPointId: AvatarAnchorPointType.AAPT_HEAD,
    position: { x: 0, y: 0.2, z: 0 },
    scale: { x: 0.42, y: 0.42, z: 0.42 }
  },
  'Scene Stealer': {
    anchorPointId: AvatarAnchorPointType.AAPT_HEAD,
    position: { x: 0, y: -0.28, z: -0.2 },
    scale: { x: 0.34, y: 0.34, z: 0.34 }
  },
  'Ghostlight Legend': {
    anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND,
    position: { x: 0, y: -0.08, z: 0 },
    scale: { x: 0.24, y: 0.24, z: 0.24 }
  }
}

export function createRewardController<TEntity>(port: RewardPort<TEntity>) {
  const candidates = new Map<string, { address: string; title: RewardTitle }>()
  const rewardSlots: RewardSlot<TEntity>[] = []
  let stageReward: RewardEntities<TEntity> | null = null
  let stageAddress = ''
  let stageTitle: PlayerTitle = ''

  function applyReward(entities: RewardEntities<TEntity>, address: string, title: RewardTitle) {
    const spec = REWARD_SPECS[title]
    port.attach(entities.anchor, address, spec.anchorPointId)
    port.setTransform(entities.prop, entities.anchor, spec.position, spec.scale)
    port.setModel(entities.prop, REWARD_PROPS[title])
  }

  function renderStageReward() {
    if (stageTitle === '' || rewardSlots.some((slot) => slot.address === stageAddress.toLowerCase())) {
      if (stageReward !== null) port.clearModel(stageReward.prop)
      return
    }

    stageReward ??= {
      anchor: port.createEntity(),
      prop: port.createEntity()
    }
    applyReward(stageReward, stageAddress, stageTitle)
  }

  function sync() {
    const selected = [...candidates.entries()]
      .map(([key, reward]) => ({ key, reward, distance: port.distanceToPlayer(reward.address) }))
      .filter((entry): entry is typeof entry & { distance: number } => entry.distance !== null)
      .sort((left, right) => left.distance - right.distance || left.key.localeCompare(right.key))
      .slice(0, MAX_VISIBLE_REWARD_PROPS)
    const selectedKeys = new Set(selected.map(({ key }) => key))

    for (const slot of rewardSlots) {
      if (slot.address && !selectedKeys.has(slot.address)) {
        port.clearModel(slot.prop)
        slot.address = ''
      }
    }

    for (const { key, reward } of selected) {
      let slot = rewardSlots.find((candidate) => candidate.address === key)
      if (!slot) {
        slot = rewardSlots.find((candidate) => candidate.address === '')
        if (!slot && rewardSlots.length < MAX_VISIBLE_REWARD_PROPS) {
          slot = { anchor: port.createEntity(), prop: port.createEntity(), address: '' }
          rewardSlots.push(slot)
        }
      }
      if (!slot) continue
      slot.address = key
      applyReward(slot, reward.address, reward.title)
    }
    renderStageReward()
  }

  return {
    set(address: string, title: PlayerTitle) {
      const key = address.toLowerCase()
      if (title === '') {
        candidates.delete(key)
        sync()
        return
      }
      candidates.set(key, { address, title })
      sync()
    },
    setStage(address: string, title: PlayerTitle) {
      stageAddress = address
      stageTitle = title
      renderStageReward()
    },
    clearStage() {
      stageAddress = ''
      stageTitle = ''
      if (stageReward !== null) port.clearModel(stageReward.prop)
    },
    remove(address: string) {
      const key = address.toLowerCase()
      candidates.delete(key)
      sync()
    },
    refresh: sync
  }
}

const ecsRewardPort: RewardPort<Entity> = {
  createEntity: () => engine.addEntity(),
  attach: (entity, avatarId, anchorPointId) => AvatarAttach.createOrReplace(entity, { avatarId, anchorPointId }),
  setTransform: (entity, parent, position, scale) => Transform.createOrReplace(entity, { parent, position, scale }),
  setModel: (entity, src) => GltfContainer.createOrReplace(entity, { src }),
  clearModel: (entity) => {
    GltfContainer.deleteFrom(entity)
  },
  distanceToPlayer: (address) => {
    const localPosition = getPlayer()?.position
    const remotePosition = getPlayer({ userId: address })?.position
    if (!localPosition || !remotePosition) return null
    const x = remotePosition.x - localPosition.x
    const y = remotePosition.y - localPosition.y
    const z = remotePosition.z - localPosition.z
    return x * x + y * y + z * z
  }
}

const rewardController = createRewardController(ecsRewardPort)

export function setRewardProp(address: string, title: PlayerTitle) {
  rewardController.set(address, title)
}

export function removeRewardProp(address: string) {
  rewardController.remove(address)
}

export function setStageRewardProp(address: string, title: PlayerTitle) {
  rewardController.setStage(address, title)
}

export function clearStageRewardProp() {
  rewardController.clearStage()
}

export function refreshRewardProps() {
  rewardController.refresh()
}
