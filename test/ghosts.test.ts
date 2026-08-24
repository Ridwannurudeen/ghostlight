import { AvatarShape, engine } from '@dcl/sdk/ecs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGhostOfNight,
  clearPerformer,
  clearPreview,
  freezePerformer,
  playPerformerEmote,
  replayPerformer,
  resumePerformer,
  setAudience,
  showDuet,
  showGhostOfNight,
  showPerformer
} from '../src/client/ghosts'
import { makeLook } from './test-helpers'

vi.mock('@dcl/sdk/ecs', () => {
  let nextEntity = 0
  return {
    AvatarShape: {
      createOrReplace: vi.fn(),
      deleteFrom: vi.fn(),
      getMutable: vi.fn(() => ({}))
    },
    Transform: { create: vi.fn(), createOrReplace: vi.fn() },
    engine: {
      addEntity: vi.fn(() => ++nextEntity),
      addSystem: vi.fn()
    }
  }
})

vi.mock('@dcl/sdk/math', () => ({
  Quaternion: {
    fromEulerDegrees: vi.fn(() => ({})),
    Identity: vi.fn(() => ({}))
  }
}))

vi.mock('../src/client/theater', () => ({
  AUDIENCE_POSITIONS: Array.from({ length: 6 }, () => ({})),
  STAGE_PERFORMER_POSITION: {},
  STAGE_PREVIEW_POSITION: {},
  GHOST_OF_NIGHT_POSITION: { pedestal: true }
}))

