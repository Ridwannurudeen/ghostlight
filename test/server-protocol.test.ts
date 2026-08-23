import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '../src/shared/config'
import { DECK } from '../src/shared/deck'
import { createServerProtocol, type ProtocolSend, type ServerProtocolOptions } from '../src/server/server'
import { GhostCharadesState } from '../src/server/state'
import { createStorageRepository } from '../src/server/storage'
import { FIXED_NOW, FakeStorage, deferred, makeCharade, makeLook } from './test-helpers'

vi.mock('@dcl/sdk/server', () => ({
  Storage: {
    get: async () => null,
    set: async () => true,
    player: {
      get: async () => null,
      set: async () => true
    }
  }
}))

vi.mock('@dcl/sdk/ecs', () => ({
  AvatarBase: {},
  AvatarEquippedData: {},
  PlayerIdentityData: {},
  engine: { getEntitiesWith: () => [] },
  Schemas: {
    Map: (value: unknown) => value,
    Array: (value: unknown) => value,
    String: 'string',
    Boolean: 'boolean',
    Number: 'number',
    Int: 'int',
    Int64: 'int64'
  }
}))

vi.mock('@dcl/sdk/network', () => ({
  registerMessages: () => ({
    send: vi.fn(),
    onMessage: vi.fn(),
    onReady: vi.fn(),
    isReady: () => true
  })
}))

vi.mock('@dcl/sdk/src/players', () => ({
  onEnterScene: vi.fn(),
  onLeaveScene: vi.fn()
}))

type SentMessage = {
  type: string
  data: unknown
  to?: string[]
}

type CharadeMessage = {
  id: string
  answers: string[]
  look: ReturnType<typeof makeLook>
  isHouse: boolean
}

type ErrorMessage = { code: string }
type PostedMessage = { charadeId: string }

function messagesOfType(sent: SentMessage[], type: string) {
  return sent.filter((message) => message.type === type)
}

function dataOf<T>(message: SentMessage): T {
  return message.data as T
}

async function createHarness(
  overrides: Partial<
    Pick<ServerProtocolOptions, 'snapshotLook' | 'ready' | 'now' | 'lookAttempts' | 'lookRetryMilliseconds'>
  > = {}
) {
  const storage = new FakeStorage()
  const repository = createStorageRepository(storage)
  const now = overrides.now ?? (() => FIXED_NOW)
  const state = new GhostCharadesState(repository, now)
  await state.hydrate()
  const sent: SentMessage[] = []
  const send: ProtocolSend = async (type, data, to) => {
    sent.push({ type, data, to })
  }
  const snapshotLook = overrides.snapshotLook ?? (async (address: string) => makeLook(address, 'Player'))
  const checkpoint = vi.fn(async () => undefined)
  const protocol = createServerProtocol({
    state,
    send,
    snapshotLook,
    ready: overrides.ready,
    flush: checkpoint,
    now,
    instanceId: 'test-instance',
    lookAttempts: overrides.lookAttempts ?? 1,
    lookRetryMilliseconds: overrides.lookRetryMilliseconds ?? 0
  })
  return { storage, repository, state, sent, snapshotLook, checkpoint, protocol }
}

