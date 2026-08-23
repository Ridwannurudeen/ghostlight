import { AvatarAnchorPointType, AvatarAttach, GltfContainer, Transform, engine, type Entity } from '@dcl/sdk/ecs'
import { REWARD_PROPS, type PlayerTitle } from '../shared/config'

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
  removeEntityTree(entity: TEntity): void
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
  const rewards = new Map<string, RewardEntities<TEntity>>()
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
    if (stageTitle === '' || rewards.has(stageAddress.toLowerCase())) {
      if (stageReward !== null) port.clearModel(stageReward.prop)
      return
    }

    stageReward ??= {
      anchor: port.createEntity(),
      prop: port.createEntity()
    }
    applyReward(stageReward, stageAddress, stageTitle)
  }

  return {
    set(address: string, title: PlayerTitle) {
      const key = address.toLowerCase()
      const existing = rewards.get(key)

      if (title === '') {
        if (existing !== undefined) port.clearModel(existing.prop)
        return
      }

      const entities = existing ?? {
        anchor: port.createEntity(),
        prop: port.createEntity()
      }
      if (existing === undefined) rewards.set(key, entities)

      applyReward(entities, address, title)
      if (key === stageAddress.toLowerCase()) renderStageReward()
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
      const existing = rewards.get(key)
      if (existing === undefined) return
      port.removeEntityTree(existing.anchor)
      rewards.delete(key)
      if (key === stageAddress.toLowerCase()) renderStageReward()
    }
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
  removeEntityTree: (entity) => engine.removeEntityWithChildren(entity)
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
