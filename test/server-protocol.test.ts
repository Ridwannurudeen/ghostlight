import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '../src/shared/config'
import { DECK, HOUSE_CHARADE } from '../src/shared/deck'
import { createServerProtocol, type ProtocolSend, type ServerProtocolOptions } from '../src/server/server'
import { GhostCharadesState } from '../src/server/state'
import { PLAYER_STATS_KEY, createStorageRepository } from '../src/server/storage'
import { FIXED_NOW, FakeStorage, deferred, makeCharade, makeLook, makeStats } from './test-helpers'

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

  it('uses the authoritative snapshot, sends returning since once, and chunks audience looks one at a time', async () => {
    const authoritative = {
      ...makeLook('0xPlayer', 'Server Name'),
      wearables: Array.from({ length: 12 }, (_, index) => `wearable-${index}`)
    }
    const snapshotLook = vi.fn(async () => authoritative)
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    state.recentVisitors = Array.from({ length: 6 }, (_, index) => ({
      ...makeLook(`visitor-${index}`),
      wearables: Array.from({ length: 20 }, (_value, wearable) =>
        `urn:decentraland:matic:collections-v2:visitor-${index}-${wearable}`.padEnd(95, 'x')
      ),
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
    expect(state.recentVisitors[0].wearables).toHaveLength(12)
    expect(stats.pending).toEqual({ triedYou: 0, gotYou: 0 })
    expect(messagesOfType(sent, 'since').map((message) => message.data)).toEqual([{ triedYou: 3, gotYou: 1, rank: 1 }])
    const audience = messagesOfType(sent, 'audience')
    expect(audience).toHaveLength(6)
    expect(audience.every((message) => dataOf<{ looks: unknown[] }>(message).looks.length === 1)).toBe(true)
    const audienceLooks = audience.flatMap(
      (message) => dataOf<{ looks: ReturnType<typeof makeLook>[] }>(message).looks
    )
    expect(audienceLooks).toHaveLength(6)
    expect(audienceLooks.every((look) => look.wearables.length === 20)).toBe(true)
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

  it('waits for an in-flight welcome before serving and preserves stored player stats', async () => {
    const lookGate = deferred<ReturnType<typeof makeLook> | null>()
    const snapshotLook = vi.fn(() => lookGate.promise)
    const { storage, state, sent, protocol } = await createHarness({ snapshotLook })
    storage.putPlayerJSON('player', PLAYER_STATS_KEY, makeStats({ decoded: 7, correct: 5 }))
    const statsSpy = vi.spyOn(state, 'getOrCreateStats')

    const entering = protocol.handleEnter('player')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledOnce())
    const serving = protocol.handleNextCharade({ exclude: [] }, 'player')
    await Promise.resolve()

    expect(statsSpy).not.toHaveBeenCalled()
    expect(state.playerStats.has('player')).toBe(false)

    lookGate.resolve(makeLook('player', 'Stored Player'))
    await Promise.all([entering, serving])

    expect(storage.playerGets).toEqual([{ address: 'player', key: PLAYER_STATS_KEY }])
    expect(state.playerStats.get('player')).toMatchObject({ decoded: 7, correct: 5 })
    expect(messagesOfType(sent, 'charade')).toHaveLength(1)
  })

  it('cancels an in-flight welcome on leave and completes a fresh welcome on re-entry', async () => {
    const firstLook = deferred<ReturnType<typeof makeLook> | null>()
    const secondLook = deferred<ReturnType<typeof makeLook> | null>()
    const snapshotLook = vi
      .fn<ServerProtocolOptions['snapshotLook']>()
      .mockReturnValueOnce(firstLook.promise)
      .mockReturnValueOnce(secondLook.promise)
    const { storage, repository, state, sent, protocol } = await createHarness({ snapshotLook })
    storage.putPlayerJSON(
      'player',
      PLAYER_STATS_KEY,
      makeStats({ decoded: 7, correct: 5, pending: { triedYou: 2, gotYou: 1 } })
    )

    const firstEnter = protocol.handleEnter('player')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledOnce())
    await protocol.handleLeave('player')
    const secondEnter = protocol.handleEnter('player')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledTimes(2))

    firstLook.resolve(makeLook('player', 'Stale Player'))
    await firstEnter
    secondLook.resolve(makeLook('player', 'Fresh Player'))
    await secondEnter

    expect(state.recentVisitors[0]).toMatchObject({ address: 'player', name: 'Fresh Player' })
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 7,
      correct: 5,
      pending: { triedYou: 0, gotYou: 0 }
    })
    expect(storage.playerGets).toEqual([{ address: 'player', key: PLAYER_STATS_KEY }])
    expect(repository.getDirtyKeys()).toContain(`player:player:${PLAYER_STATS_KEY}`)
    expect(messagesOfType(sent, 'since').map((message) => message.data)).toEqual([{ triedYou: 2, gotYou: 1, rank: 0 }])
    expect(messagesOfType(sent, 'audience')).toHaveLength(1)
    expect(messagesOfType(sent, 'boards')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])
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

  it('accepts the house fallback every time it is served without adding it to seen', async () => {
    const { state, sent, protocol } = await createHarness()
    await protocol.handleEnter('player')
    sent.length = 0

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await protocol.handleNextCharade({ exclude: [] }, 'player')
      const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
      const phrase = DECK.find((candidate) => candidate.id === 'pop-ghost-party')!
      await protocol.handleGuess(
        {
          charadeId: served.id,
          answerIndex: served.answers.indexOf(phrase.text),
          requestId: `house-${attempt}`
        },
        'player'
      )
    }

    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.playerStats.get('player')).toMatchObject({ decoded: 0, correct: 0, seen: [] })
  })

  it('forgets served answers and completed requests when a player leaves', async () => {
    const { state, sent, protocol } = await createHarness()
    const charade = makeCharade('leave-cleanup')
    state.upsertCharade(charade)
    await protocol.handleEnter('player')
    await protocol.handleNextCharade({ exclude: [] }, 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const guess = {
      charadeId: charade.id,
      answerIndex: served.answers.indexOf(phrase.text),
      requestId: 'cleanup-request'
    }
    await protocol.handleGuess(guess, 'player')
    await protocol.handleLeave('player')
    await protocol.handleEnter('player')
    sent.length = 0

    await protocol.handleGuess(guess, 'player')

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'error', data: { code: 'charade-not-served' }, to: ['player'] }
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
    expect(stored.author.wearables).toHaveLength(12)
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

  it('reveals repeated house guesses when overlapping rounds re-serve the same house charade', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { sent, protocol } = await createHarness({ snapshotLook })
    await protocol.handleEnter('alice')
    await protocol.handleEnter('bob')
    sent.length = 0

    await protocol.handleNextCharade({ exclude: [] }, 'alice')
    await protocol.handleNextCharade({ exclude: [] }, 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const phrase = DECK.find((candidate) => candidate.id === HOUSE_CHARADE.phraseId)!
    const correctIndex = served.answers.indexOf(phrase.text)
    const wrongIndex = (correctIndex + 1) % served.answers.length

    await protocol.handleRoundGuess(
      { charadeId: served.id, answerIndex: correctIndex, requestId: 'alice-first' },
      'alice'
    )
    await protocol.handleNextCharade({ exclude: [served.id] }, 'alice')
    await protocol.handleRoundGuess({ charadeId: served.id, answerIndex: wrongIndex, requestId: 'bob-first' }, 'bob')
    await protocol.handleNextCharade({ exclude: [served.id] }, 'bob')
    sent.length = 0

    await protocol.handleRoundGuess({ charadeId: served.id, answerIndex: wrongIndex, requestId: 'bob-second' }, 'bob')
    await protocol.handleRoundGuess(
      { charadeId: served.id, answerIndex: correctIndex, requestId: 'alice-second' },
      'alice'
    )

    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(messagesOfType(sent, 'error')).toEqual([])
  })

  it('starts a fresh round after every present player guesses wrong', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    state.upsertCharade(makeCharade('live-a', { author: { address: 'outside-a' } }))
    state.upsertCharade(makeCharade('live-b', { author: { address: 'outside-b' } }))
    await protocol.handleEnter('alice')
    await protocol.handleEnter('bob')
    sent.length = 0

    await protocol.handleNextCharade({ exclude: [] }, 'alice')
    await protocol.handleNextCharade({ exclude: [] }, 'bob')
    const firstRound = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const correctIndex = firstRound.answers.indexOf(
      DECK.find((phrase) => phrase.id === state.getCharade(firstRound.id)!.phraseId)!.text
    )
    const wrongIndex = (correctIndex + 1) % firstRound.answers.length
    await protocol.handleRoundGuess(
      { charadeId: firstRound.id, answerIndex: wrongIndex, requestId: 'alice-wrong' },
      'alice'
    )
    await protocol.handleRoundGuess(
      { charadeId: firstRound.id, answerIndex: wrongIndex, requestId: 'bob-wrong' },
      'bob'
    )
    expect(protocol.rounds.isSettled).toBe(true)
    sent.length = 0

    await protocol.handleNextCharade({ exclude: [firstRound.id] }, 'alice')
    await protocol.handleNextCharade({ exclude: [firstRound.id] }, 'bob')

    const nextRound = messagesOfType(sent, 'charade').map((message) => dataOf<CharadeMessage>(message).id)
    expect(nextRound).toHaveLength(2)
    expect(nextRound.every((id) => id !== firstRound.id)).toBe(true)
  })

  it('serves a fresh charade to a player who already guessed while the partner is idle', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    state.upsertCharade(makeCharade('live-a', { author: { address: 'outside-a' } }))
    state.upsertCharade(makeCharade('live-b', { author: { address: 'outside-b' } }))
    await protocol.handleEnter('alice')
    await protocol.handleEnter('bob')
    sent.length = 0

    await protocol.handleNextCharade({ exclude: [] }, 'alice')
    const firstRound = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const correctIndex = firstRound.answers.indexOf(
      DECK.find((phrase) => phrase.id === state.getCharade(firstRound.id)!.phraseId)!.text
    )
    await protocol.handleRoundGuess(
      {
        charadeId: firstRound.id,
        answerIndex: (correctIndex + 1) % firstRound.answers.length,
        requestId: 'alice-wrong'
      },
      'alice'
    )
    sent.length = 0

    await protocol.handleNextCharade({ exclude: [firstRound.id] }, 'alice')

    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0]).id).not.toBe(firstRound.id)
    expect(protocol.rounds.current).toMatchObject({ charadeId: firstRound.id, guessed: ['alice'], winner: null })
  })

  it('records a latecomer abstention when they have already seen the live charade', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { storage, state, sent, protocol } = await createHarness({ snapshotLook })
    const live = makeCharade('live-seen', {
      author: { address: 'outside-live' },
      createdAt: FIXED_NOW - 2
    })
    const alternate = makeCharade('alternate', {
      author: { address: 'outside-alternate' },
      createdAt: FIXED_NOW - 1
    })
    state.upsertCharade(live)
    state.upsertCharade(alternate)
    storage.putPlayerJSON('carol', PLAYER_STATS_KEY, makeStats({ seen: [live.id] }))
    await protocol.handleEnter('alice')
    await protocol.handleEnter('bob')
    await protocol.handleNextCharade({ exclude: [] }, 'alice')
    await protocol.handleNextCharade({ exclude: [] }, 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    expect(served.id).toBe(live.id)

    await protocol.handleEnter('carol')
    sent.length = 0
    await protocol.handleNextCharade({ exclude: [] }, 'carol')

    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0]).id).toBe(alternate.id)
    expect(protocol.rounds.current?.guessed).toContain('carol')

    const phrase = DECK.find((candidate) => candidate.id === live.phraseId)!
    const correctIndex = served.answers.indexOf(phrase.text)
    const wrongIndex = (correctIndex + 1) % served.answers.length
    await protocol.handleRoundGuess(
      { charadeId: live.id, answerIndex: wrongIndex, requestId: 'alice-wrong' },
      'alice'
    )
    await protocol.handleRoundGuess({ charadeId: live.id, answerIndex: wrongIndex, requestId: 'bob-wrong' }, 'bob')

    expect(protocol.rounds.isSettled).toBe(true)
  })

  it("accepts a survivor's round guess as a plain guess after the other player leaves", async () => {
    const snapshotLook = async (address: string) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const charade = makeCharade('abandoned-round', { author: { address: 'outside', name: 'Outside' } })
    state.upsertCharade(charade)
    await protocol.handleEnter('alice')
    await protocol.handleEnter('bob')
    await protocol.handleNextCharade({ exclude: [] }, 'alice')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    await protocol.handleLeave('bob')
    sent.length = 0

    await protocol.handleRoundGuess(
      {
        charadeId: charade.id,
        answerIndex: served.answers.indexOf(phrase.text),
        requestId: 'survivor-guess'
      },
      'alice'
    )

    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
  })

  it('keeps a 20-wearable charade payload below 4,000 bytes', async () => {
    const wearables = Array.from({ length: 20 }, (_, index) =>
      `urn:decentraland:matic:collections-v2:wearable-${index.toString().padStart(2, '0')}`.padEnd(85, 'x')
    )
    const { state, sent, protocol } = await createHarness()
    state.upsertCharade(makeCharade('full-look', { author: { address: 'outside', wearables } }))
    await protocol.handleEnter('player')
    sent.length = 0

    await protocol.handleNextCharade({ exclude: [] }, 'player')

    const payload = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    expect(payload.look.wearables).toHaveLength(20)
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThan(4_000)
  })
})