describe('server readiness and welcome', () => {
  it('does not answer before hydration and targets pong plus welcome after readiness', async () => {
    const ready = deferred<void>()
    const { sent, protocol } = await createHarness({ ready: ready.promise })
    const ping = protocol.handlePing({ seq: 7 }, '0xPlayer')

    expect(sent).toEqual([])
    ready.resolve()
    await ping

    expect(sent[0]).toEqual({ type: 'pong', data: { seq: 7 }, to: ['0xPlayer'] })
    expect(messagesOfType(sent, 'since')).toEqual([])
    expect(messagesOfType(sent, 'audience')).toHaveLength(1)
    expect(messagesOfType(sent, 'boards')).toHaveLength(1)
    expect(sent.every((message) => message.to?.[0] === '0xPlayer')).toBe(true)
  })

  it('retries a failed initial look snapshot on the next ping', async () => {
    const look = makeLook('0xPlayer', 'Ready now')
    let calls = 0
    const snapshotLook = vi.fn(async () => {
      calls += 1
      return calls === 1 ? null : look
    })
    const { state, sent, protocol } = await createHarness({ snapshotLook })

    await protocol.handleEnter('0xPlayer')
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'look-not-ready'
    ])
    sent.length = 0

    await protocol.handlePing({ seq: 2 }, '0xPlayer')

    expect(snapshotLook).toHaveBeenCalledTimes(2)
    expect(sent[0]).toEqual({ type: 'pong', data: { seq: 2 }, to: ['0xPlayer'] })
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.recentVisitors[0]).toMatchObject({ address: '0xPlayer', name: 'Ready now' })
  })

  it('uses the authoritative snapshot, sends returning since once, and chunks six audience looks by two', async () => {
    const authoritative = {
      ...makeLook('0xPlayer', 'Server Name'),
      wearables: Array.from({ length: 12 }, (_, index) => `wearable-${index}`)
    }
    const snapshotLook = vi.fn(async () => authoritative)
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    state.recentVisitors = Array.from({ length: 6 }, (_, index) => ({
      ...makeLook(`visitor-${index}`),
      wearables: Array.from({ length: 12 }, (_value, wearable) => `visitor-${index}-${wearable}`),
      lastSeenAt: index
    }))
    state.boards = {
      decoders: [{ address: '0xPLAYER', name: 'Server Name', correct: 4, total: 5 }],
      hardest: []
    }
    const stats = await state.getOrCreateStats('0xplayer', 'Server Name')
    stats.pending = { triedYou: 3, gotYou: 1 }

    await protocol.handleHello(
      { displayName: 'Spoofed Client Name', isGuest: true, protocolVersion: PROTOCOL_VERSION },
      '0xPlayer'
    )

    expect(snapshotLook).toHaveBeenCalledWith('0xPlayer')
    expect(state.recentVisitors[0]).toMatchObject({ address: '0xPlayer', name: 'Server Name' })
    expect(state.recentVisitors[0].wearables).toHaveLength(10)
    expect(stats.pending).toEqual({ triedYou: 0, gotYou: 0 })
    expect(messagesOfType(sent, 'since').map((message) => message.data)).toEqual([{ triedYou: 3, gotYou: 1, rank: 1 }])
    const audience = messagesOfType(sent, 'audience')
    expect(audience).toHaveLength(3)
    expect(audience.every((message) => dataOf<{ looks: unknown[] }>(message).looks.length === 2)).toBe(true)
    expect(audience.flatMap((message) => dataOf<{ looks: ReturnType<typeof makeLook>[] }>(message).looks)).toHaveLength(
      6
    )
    expect(sent.every((message) => message.to?.[0] === '0xPlayer')).toBe(true)
    expect(checkpoint).toHaveBeenCalledOnce()
  })

  it('rejects an incompatible protocol version without reading a look', async () => {
    const snapshotLook = vi.fn(async () => makeLook('player'))
    const { sent, protocol } = await createHarness({ snapshotLook })

    await protocol.handleHello({ displayName: 'Player', isGuest: false, protocolVersion: 999 }, 'player')

    expect(snapshotLook).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'error', data: { code: 'protocol-version' }, to: ['player'] }])
  })
})

describe('charade serving and guesses', () => {
  it('keeps answers stable, records one guess, and replays a completed request without mutating twice', async () => {
    const { state, sent, checkpoint, protocol } = await createHarness()
    const charade = makeCharade('stage-ghost', { author: { address: '0xAuthor', name: 'Author' } })
    state.upsertCharade(charade)
    await protocol.handleEnter('0xPlayer')
    sent.length = 0
    checkpoint.mockClear()

    await protocol.handleNextCharade({ exclude: [] }, '0xPlayer')
    const firstServed = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    await protocol.handleLeave('0xPlayer')
    await protocol.handleEnter('0xPlayer')
    sent.length = 0
    checkpoint.mockClear()
    await protocol.handleNextCharade({ exclude: [] }, '0xPlayer')
    const secondServed = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    expect(secondServed.answers).toEqual(firstServed.answers)

    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const answerIndex = secondServed.answers.indexOf(phrase.text)
    const guess = { charadeId: charade.id, answerIndex, requestId: 'guess-1' }
    sent.length = 0
    await protocol.handleGuess(guess, '0xPlayer')
    const firstReveal = messagesOfType(sent, 'reveal')[0]
    await protocol.handleGuess(guess, '0xPlayer')

    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(messagesOfType(sent, 'reveal')[1].data).toEqual(firstReveal.data)
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
    expect(state.playerStats.get('0xplayer')).toMatchObject({ decoded: 1, correct: 1, seen: [charade.id] })
    expect(state.playerStats.get('0xauthor')?.pending).toEqual({ triedYou: 1, gotYou: 1 })
    expect(checkpoint).toHaveBeenCalledOnce()

    await protocol.handleGuess({ ...guess, requestId: 'guess-2' }, '0xPlayer')
    expect(dataOf<ErrorMessage>(messagesOfType(sent, 'error').at(-1)!).code).toBe('already-guessed')
    expect(state.getCharade(charade.id)?.guesses.total).toBe(1)
    expect(sent.every((message) => message.to?.[0] === '0xPlayer')).toBe(true)
  })

  it('rejects invalid guesses and guesses for charades not served to that player', async () => {
    const { state, sent, protocol } = await createHarness()
    state.upsertCharade(makeCharade('unserved'))

    await protocol.handleGuess({ charadeId: 'unserved', answerIndex: 0, requestId: 'guess' }, 'player')
    await protocol.handleGuess({ charadeId: 'unserved', answerIndex: 3, requestId: 'guess-2' }, 'player')

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'charade-not-served',
      'invalid-guess'
    ])
  })
})