describe('audience ghosts', () => {
  beforeEach(() => {
    clearPerformer()
    clearPreview()
    clearGhostOfNight()
    setAudience([])
    vi.mocked(AvatarShape.createOrReplace).mockClear()
    vi.mocked(AvatarShape.deleteFrom).mockClear()
    vi.mocked(AvatarShape.getMutable).mockClear()
  })

  it('keeps seated addresses while merged audience chunks arrive', () => {
    const alice = makeLook('0xAlice')
    const bob = makeLook('0xBob')
    const carol = makeLook('0xCarol')
    const dan = makeLook('0xDan')

    setAudience([alice, bob])
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]
    system(1 / 3)
    system(1 / 3)

    expect(AvatarShape.createOrReplace).toHaveBeenCalledTimes(2)

    setAudience([alice, bob, carol, dan])
    system(1 / 3)
    system(1 / 3)

    expect(AvatarShape.createOrReplace).toHaveBeenCalledTimes(4)
    expect(AvatarShape.deleteFrom).not.toHaveBeenCalled()

    setAudience([bob, carol, dan])

    expect(AvatarShape.createOrReplace).toHaveBeenCalledTimes(4)
    expect(AvatarShape.deleteFrom).toHaveBeenCalledTimes(1)
  })

  it('holds the current performer emote until the reveal bow and reset', () => {
    showPerformer(makeLook('0xPerformer'), ['wave', 'clap', 'dab'])
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]
    const mutationsBeforeFreeze = vi.mocked(AvatarShape.getMutable).mock.calls.length

    freezePerformer()
    system(10)
    expect(AvatarShape.getMutable).toHaveBeenCalledTimes(mutationsBeforeFreeze)

    playPerformerEmote('wave')
    expect(AvatarShape.getMutable).toHaveBeenCalledTimes(mutationsBeforeFreeze + 1)

    resumePerformer()
    system(10)
    expect(AvatarShape.getMutable).toHaveBeenCalledTimes(mutationsBeforeFreeze + 2)
  })

  it('alternates complete author and reply sequences in the existing performer and preview slots', () => {
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]
    vi.mocked(AvatarShape.getMutable).mockClear()

    showDuet(
      { look: makeLook('0xAuthor'), emotes: ['wave', 'clap', 'dab'] },
      { look: makeLook('0xReply'), emotes: ['shrug', 'kiss', 'headexplode'] }
    )
    for (let index = 0; index < 6; index += 1) system(2.5)

    expect(vi.mocked(AvatarShape.getMutable).mock.calls.map(([entity]) => entity)).toEqual([1, 1, 1, 8, 8, 8, 1])
    expect(engine.addEntity).toHaveBeenCalledTimes(8)
  })

  it('pauses duet playback for reveal and replays from the author', () => {
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]
    vi.mocked(AvatarShape.getMutable).mockClear()
    showDuet(
      { look: makeLook('0xAuthor'), emotes: ['wave', 'clap', 'dab'] },
      { look: makeLook('0xReply'), emotes: ['shrug', 'kiss', 'headexplode'] }
    )
    system(2.5)

    freezePerformer()
    const mutationsBeforePause = vi.mocked(AvatarShape.getMutable).mock.calls.length
    system(10)
    expect(AvatarShape.getMutable).toHaveBeenCalledTimes(mutationsBeforePause)

    resumePerformer()
    replayPerformer()
    system(2.5)
    expect(
      vi
        .mocked(AvatarShape.getMutable)
        .mock.calls.slice(-2)
        .map(([entity]) => entity)
    ).toEqual([1, 1])
  })

  it('reserves one audience avatar slot while a two-performer duet is active', () => {
    const audience = Array.from({ length: 6 }, (_, index) => makeLook(`audience-${index}`))
    setAudience(audience)
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]
    for (let index = 0; index < 6; index += 1) system(1 / 3)
    vi.mocked(AvatarShape.deleteFrom).mockClear()

    showDuet(
      { look: makeLook('0xAuthor'), emotes: ['wave', 'clap', 'dab'] },
      { look: makeLook('0xReply'), emotes: ['shrug', 'kiss', 'headexplode'] }
    )

    expect(AvatarShape.deleteFrom).toHaveBeenCalledTimes(1)
  })

  it('does not tear down an active duet when author-preview cleanup has nothing to clear', () => {
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]
    showDuet(
      { look: makeLook('0xAuthor'), emotes: ['wave', 'clap', 'dab'] },
      { look: makeLook('0xReply'), emotes: ['shrug', 'kiss', 'headexplode'] }
    )
    vi.mocked(AvatarShape.deleteFrom).mockClear()
    vi.mocked(AvatarShape.getMutable).mockClear()

    clearPreview()
    for (let index = 0; index < 3; index += 1) system(2.5)

    expect(AvatarShape.deleteFrom).not.toHaveBeenCalled()
    expect(vi.mocked(AvatarShape.getMutable).mock.calls.map(([entity]) => entity)).toContain(8)
  })

  it('cancels duet playback and hides the stale reply on performer clear paths', () => {
    showDuet(
      { look: makeLook('0xAuthor'), emotes: ['wave', 'clap', 'dab'] },
      { look: makeLook('0xReply'), emotes: ['shrug', 'kiss', 'headexplode'] }
    )
    vi.mocked(AvatarShape.deleteFrom).mockClear()

    showPerformer(makeLook('0xNext'), ['dance', 'wave', 'clap'])
    expect(AvatarShape.deleteFrom).toHaveBeenCalledWith(8)

    showDuet(
      { look: makeLook('0xAuthor'), emotes: ['wave', 'clap', 'dab'] },
      { look: makeLook('0xReply'), emotes: ['shrug', 'kiss', 'headexplode'] }
    )
    vi.mocked(AvatarShape.deleteFrom).mockClear()
    clearPerformer()
    expect(vi.mocked(AvatarShape.deleteFrom).mock.calls.map(([entity]) => entity)).toEqual([8, 1])
  })

  it('reuses one of the eight ghost slots for Ghost of the Night and restores the audience seat', () => {
    const audience = Array.from({ length: 6 }, (_, index) => makeLook(`audience-${index}`))
    setAudience(audience)
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]
    for (let index = 0; index < 6; index += 1) system(1 / 3)
    const entityCount = vi.mocked(engine.addEntity).mock.calls.length

    showGhostOfNight(makeLook('hardest', 'Hardest'))
    clearGhostOfNight()
    system(1 / 3)

    expect(entityCount).toBe(8)
    expect(engine.addEntity).toHaveBeenCalledTimes(8)
  })

  it('bounds and validates local avatar data before writing AvatarShape', () => {
    const validWearable = `urn:decentraland:matic:collections-v2:${'a'.repeat(64)}:0`
    const look = {
      ...makeLook('0xPlayer', ' HOUSE\u202e GHOST\u202c '),
      bodyShape: 'not-a-urn',
      skinColor: { r: Number.POSITIVE_INFINITY, g: -1, b: 2 },
      wearables: ['x'.repeat(200_000), ...Array.from({ length: 1_000 }, () => validWearable)]
    }

    showPerformer(look, ['wave', 'clap', 'dab'])

    const avatar = vi.mocked(AvatarShape.createOrReplace).mock.calls.at(-1)?.[1]
    expect(avatar).toMatchObject({
      id: '0xPlayer',
      name: 'PLAYER',
      bodyShape: 'urn:decentraland:off-chain:base-avatars:BaseMale',
      skinColor: { r: 0.6, g: 0.46, b: 0.36 }
    })
    expect(avatar?.wearables.length).toBeLessThanOrEqual(20)
    expect(avatar?.wearables.every((wearable) => wearable === validWearable)).toBe(true)
    expect(JSON.stringify(avatar).length).toBeLessThan(2_800)
  })
})
