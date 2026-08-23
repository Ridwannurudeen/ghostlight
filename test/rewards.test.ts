import { AvatarAnchorPointType } from '@dcl/sdk/ecs'
import { describe, expect, it } from 'vitest'
import { REWARD_PROPS } from '../src/shared/config'
import { createRewardController, type RewardPort } from '../src/client/rewards'

type TransformRecord = {
  parent: number
  position: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
}

function createRewardHarness() {
  let nextEntity = 0
  const attachments = new Map<number, { avatarId: string; anchorPointId: AvatarAnchorPointType }>()
  const transforms = new Map<number, TransformRecord>()
  const models = new Map<number, string>()
  const removed: number[] = []

  const port: RewardPort<number> = {
    createEntity: () => ++nextEntity,
    attach: (entity, avatarId, anchorPointId) => attachments.set(entity, { avatarId, anchorPointId }),
    setTransform: (entity, parent, position, scale) => transforms.set(entity, { parent, position, scale }),
    setModel: (entity, src) => models.set(entity, src),
    clearModel: (entity) => {
      models.delete(entity)
    },
    removeEntityTree: (entity) => removed.push(entity)
  }

  return {
    controller: createRewardController(port),
    attachments,
    transforms,
    models,
    removed,
    entityCount: () => nextEntity
  }
}

describe('title reward props', () => {
  it('attaches the Understudy hat to an explicit avatar through a transformed child', () => {
    const { controller, attachments, transforms, models, entityCount } = createRewardHarness()

    controller.set('0xAlice', 'Understudy')

    expect(entityCount()).toBe(2)
    expect(attachments.get(1)).toEqual({
      avatarId: '0xAlice',
      anchorPointId: AvatarAnchorPointType.AAPT_HEAD
    })
    expect(transforms.get(2)).toMatchObject({ parent: 1 })
    expect(transforms.get(2)?.scale.x).toBeGreaterThan(0)
    expect(models.get(2)).toBe(REWARD_PROPS.Understudy)
  })

  it('reuses the same entities while updating head and hand rewards', () => {
    const { controller, attachments, transforms, models, entityCount } = createRewardHarness()

    controller.set('0xAlice', 'Understudy')
    controller.set('0xAlice', 'Scene Stealer')

    expect(entityCount()).toBe(2)
    expect(attachments.get(1)).toEqual({
      avatarId: '0xAlice',
      anchorPointId: AvatarAnchorPointType.AAPT_HEAD
    })
    expect(transforms.get(2)?.parent).toBe(1)
    expect(models.get(2)).toBe(REWARD_PROPS['Scene Stealer'])

    controller.set('0xAlice', 'Ghostlight Legend')

    expect(entityCount()).toBe(2)
    expect(attachments.get(1)).toEqual({
      avatarId: '0xAlice',
      anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND
    })
    expect(transforms.get(2)?.parent).toBe(1)
    expect(models.get(2)).toBe(REWARD_PROPS['Ghostlight Legend'])
  })

  it('does not leak entities across clears, restores, or repeated title updates', () => {
    const { controller, models, removed, entityCount } = createRewardHarness()

    controller.set('0xAlice', '')
    expect(entityCount()).toBe(0)

    controller.set('0xAlice', 'Understudy')
    for (let index = 0; index < 20; index += 1) {
      controller.set('0xALICE', index % 2 === 0 ? 'Scene Stealer' : 'Ghostlight Legend')
    }
    controller.set('0xAlice', '')

    expect(entityCount()).toBe(2)
    expect(models.size).toBe(0)

    controller.set('0xAlice', 'Understudy')
    expect(entityCount()).toBe(2)
    expect(models.get(2)).toBe(REWARD_PROPS.Understudy)

    controller.remove('0xALICE')
    expect(removed).toEqual([1])
    controller.set('0xAlice', 'Understudy')
    expect(entityCount()).toBe(4)
  })
})