describe('authoring protocol', () => {
  it('validates phrase, emote tuple, and request id before snapshotting', async () => {
    const snapshotLook = vi.fn(async (address: string) => makeLook(address))
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    await protocol.handleEnter('player')
    snapshotLook.mockClear()
    sent.length = 0

    await protocol.handlePost({ phraseId: 'missing', emotes: ['wave', 'clap', 'dab'], requestId: 'one' }, 'player')
    await protocol.handlePost({ phraseId: DECK[0].id, emotes: ['wave', 'clap'], requestId: 'two' }, 'player')
    await protocol.handlePost(
      { phraseId: DECK[0].id, emotes: ['wave', 'clap', 'invalid'], requestId: 'three' },
      'player'
    )
    await protocol.handlePost({ phraseId: DECK[0].id, emotes: ['wave', 'clap', 'dab'], requestId: '' }, 'player')

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-post',
      'invalid-post',
      'invalid-post',
      'invalid-post'
    ])
    expect(snapshotLook).not.toHaveBeenCalled()
    expect(state.getPool()).toEqual([])
  })

  it('posts from a fresh authoritative snapshot, replays the request, and rate-limits a new request', async () => {
    const welcomeLook = makeLook('0xPlayer', 'Welcome Look')
    const postLook = {
      ...makeLook('0xPlayer', 'Fresh Post Look'),
      wearables: Array.from({ length: 12 }, (_, i) => `w-${i}`)
    }
    const snapshotLook = vi.fn<ServerProtocolOptions['snapshotLook']>()
    snapshotLook.mockResolvedValueOnce(welcomeLook).mockResolvedValue(postLook)
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    await protocol.handleEnter('0xPlayer')
    sent.length = 0
    checkpoint.mockClear()
    const post = { phraseId: DECK[3].id, emotes: [...DECK[3].suggested], requestId: 'post-1' }

    await protocol.handlePost(post, '0xPlayer')
    const firstPosted = dataOf<PostedMessage>(messagesOfType(sent, 'posted')[0])
    const stored = state.getCharade(firstPosted.charadeId)!
    expect(stored.author).toMatchObject({ address: '0xPlayer', name: 'Fresh Post Look' })
    expect(stored.author.wearables).toHaveLength(10)
    expect(stored.emotes).toEqual(post.emotes)
    expect(state.playerStats.get('0xplayer')?.authored).toEqual([stored.id])

    await protocol.handlePost(post, '0xPlayer')
    await protocol.handlePost({ ...post, requestId: 'post-2' }, '0xPlayer')

    expect(messagesOfType(sent, 'posted')).toHaveLength(2)
    expect(dataOf<PostedMessage>(messagesOfType(sent, 'posted')[1])).toEqual(firstPosted)
    expect(dataOf<ErrorMessage>(messagesOfType(sent, 'error')[0]).code).toBe('post-rate-limited')
    expect(state.getPool()).toHaveLength(1)
    expect(state.playerStats.get('0xplayer')?.authored).toEqual([stored.id])
    expect(snapshotLook).toHaveBeenCalledTimes(2)
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(sent.every((message) => message.to?.[0] === '0xPlayer')).toBe(true)
  })

  it('coalesces concurrent copies of the same post into one charade and one authored id', async () => {
    const gate = deferred<ReturnType<typeof makeLook> | null>()
    const welcomeLook = makeLook('player', 'Player')
    let snapshots = 0
    const snapshotLook = vi.fn(() => {
      snapshots += 1
      return snapshots === 1 ? Promise.resolve(welcomeLook) : gate.promise
    })
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    await protocol.handleEnter('player')
    sent.length = 0
    checkpoint.mockClear()
    const post = { phraseId: DECK[5].id, emotes: [...DECK[5].suggested], requestId: 'same-request' }

    const first = protocol.handlePost(post, 'player')
    const second = protocol.handlePost(post, 'player')
    gate.resolve(makeLook('player', 'Post Look'))
    await Promise.all([first, second])

    expect(state.getPool()).toHaveLength(1)
    expect(state.playerStats.get('player')?.authored).toHaveLength(1)
    expect(new Set(state.playerStats.get('player')?.authored).size).toBe(1)
    expect(messagesOfType(sent, 'posted')).toHaveLength(2)
    expect(
      new Set(messagesOfType(sent, 'posted').map((message) => dataOf<PostedMessage>(message).charadeId)).size
    ).toBe(1)
    expect(checkpoint).toHaveBeenCalledOnce()
  })

  it('prevents concurrent different requests from both bypassing the cooldown', async () => {
    const gate = deferred<ReturnType<typeof makeLook> | null>()
    let snapshots = 0
    const snapshotLook = vi.fn(() => {
      snapshots += 1
      return snapshots === 1 ? Promise.resolve(makeLook('player')) : gate.promise
    })
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    await protocol.handleEnter('player')
    sent.length = 0
    checkpoint.mockClear()

    const first = protocol.handlePost(
      { phraseId: DECK[6].id, emotes: [...DECK[6].suggested], requestId: 'different-1' },
      'player'
    )
    const second = protocol.handlePost(
      { phraseId: DECK[7].id, emotes: [...DECK[7].suggested], requestId: 'different-2' },
      'player'
    )
    gate.resolve(makeLook('player', 'Post Look'))
    await Promise.all([first, second])

    expect(state.getPool()).toHaveLength(1)
    expect(state.playerStats.get('player')?.authored).toHaveLength(1)
    expect(messagesOfType(sent, 'posted')).toHaveLength(1)
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'post-rate-limited'
    ])
    expect(checkpoint).toHaveBeenCalledOnce()
  })
})

