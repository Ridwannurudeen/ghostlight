import { AvatarShape, engine } from '@dcl/sdk/ecs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGhostOfNight,
  clearPerformer,
  clearPreview,
  freezePerformer,
  getPerformerBeatIndex,
  hasPerformerCompletedSequence,
  playPerformerEmote,
  replayPerformer,
  replayPerformerBeat,
  resumePerformer,
  setAudience,
  showDuet,
  showGhostOfNight,
  showPerformer,
  showPreview
} from '../src/client/ghosts'
import { createFlowRuntime, type OutboundMessage } from '../src/client/flow'
import { showPolicyForTimestamp } from '../src/shared/show-policy'
import { FIXED_NOW, makeLook } from './test-helpers'

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
    },
    Schemas: {
      Map: (value: unknown) => value,
      Array: (value: unknown) => value,
      Optional: (value: unknown) => value,
      String: 'string',
      Boolean: 'boolean',
      Number: 'number',
      Int: 'int',
      Int64: 'int64'
    }
  }
})

vi.mock('@dcl/sdk/network', () => ({
  registerMessages: () => ({
    send: vi.fn(),
    onMessage: vi.fn(),
    onReady: vi.fn(),
    isReady: () => false
  })
}))

vi.mock('@dcl/sdk/src/players', () => ({
  getPlayer: () => null
}))

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

    expect(getPerformerBeatIndex()).toBe(0)
    system(2.5)
    expect(getPerformerBeatIndex()).toBe(1)

    freezePerformer()
    system(10)
    expect(getPerformerBeatIndex()).toBe(1)
    expect(AvatarShape.getMutable).toHaveBeenCalledTimes(mutationsBeforeFreeze + 1)

    playPerformerEmote('wave')
    expect(getPerformerBeatIndex()).toBe(1)
    expect(AvatarShape.getMutable).toHaveBeenCalledTimes(mutationsBeforeFreeze + 2)

    resumePerformer()
    system(2.5)
    expect(getPerformerBeatIndex()).toBe(2)

    replayPerformer()
    expect(getPerformerBeatIndex()).toBe(0)

    clearPerformer()
    expect(getPerformerBeatIndex()).toBeNull()
  })

  it('replays one selected solo beat for the existing 2.5-second cadence', () => {
    showPerformer(makeLook('0xPerformer'), ['wave', 'clap', 'dab'])
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]

    replayPerformerBeat(2)
    expect(getPerformerBeatIndex()).toBe(2)
    system(2.49)
    expect(getPerformerBeatIndex()).toBe(2)
    system(0.01)
    expect(getPerformerBeatIndex()).toBe(0)
    expect(engine.addEntity).toHaveBeenCalledTimes(8)
  })

  it('unlocks a solo clue only after beat three finishes and resets for the next performer', () => {
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]

    showPerformer(makeLook('0xFirst'), ['wave', 'clap', 'dab'])
    expect(hasPerformerCompletedSequence()).toBe(false)
    system(2.5)
    system(2.5)
    expect(hasPerformerCompletedSequence()).toBe(false)
    system(2.5)
    expect(hasPerformerCompletedSequence()).toBe(true)

    showPerformer(makeLook('0xNext'), ['shrug', 'kiss', 'headexplode'])
    expect(hasPerformerCompletedSequence()).toBe(false)
    clearPerformer()
    expect(hasPerformerCompletedSequence()).toBe(false)
  })

  it('unlocks a duet after the author sequence without waiting through the reply sequence', () => {
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]

    showDuet(
      { look: makeLook('0xAuthor'), emotes: ['wave', 'clap', 'dab'] },
      { look: makeLook('0xReply'), emotes: ['shrug', 'kiss', 'headexplode'] }
    )
    system(2.5)
    system(2.5)
    expect(hasPerformerCompletedSequence()).toBe(false)
    system(2.5)
    expect(hasPerformerCompletedSequence()).toBe(true)
  })

  it('reports author preview completion once after all three beats and cancels stale callbacks', () => {
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]
    const completed = vi.fn()

    showPreview(makeLook('0xAuthor'), ['wave', 'clap', 'dab'], completed)
    system(2.5)
    system(2.5)
    expect(completed).not.toHaveBeenCalled()
    system(2.5)
    system(7.5)
    expect(completed).toHaveBeenCalledTimes(1)

    const cancelled = vi.fn()
    showPreview(makeLook('0xAuthor'), ['shrug', 'kiss', 'headexplode'], cancelled)
    system(2.5)
    clearPreview()
    system(7.5)
    expect(cancelled).not.toHaveBeenCalled()

    const replaced = vi.fn()
    const replacement = vi.fn()
    showPreview(makeLook('0xAuthor'), ['wave', 'clap', 'dab'], replaced)
    showPreview(makeLook('0xAuthor'), ['shrug', 'kiss', 'headexplode'], replacement)
    system(2.5)
    system(2.5)
    system(2.5)
    expect(replaced).not.toHaveBeenCalled()
    expect(replacement).toHaveBeenCalledTimes(1)
  })

  it('connects the real ghost timer to the first-guess lock while preserving the retry exception', () => {
    const sent: OutboundMessage[] = []
    let requestSequence = 0
    const runtime = createFlowRuntime({
      send: (message) => sent.push(message),
      now: () => FIXED_NOW,
      createRequestId: () => `request-${++requestSequence}`,
      getProfile: () => ({ address: '0xPlayer', name: 'Player', isGuest: false }),
      canGuess: hasPerformerCompletedSequence,
      effects: { showPerformer }
    })
    const policy = showPolicyForTimestamp(FIXED_NOW)!
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    runtime.receive({
      type: 'showSchedule',
      data: { instanceId: 'server', serverTime: FIXED_NOW, showKey: policy.showKey }
    })
    expect(runtime.requestNextCharade()).toBe(true)
    const requestId = runtime.getState().pending.find((request) => request.kind === 'nextCharade')!.requestId
    runtime.receive({
      type: 'charade',
      data: {
        requestId,
        id: 'charade-1',
        authorName: 'Author',
        authorAddress: '0xAuthor',
        look: makeLook('0xAuthor', 'Author'),
        emotes: ['wave', 'clap', 'dab'],
        answers: ['One', 'Two', 'Three'],
        createdAt: FIXED_NOW,
        isHouse: false
      }
    })
    const system = vi.mocked(engine.addSystem).mock.calls[0][0]

    expect(runtime.guess(0)).toBe(false)
    system(2.5)
    system(2.5)
    expect(runtime.guess(0)).toBe(false)
    system(2.5)
    expect(runtime.guess(0)).toBe(true)
    expect(sent.at(-1)?.type).toBe('guess')

    const retryRuntime = createFlowRuntime({
      send: vi.fn(),
      now: () => FIXED_NOW,
      createRequestId: () => 'retry-request',
      getProfile: () => ({ address: '0xPlayer', name: 'Player', isGuest: false }),
      canGuess: hasPerformerCompletedSequence
    })
    retryRuntime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    retryRuntime.receive({
      type: 'showSchedule',
      data: { instanceId: 'server', serverTime: FIXED_NOW, showKey: policy.showKey }
    })
    expect(retryRuntime.requestNextCharade()).toBe(true)
    const retryCharadeRequest = retryRuntime.getState().pending[0].requestId
    retryRuntime.receive({
      type: 'charade',
      data: {
        requestId: retryCharadeRequest,
        id: 'retry-charade',
        authorName: 'Author',
        authorAddress: '0xAuthor',
        look: makeLook('0xAuthor', 'Author'),
        emotes: ['wave', 'clap', 'dab'],
        answers: ['One', 'Two', 'Three'],
        createdAt: FIXED_NOW,
        isHouse: false
      }
    })
    showPerformer(makeLook('0xAuthor'), ['wave', 'clap', 'dab'])
    retryRuntime.dispatch({
      type: 'retry',
      retry: { charadeId: 'retry-charade', removedAnswerIndex: 1, replayBeatIndex: 2, spotlight: false }
    })
    expect(hasPerformerCompletedSequence()).toBe(false)
    expect(retryRuntime.guess(0)).toBe(true)
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
    expect(getPerformerBeatIndex()).toBe(0)
    system(2.5)
    expect(getPerformerBeatIndex()).toBe(1)
    system(2.5)
    expect(getPerformerBeatIndex()).toBe(2)
    system(2.5)
    expect(getPerformerBeatIndex()).toBe(0)
    system(2.5)
    expect(getPerformerBeatIndex()).toBe(1)

    freezePerformer()
    const mutationsBeforePause = vi.mocked(AvatarShape.getMutable).mock.calls.length
    system(10)
    expect(getPerformerBeatIndex()).toBe(1)
    expect(AvatarShape.getMutable).toHaveBeenCalledTimes(mutationsBeforePause)

    resumePerformer()
    replayPerformer()
    expect(getPerformerBeatIndex()).toBe(0)
    system(2.5)
    expect(
      vi
        .mocked(AvatarShape.getMutable)
        .mock.calls.slice(-2)
        .map(([entity]) => entity)
    ).toEqual([1, 1])

    clearPerformer()
    expect(getPerformerBeatIndex()).toBeNull()
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

    showGhostOfNight(makeLook('crowd-pleaser', 'Crowd Pleaser'))
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
