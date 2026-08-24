import { AvatarAnchorPointType } from '@dcl/sdk/ecs'
import { describe, expect, it } from 'vitest'
import { REWARD_PROPS } from '../src/shared/config'
import {
  MAX_REWARD_CANDIDATES,
  MAX_VISIBLE_REWARD_PROPS,
  createRewardController,
  type RewardPort
} from '../src/client/rewards'

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
  const distances = new Map<string, number>()

  const port: RewardPort<number> = {
    createEntity: () => ++nextEntity,
    attach: (entity, avatarId, anchorPointId) => attachments.set(entity, { avatarId, anchorPointId }),
    setTransform: (entity, parent, position, scale) => transforms.set(entity, { parent, position, scale }),
    setModel: (entity, src) => models.set(entity, src),
    clearModel: (entity) => {
      models.delete(entity)
    },
    distanceToPlayer: (address) => distances.get(address.toLowerCase()) ?? 0
  }

  return {
    controller: createRewardController(port),
    attachments,
    transforms,
    models,
    distances,
    entityCount: () => nextEntity
  }
}

function wallet(index: number) {
  return `0x${index.toString(16).padStart(40, '0')}`
}

describe('title reward props', () => {
  it('attaches the Understudy hat to an explicit avatar through a transformed child', () => {
    const { controller, attachments, transforms, models, entityCount } = createRewardHarness()

    const address = wallet(1)
    controller.set(address, 'Understudy')

    expect(entityCount()).toBe(2)
    expect(attachments.get(1)).toEqual({
      avatarId: address,
      anchorPointId: AvatarAnchorPointType.AAPT_HEAD
    })
    expect(transforms.get(2)).toMatchObject({ parent: 1 })
    expect(transforms.get(2)?.scale.x).toBeGreaterThan(0)
    expect(models.get(2)).toBe(REWARD_PROPS.Understudy)
  })

  it('reuses the same entities while updating head and hand rewards', () => {
    const { controller, attachments, transforms, models, entityCount } = createRewardHarness()

    const address = wallet(1)
    controller.set(address, 'Understudy')
    controller.set(address, 'Scene Stealer')

    expect(entityCount()).toBe(2)
    expect(attachments.get(1)).toEqual({
      avatarId: address,
      anchorPointId: AvatarAnchorPointType.AAPT_HEAD
    })
    expect(transforms.get(2)?.parent).toBe(1)
    expect(models.get(2)).toBe(REWARD_PROPS['Scene Stealer'])

    controller.set(address, 'Ghostlight Legend')

    expect(entityCount()).toBe(2)
    expect(attachments.get(1)).toEqual({
      avatarId: address,
      anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND
    })
    expect(transforms.get(2)?.parent).toBe(1)
    expect(models.get(2)).toBe(REWARD_PROPS['Ghostlight Legend'])
  })

  it('does not leak entities across clears, restores, or repeated title updates', () => {
    const { controller, models, entityCount } = createRewardHarness()

    const address = wallet(1)
    controller.set(address, '')
    expect(entityCount()).toBe(0)

    controller.set(address, 'Understudy')
    for (let index = 0; index < 20; index += 1) {
      controller.set(address.toUpperCase(), index % 2 === 0 ? 'Scene Stealer' : 'Ghostlight Legend')
    }
    controller.set(address, '')

    expect(entityCount()).toBe(2)
    expect(models.size).toBe(0)

    controller.set(address, 'Understudy')
    expect(entityCount()).toBe(2)
    expect(models.get(2)).toBe(REWARD_PROPS.Understudy)

    controller.remove(address.toUpperCase())
    expect(models.size).toBe(0)
    controller.set(address, 'Understudy')
    expect(entityCount()).toBe(2)
  })

  it('reuses one bounded prop slot across asynchronous stage authors', () => {
    const { controller, attachments, models, entityCount } = createRewardHarness()

    controller.setStage('0xAuthor-1', 'Understudy')
    for (let index = 2; index <= 20; index += 1) {
      controller.setStage(`0xAuthor-${index}`, index % 2 === 0 ? 'Scene Stealer' : 'Ghostlight Legend')
    }

    expect(entityCount()).toBe(2)
    expect(attachments.get(1)?.avatarId).toBe('0xAuthor-20')
    expect(models.get(2)).toBe(REWARD_PROPS['Scene Stealer'])

    const author = wallet(20)
    controller.setStage(author, 'Scene Stealer')
    controller.set(author, 'Scene Stealer')
    expect(entityCount()).toBe(4)
    expect(models.size).toBe(1)

    controller.remove(author)
    expect(models.get(2)).toBe(REWARD_PROPS['Scene Stealer'])

    controller.clearStage()
    expect(models.has(2)).toBe(false)
  })

  it('caps live rewards and replaces the farthest player when a nearer title appears', () => {
    const { controller, attachments, distances, entityCount } = createRewardHarness()
    for (let index = 0; index < MAX_VISIBLE_REWARD_PROPS; index += 1) {
      const address = wallet(index + 1)
      distances.set(address, index + 1)
      controller.set(address, 'Understudy')
    }
    const nearest = wallet(MAX_VISIBLE_REWARD_PROPS + 1)
    distances.set(nearest, 0)
    controller.set(nearest, 'Scene Stealer')

    const visibleAddresses = [...attachments.values()].map(({ avatarId }) => avatarId)
    expect(entityCount()).toBe(MAX_VISIBLE_REWARD_PROPS * 2)
    expect(visibleAddresses).toContain(nearest)
    expect(visibleAddresses).not.toContain(wallet(MAX_VISIBLE_REWARD_PROPS))
  })

  it('ignores guest title churn and bounds stable title candidates', () => {
    const { controller, attachments, distances, entityCount } = createRewardHarness()

    for (let index = 0; index < 1_000; index += 1) controller.set(`guest-${index}`, 'Understudy')
    expect(entityCount()).toBe(0)

    for (let index = 1; index <= MAX_REWARD_CANDIDATES + 10; index += 1) {
      const address = wallet(index)
      distances.set(address, index)
      controller.set(address, 'Understudy')
    }

    expect(entityCount()).toBe(MAX_VISIBLE_REWARD_PROPS * 2)
    expect([...attachments.values()].map(({ avatarId }) => avatarId)).not.toContain(wallet(1))
  })
})