describe('live protocol', () => {
  it('relays valid reactions only to other present players', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { sent, protocol } = await createHarness({ snapshotLook })
    await protocol.handleEnter('alice')
    await protocol.handleEnter('bob')
    sent.length = 0

    await protocol.handleReact({ kind: 'genius' }, 'alice')
    await protocol.handleReact({ kind: 'invalid' }, 'alice')

    expect(messagesOfType(sent, 'react')).toEqual([{ type: 'react', data: { kind: 'genius' }, to: ['bob'] }])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'error', data: { code: 'invalid-reaction' }, to: ['alice'] }
    ])
  })

  it('serves one authoritative live charade and broadcasts only the first correct winner', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const charade = makeCharade('live-stage', { author: { address: 'outside', name: 'Outside' } })
    state.upsertCharade(charade)
    await protocol.handleEnter('alice')
    await protocol.handleEnter('bob')

    expect(messagesOfType(sent, 'roundStart')).toEqual([
      { type: 'roundStart', data: { charadeId: charade.id }, to: undefined }
    ])
    sent.length = 0
    await protocol.handleNextCharade({ exclude: [] }, 'alice')
    await protocol.handleNextCharade({ exclude: [] }, 'bob')
    const served = messagesOfType(sent, 'charade').map((message) => dataOf<CharadeMessage>(message))
    expect(served.map((message) => message.id)).toEqual([charade.id, charade.id])
    expect(served[0].answers).toEqual(served[1].answers)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const correctIndex = served[0].answers.indexOf(phrase.text)
    sent.length = 0

    await protocol.handleRoundGuess(
      { charadeId: charade.id, answerIndex: correctIndex, requestId: 'alice-guess' },
      'alice'
    )
    await protocol.handleRoundGuess({ charadeId: charade.id, answerIndex: correctIndex, requestId: 'bob-guess' }, 'bob')

    expect(messagesOfType(sent, 'roundWinner')).toEqual([
      { type: 'roundWinner', data: { address: 'alice', name: 'Alice' }, to: undefined }
    ])
    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(protocol.rounds.current?.winner).toEqual({ address: 'alice', name: 'Alice' })
  })
})
