import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, themeForTimestamp } from '../src/shared/config'
import { DECK, HOUSE_CHARADE } from '../src/shared/deck'
import { createServerProtocol, type ProtocolSend, type ServerProtocolOptions } from '../src/server/server'
import { GhostlightState } from '../src/server/state'
import { PLAYER_STATS_KEY, StorageUnavailableError, createStorageRepository } from '../src/server/storage'
import { FIXED_NOW, FakeStorage, deferred, makeCharade, makeLook, makeReply, makeStats } from './test-helpers'

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
    Optional: (value: unknown) => value,
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
  recipient?: string
}

type ErrorMessage = { code: string }
type PostedMessage = { charadeId: string; replyTo?: string }

type CharadeReplyMessage = ReturnType<typeof makeReply> & {
  charadeId: string
}

function messagesOfType(sent: SentMessage[], type: string) {
  return sent.filter((message) => message.type === type)
}

function dataOf<T>(message: SentMessage): T {
  return message.data as T
}

let nextRequestSequence = 0

function nextCharadeRequest(exclude: string[] = []) {
  return { requestId: `next-${++nextRequestSequence}`, exclude }
}

function negotiate(protocol: ReturnType<typeof createServerProtocol>, address: string) {
  return protocol.handleHello({ displayName: address, isGuest: false, protocolVersion: PROTOCOL_VERSION }, address)
}

async function createHarness(
  overrides: Partial<
    Pick<ServerProtocolOptions, 'snapshotLook' | 'ready' | 'flush' | 'now' | 'lookAttempts' | 'lookRetryMilliseconds'>
  > = {},
  storage = new FakeStorage()
) {
  const repository = createStorageRepository(storage)
  const now = overrides.now ?? (() => FIXED_NOW)
  const state = new GhostlightState(repository, now)
  await state.hydrate()
  const sent: SentMessage[] = []
  const send: ProtocolSend = async (type, data, to) => {
    sent.push({ type, data, to })
  }
  const snapshotLook = overrides.snapshotLook ?? (async (address: string) => makeLook(address, 'Player'))
  const checkpoint = vi.fn(overrides.flush ?? (async () => undefined))
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

type ProtocolHarness = Awaited<ReturnType<typeof createHarness>>

async function serveAndGuess(harness: ProtocolHarness, address: string, charadeId: string) {
  await harness.protocol.handleNextCharade(nextCharadeRequest(), address)
  const served = messagesOfType(harness.sent, 'charade')
    .map((message) => dataOf<CharadeMessage>(message))
    .findLast((message) => message.id === charadeId)
  expect(served).toBeDefined()
  const phrase = DECK.find((candidate) => candidate.id === harness.state.getCharade(charadeId)?.phraseId)!
  await harness.protocol.handleGuess(
    {
      charadeId,
      answerIndex: served!.answers.indexOf(phrase.text),
      requestId: `guess-${address}-${charadeId}`
    },
    address
  )
}

describe('server readiness and welcome', () => {
  it('does not answer before hydration and never welcomes from ping before protocol negotiation', async () => {
    const ready = deferred<void>()
    const { sent, protocol } = await createHarness({ ready: ready.promise })
    const ping = protocol.handlePing({ seq: 7 }, '0xPlayer')

    expect(sent).toEqual([])
    ready.resolve()
    await ping

    expect(sent[0]).toEqual({ type: 'pong', data: { seq: 7 }, to: ['0xPlayer'] })
    expect(messagesOfType(sent, 'since')).toEqual([])
    expect(messagesOfType(sent, 'progress')).toEqual([])
    expect(messagesOfType(sent, 'audience')).toEqual([])
    expect(messagesOfType(sent, 'boards')).toEqual([])

    await negotiate(protocol, '0xPlayer')

    expect(messagesOfType(sent, 'progress')).toHaveLength(1)
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

    await negotiate(protocol, '0xPlayer')
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
    stats.pending = { triedYou: 3, gotYou: 1, replies: 2, mail: 0 }

    await protocol.handleHello(
      { displayName: 'Spoofed Client Name', isGuest: true, protocolVersion: PROTOCOL_VERSION },
      '0xPlayer'
    )

    expect(snapshotLook).toHaveBeenCalledWith('0xPlayer')
    expect(state.recentVisitors[0]).toMatchObject({ address: '0xPlayer', name: 'Server Name' })
    expect(state.recentVisitors[0].wearables).toHaveLength(12)
    expect(stats.pending).toEqual({ triedYou: 0, gotYou: 0, replies: 0, mail: 0 })
    expect(messagesOfType(sent, 'since').map((message) => message.data)).toEqual([
      {
        triedYou: 3,
        gotYou: 1,
        replies: 2,
        mail: 0,
        rank: 1,
        daily: { day: '2026-08-23', decoded: 0, authored: 0, stamped: false },
        title: '',
        nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 }
      }
    ])
    const audience = messagesOfType(sent, 'audience')
    expect(audience).toHaveLength(6)
    expect(audience.every((message) => dataOf<{ looks: unknown[] }>(message).looks.length === 1)).toBe(true)
    const audienceLooks = audience.flatMap((message) => dataOf<{ looks: ReturnType<typeof makeLook>[] }>(message).looks)
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

  it('sends only readiness on enter and gates every stateful action until a valid hello', async () => {
    const snapshotLook = vi.fn(async () => makeLook('player'))
    const { state, sent, protocol } = await createHarness({ snapshotLook })

    await protocol.handleEnter('player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    await protocol.handlePost(
      { phraseId: DECK[0].id, emotes: [...DECK[0].suggested], requestId: 'blocked-post' },
      'player'
    )
    await protocol.handleReact({ kind: 'genius' }, 'player')

    expect(messagesOfType(sent, 'ready')).toHaveLength(1)
    expect(messagesOfType(sent, 'progress')).toEqual([])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'protocol-required',
      'protocol-required',
      'protocol-required'
    ])
    expect(snapshotLook).not.toHaveBeenCalled()
    expect(state.getPool()).toEqual([])
  })

  it('waits for an in-flight welcome before serving and preserves stored player stats', async () => {
    const lookGate = deferred<ReturnType<typeof makeLook> | null>()
    const snapshotLook = vi.fn(() => lookGate.promise)
    const { storage, state, sent, protocol } = await createHarness({ snapshotLook })
    storage.putPlayerJSON('player', PLAYER_STATS_KEY, makeStats({ decoded: 7, correct: 5 }))
    const statsSpy = vi.spyOn(state, 'getOrCreateStats')

    const entering = negotiate(protocol, 'player')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledOnce())
    const serving = protocol.handleNextCharade(nextCharadeRequest(), 'player')
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
      makeStats({ decoded: 7, correct: 5, pending: { triedYou: 2, gotYou: 1, replies: 0, mail: 0 } })
    )

    const firstEnter = negotiate(protocol, 'player')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledOnce())
    await protocol.handleLeave('player')
    const secondEnter = negotiate(protocol, 'player')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledTimes(2))

    firstLook.resolve(makeLook('player', 'Stale Player'))
    await firstEnter
    secondLook.resolve(makeLook('player', 'Fresh Player'))
    await secondEnter

    expect(state.recentVisitors[0]).toMatchObject({ address: 'player', name: 'Fresh Player' })
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 7,
      correct: 5,
      pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 }
    })
    expect(storage.playerGets).toEqual([{ address: 'player', key: PLAYER_STATS_KEY }])
    expect(repository.getDirtyKeys()).toContain(`player:player:${PLAYER_STATS_KEY}`)
    expect(messagesOfType(sent, 'since').map((message) => message.data)).toEqual([
      {
        triedYou: 2,
        gotYou: 1,
        replies: 0,
        mail: 0,
        rank: 0,
        daily: { day: '2026-08-23', decoded: 0, authored: 0, stamped: false },
        title: '',
        nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 }
      }
    ])
    expect(messagesOfType(sent, 'audience')).toHaveLength(1)
    expect(messagesOfType(sent, 'boards')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])
  })

  it('changes ready and serving preference exactly at UTC midnight without restarting', async () => {
    let timestamp = Date.UTC(2026, 7, 23, 23, 59, 59, 999)
    const before = themeForTimestamp(timestamp)
    const after = themeForTimestamp(timestamp + 1)
    const { state, sent, protocol } = await createHarness({ now: () => timestamp })
    const beforePhrase = DECK.find((phrase) => phrase.theme === before.id)!
    const afterPhrase = DECK.find((phrase) => phrase.theme === after.id)!
    state.upsertCharade(
      makeCharade('before-midnight', {
        phraseId: beforePhrase.id,
        author: { address: 'before-author' },
        guesses: { total: 20 }
      })
    )
    state.upsertCharade(
      makeCharade('after-midnight', { phraseId: afterPhrase.id, author: { address: 'after-author' } })
    )

    await negotiate(protocol, 'player')
    expect(dataOf<{ serverTime: number; theme: string }>(messagesOfType(sent, 'ready').at(-1)!)).toMatchObject({
      serverTime: timestamp,
      theme: before.id
    })
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0]).id).toBe('before-midnight')

    timestamp += 1
    sent.length = 0
    await protocol.handlePing({ seq: 99 }, 'player')
    expect(dataOf<{ serverTime: number; theme: string }>(messagesOfType(sent, 'ready').at(-1)!)).toMatchObject({
      serverTime: timestamp,
      theme: after.id
    })
    expect(messagesOfType(sent, 'progress')).toHaveLength(1)
    expect(messagesOfType(sent, 'boards')).toHaveLength(1)
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0]).id).toBe('after-midnight')
  })
})

describe('charade serving and guesses', () => {
  it('coalesces retried next-charade request ids and echoes the id on the same selection', async () => {
    const { state, sent, protocol } = await createHarness()
    state.upsertCharade(makeCharade('first', { author: { address: 'author-a' } }))
    state.upsertCharade(makeCharade('second', { author: { address: 'author-b' } }))
    await negotiate(protocol, 'player')
    sent.length = 0
    const request = { requestId: 'same-next-request', exclude: [] }

    await Promise.all([protocol.handleNextCharade(request, 'player'), protocol.handleNextCharade(request, 'player')])

    const replies = messagesOfType(sent, 'charade').map((message) =>
      dataOf<CharadeMessage & { requestId: string }>(message)
    )
    expect(replies).toHaveLength(2)
    expect(new Set(replies.map((reply) => reply.id))).toEqual(new Set(['first']))
    expect(replies.map((reply) => reply.requestId)).toEqual(['same-next-request', 'same-next-request'])
  })

  it('keeps answers stable, records one guess, and replays a completed request without mutating twice', async () => {
    const { state, sent, checkpoint, protocol } = await createHarness()
    const charade = makeCharade('stage-ghost', { author: { address: '0xAuthor', name: 'Author' } })
    state.upsertCharade(charade)
    await negotiate(protocol, '0xPlayer')
    sent.length = 0
    checkpoint.mockClear()

    await protocol.handleNextCharade(nextCharadeRequest(), '0xPlayer')
    const firstServed = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    await protocol.handleLeave('0xPlayer')
    await negotiate(protocol, '0xPlayer')
    sent.length = 0
    checkpoint.mockClear()
    await protocol.handleNextCharade(nextCharadeRequest(), '0xPlayer')
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
    expect(state.playerStats.get('0xauthor')?.pending).toEqual({ triedYou: 1, gotYou: 1, replies: 0, mail: 0 })
    expect(checkpoint).toHaveBeenCalledOnce()

    await protocol.handleGuess({ ...guess, requestId: 'guess-2' }, '0xPlayer')
    expect(dataOf<ErrorMessage>(messagesOfType(sent, 'error').at(-1)!).code).toBe('already-guessed')
    expect(state.getCharade(charade.id)?.guesses.total).toBe(1)
    expect(sent.every((message) => message.to?.[0] === '0xPlayer')).toBe(true)
  })

  it('withholds reveal acknowledgement until a failed checkpoint succeeds on retry', async () => {
    let failCheckpoint = false
    const flush = vi.fn(async () => {
      if (failCheckpoint) throw new StorageUnavailableError(['scene:required'])
    })
    const { state, sent, protocol } = await createHarness({ flush })
    const charade = makeCharade('durable-guess', { author: { address: 'author' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const guess = {
      charadeId: charade.id,
      answerIndex: served.answers.indexOf(phrase.text),
      requestId: 'durable-guess-request'
    }
    sent.length = 0
    failCheckpoint = true

    await protocol.handleGuess(guess, 'player')

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'storage-unavailable'
    ])
    expect(state.getCharade(charade.id)?.guesses.total).toBe(1)
    failCheckpoint = false
    sent.length = 0

    await protocol.handleGuess(guess, 'player')

    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(state.getCharade(charade.id)?.guesses.total).toBe(1)
  })

  it('rejects invalid guesses and guesses for charades not served to that player', async () => {
    const { state, sent, protocol } = await createHarness()
    state.upsertCharade(makeCharade('unserved'))
    await negotiate(protocol, 'player')
    sent.length = 0

    await protocol.handleGuess({ charadeId: 'unserved', answerIndex: 0, requestId: 'guess' }, 'player')
    await protocol.handleGuess({ charadeId: 'unserved', answerIndex: 3, requestId: 'guess-2' }, 'player')

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'charade-not-served',
      'invalid-guess'
    ])
  })

  it('accepts the house fallback every time it is served without adding it to seen', async () => {
    const { state, sent, protocol } = await createHarness()
    await negotiate(protocol, 'player')
    sent.length = 0

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await protocol.handleNextCharade(nextCharadeRequest(), 'player')
      const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
      const phrase = DECK.find((candidate) => candidate.id === state.getCharade(served.id)?.phraseId)!
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
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const guess = {
      charadeId: charade.id,
      answerIndex: served.answers.indexOf(phrase.text),
      requestId: 'cleanup-request'
    }
    await protocol.handleGuess(guess, 'player')
    await protocol.handleLeave('player')
    await negotiate(protocol, 'player')
    sent.length = 0

    await protocol.handleGuess(guess, 'player')

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'error', data: { code: 'charade-not-served' }, to: ['player'] }
    ])
  })
})

describe('authoring protocol', () => {
  it('withholds posted acknowledgement until a failed checkpoint succeeds on retry', async () => {
    let failCheckpoint = false
    const flush = vi.fn(async () => {
      if (failCheckpoint) throw new StorageUnavailableError(['scene:required'])
    })
    const { state, sent, protocol } = await createHarness({ flush })
    await negotiate(protocol, 'player')
    const post = { phraseId: DECK[0].id, emotes: [...DECK[0].suggested], requestId: 'durable-post' }
    sent.length = 0
    failCheckpoint = true

    await protocol.handlePost(post, 'player')

    expect(messagesOfType(sent, 'posted')).toEqual([])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'storage-unavailable'
    ])
    expect(state.getPool()).toHaveLength(1)
    failCheckpoint = false
    sent.length = 0

    await protocol.handlePost(post, 'player')

    expect(messagesOfType(sent, 'posted')).toHaveLength(1)
    expect(state.getPool()).toHaveLength(1)
    expect(state.playerStats.get('player')?.authoredCount).toBe(1)
  })

  it('validates phrase, emote tuple, and request id before snapshotting', async () => {
    const snapshotLook = vi.fn(async (address: string) => makeLook(address))
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    await negotiate(protocol, 'player')
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
    await negotiate(protocol, '0xPlayer')
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

  it('persists a title unlock through a server restart and restores its reward state on reconnect', async () => {
    const storage = new FakeStorage()
    const first = await createHarness({}, storage)
    await negotiate(first.protocol, 'player')
    first.sent.length = 0

    await first.protocol.handlePost(
      { phraseId: DECK[0].id, emotes: [...DECK[0].suggested], requestId: 'first-performance' },
      'player'
    )

    expect(dataOf<Record<string, unknown>>(messagesOfType(first.sent, 'posted')[0])).toMatchObject({
      title: 'Understudy',
      titleUnlocked: true,
      nextUnlock: { nextTitle: 'Scene Stealer', progress: 0.2 }
    })
    await first.repository.flushNow()

    const second = await createHarness({}, storage)
    await negotiate(second.protocol, 'player')

    expect(dataOf<Record<string, unknown>>(messagesOfType(second.sent, 'progress')[0])).toMatchObject({
      title: 'Understudy',
      nextUnlock: { nextTitle: 'Scene Stealer', progress: 0.2 }
    })
    expect(messagesOfType(second.sent, 'playerTitle').map((message) => message.data)).toContainEqual({
      address: 'player',
      title: 'Understudy'
    })
    expect(second.state.playerStats.get('player')).toMatchObject({
      authored: [expect.any(String)],
      title: 'Understudy'
    })
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
    await negotiate(protocol, 'player')
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
    await negotiate(protocol, 'player')
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

describe('Ghost Mail protocol', () => {
  const senderAddress = `0x${'1'.repeat(40)}`
  const recipientAddress = `0x${'2'.repeat(40)}`
  const otherAddress = `0x${'3'.repeat(40)}`

  it('delivers persisted mail only to its real recipient and returns the answer-back to its sender', async () => {
    const storage = new FakeStorage()
    const snapshotLook = async (address: string) => {
      const names: Record<string, string> = {
        [senderAddress]: 'Sender',
        [recipientAddress]: 'Recipient',
        [otherAddress]: 'Other'
      }
      return makeLook(address, names[address] ?? 'Player')
    }
    const first = await createHarness({ snapshotLook }, storage)
    first.state.upsertCharade(
      makeCharade('recipient-performance', {
        author: { address: recipientAddress, name: 'Recipient' },
        createdAt: FIXED_NOW - 1
      })
    )
    await negotiate(first.protocol, senderAddress)
    first.sent.length = 0

    await first.protocol.handlePost(
      {
        phraseId: DECK[1].id,
        emotes: [...DECK[1].suggested],
        requestId: 'mail-send',
        recipient: recipientAddress
      },
      senderAddress
    )

    const posted = dataOf<PostedMessage & { recipient?: string }>(messagesOfType(first.sent, 'posted')[0])
    const mailId = posted.charadeId
    expect(posted.recipient).toBe(recipientAddress)
    expect(first.state.getCharade(mailId)).toMatchObject({ recipient: recipientAddress })
    expect(first.state.getCharade(mailId)?.reply).toBeUndefined()
    expect(first.state.getPool().map((charade) => charade.id)).toEqual(['recipient-performance'])
    expect(first.state.getPlayerCharades().map((charade) => charade.id)).toContain(mailId)
    await first.repository.flushNow()

    const otherVisit = await createHarness({ snapshotLook }, storage)
    await negotiate(otherVisit.protocol, otherAddress)
    otherVisit.sent.length = 0
    await otherVisit.protocol.handleNextCharade(nextCharadeRequest(), otherAddress)
    expect(dataOf<CharadeMessage>(messagesOfType(otherVisit.sent, 'charade').at(-1)!).id).not.toBe(mailId)

    const guestVisit = await createHarness(
      {
        snapshotLook: async (address) =>
          address === recipientAddress
            ? { ...makeLook(address, 'Guest Recipient'), isGuest: true }
            : snapshotLook(address)
      },
      storage
    )
    await negotiate(guestVisit.protocol, recipientAddress)
    expect(messagesOfType(guestVisit.sent, 'since')).toEqual([])
    guestVisit.sent.length = 0
    await guestVisit.protocol.handleNextCharade(nextCharadeRequest(), recipientAddress)
    expect(dataOf<CharadeMessage>(messagesOfType(guestVisit.sent, 'charade').at(-1)!).id).not.toBe(mailId)

    const recipientVisit = await createHarness({ snapshotLook }, storage)
    await negotiate(recipientVisit.protocol, recipientAddress)
    expect(messagesOfType(recipientVisit.sent, 'since').map((message) => message.data)).toEqual([
      expect.objectContaining({ mail: 1, triedYou: 0, replies: 0 })
    ])
    recipientVisit.sent.length = 0
    await recipientVisit.protocol.handleNextCharade(nextCharadeRequest(), recipientAddress)
    const mailed = dataOf<CharadeMessage>(messagesOfType(recipientVisit.sent, 'charade').at(-1)!)
    expect(mailed).toMatchObject({ id: mailId, recipient: recipientAddress, isHouse: false })
    const mailedPhrase = DECK.find((phrase) => phrase.id === recipientVisit.state.getCharade(mailId)?.phraseId)!
    await recipientVisit.protocol.handleGuess(
      {
        charadeId: mailId,
        answerIndex: mailed.answers.indexOf(mailedPhrase.text),
        requestId: 'mail-guess'
      },
      recipientAddress
    )
    await recipientVisit.protocol.handlePost(
      {
        phraseId: mailedPhrase.id,
        emotes: [...mailedPhrase.suggested],
        requestId: 'mail-answer-back',
        replyTo: mailId
      },
      recipientAddress
    )
    expect(recipientVisit.state.getCharade(mailId)?.reply).toMatchObject({
      address: recipientAddress,
      name: 'Recipient'
    })
    await recipientVisit.repository.flushNow()

    const senderReturn = await createHarness({ snapshotLook }, storage)
    await negotiate(senderReturn.protocol, senderAddress)
    expect(messagesOfType(senderReturn.sent, 'since').map((message) => message.data)).toEqual([
      expect.objectContaining({ triedYou: 1, gotYou: 1, replies: 1, mail: 0 })
    ])
    expect(senderReturn.state.getCharade(mailId)).toMatchObject({
      recipient: recipientAddress,
      reply: { address: recipientAddress }
    })
  })

  it('rejects guest senders and recipients outside the real known-performer list', async () => {
    const snapshotLook = async (address: string) =>
      address === senderAddress ? { ...makeLook(address, 'Guest Sender'), isGuest: true } : makeLook(address)
    const guest = await createHarness({ snapshotLook })
    guest.state.upsertCharade(
      makeCharade('known-recipient', { author: { address: recipientAddress, name: 'Recipient' } })
    )
    await negotiate(guest.protocol, senderAddress)
    guest.sent.length = 0
    await guest.protocol.handlePost(
      {
        phraseId: DECK[0].id,
        emotes: [...DECK[0].suggested],
        requestId: 'guest-mail',
        recipient: recipientAddress
      },
      senderAddress
    )
    expect(messagesOfType(guest.sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'mail-guest'
    ])
    expect(guest.state.getPlayerCharades()).toHaveLength(1)

    const real = await createHarness({ snapshotLook: async (address) => makeLook(address, 'Real Sender') })
    await negotiate(real.protocol, senderAddress)
    real.sent.length = 0
    await real.protocol.handlePost(
      {
        phraseId: DECK[0].id,
        emotes: [...DECK[0].suggested],
        requestId: 'unknown-recipient',
        recipient: recipientAddress
      },
      senderAddress
    )
    expect(messagesOfType(real.sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'mail-recipient-unknown'
    ])
    expect(real.state.getPlayerCharades()).toEqual([])
  })
})

describe('answer-back protocol', () => {
  it('rejects malformed and ineligible replies before taking a fresh look', async () => {
    const snapshotLook = vi.fn(async (address: string) => makeLook(address, address))
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    const target = makeCharade('reply-target', { author: { address: 'author', name: 'Author' } })
    state.upsertCharade(target)
    await negotiate(protocol, 'author')
    await negotiate(protocol, 'player')
    snapshotLook.mockClear()
    checkpoint.mockClear()
    sent.length = 0
    const base = { phraseId: target.phraseId, emotes: [...DECK[0].suggested], replyTo: target.id }

    await protocol.handlePost({ ...base, requestId: '' }, 'player')
    await protocol.handlePost({ ...base, phraseId: '', requestId: 'empty-phrase' }, 'player')
    await protocol.handlePost({ ...base, emotes: ['wave', 'clap'], requestId: 'short-emotes' }, 'player')
    await protocol.handlePost({ ...base, emotes: ['wave', 'clap', 'invalid'], requestId: 'bad-emote' }, 'player')
    await protocol.handlePost({ ...base, replyTo: 'missing', requestId: 'missing-target' }, 'player')
    await protocol.handlePost(
      { ...base, phraseId: HOUSE_CHARADE.phraseId, replyTo: HOUSE_CHARADE.id, requestId: 'house-target' },
      'player'
    )
    await protocol.handlePost({ ...base, requestId: 'self-target' }, 'author')
    await protocol.handlePost({ ...base, requestId: 'unseen-target' }, 'player')
    state.playerStats.get('player')!.seen.push(target.id)
    const wrongPhrase = DECK.find((candidate) => candidate.id !== target.phraseId)!
    await protocol.handlePost({ ...base, phraseId: wrongPhrase.id, requestId: 'wrong-phrase' }, 'player')

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-reply',
      'invalid-reply',
      'invalid-reply',
      'invalid-reply',
      'reply-not-eligible',
      'reply-not-eligible',
      'reply-not-eligible',
      'reply-not-eligible',
      'reply-not-eligible'
    ])
    expect(snapshotLook).not.toHaveBeenCalled()
    expect(checkpoint).not.toHaveBeenCalled()
    expect(state.getCharade(target.id)?.reply).toBeUndefined()
  })

  it('atomically accepts one of two concurrent replies and rejects the other as taken', async () => {
    const gate = deferred<void>()
    let holdReplyLooks = false
    const snapshotLook = vi.fn(async (address: string) => {
      if (holdReplyLooks) await gate.promise
      return makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    })
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    const target = makeCharade('race-target', { author: { address: 'author', name: 'Author' } })
    state.upsertCharade(target)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    state.playerStats.get('alice')!.seen.push(target.id)
    state.playerStats.get('bob')!.seen.push(target.id)
    sent.length = 0
    checkpoint.mockClear()
    holdReplyLooks = true
    const payload = { phraseId: target.phraseId, emotes: [...DECK[0].suggested], replyTo: target.id }

    const aliceReply = protocol.handlePost({ ...payload, requestId: 'alice-reply' }, 'alice')
    const bobReply = protocol.handlePost({ ...payload, requestId: 'bob-reply' }, 'bob')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledTimes(4))
    gate.resolve()
    await Promise.all([aliceReply, bobReply])

    expect(messagesOfType(sent, 'posted')).toHaveLength(1)
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual(['reply-taken'])
    expect(['alice', 'bob']).toContain(state.getCharade(target.id)?.reply?.address)
    expect(state.playerStats.get('author')?.pending.replies).toBe(1)
    expect(state.playerStats.get('alice')).toMatchObject({ authored: [], title: '' })
    expect(state.playerStats.get('bob')).toMatchObject({ authored: [], title: '' })
    expect(checkpoint).toHaveBeenCalledOnce()
  })

  it('returns an idempotent success to the same canonical replier without notifying twice', async () => {
    const snapshotLook = vi.fn(async (address: string) => makeLook(address, 'Alice'))
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    const target = makeCharade('idempotent-target', { author: { address: 'author', name: 'Author' } })
    state.upsertCharade(target)
    await negotiate(protocol, 'alice')
    state.playerStats.get('alice')!.seen.push(target.id)
    snapshotLook.mockClear()
    checkpoint.mockClear()
    sent.length = 0
    const firstEmotes = [...DECK[0].suggested]

    await protocol.handlePost(
      { phraseId: target.phraseId, emotes: firstEmotes, requestId: 'first-reply', replyTo: target.id },
      'alice'
    )
    await protocol.handlePost(
      { phraseId: target.phraseId, emotes: [...DECK[1].suggested], requestId: 'retry-reply', replyTo: target.id },
      'ALICE'
    )

    expect(messagesOfType(sent, 'posted').map((message) => dataOf<PostedMessage>(message).replyTo)).toEqual([
      target.id,
      target.id
    ])
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.getCharade(target.id)?.reply?.emotes).toEqual(firstEmotes)
    expect(state.playerStats.get('author')?.pending.replies).toBe(1)
    expect(snapshotLook).toHaveBeenCalledOnce()
    expect(checkpoint).toHaveBeenCalledTimes(2)
  })

  it('restores a reply and consumes its author notification exactly once after server restarts', async () => {
    const storage = new FakeStorage()
    const snapshotLook = async (address: string) => makeLook(address, address === 'author' ? 'Author' : 'Decoder')
    const first = await createHarness({ snapshotLook }, storage)
    const target = makeCharade('persistent-reply', { author: { address: 'author', name: 'Author' } })
    first.state.upsertCharade(target)
    await negotiate(first.protocol, 'decoder')
    await serveAndGuess(first, 'decoder', target.id)
    await first.protocol.handlePost(
      {
        phraseId: target.phraseId,
        emotes: [...DECK[0].suggested],
        requestId: 'persistent-answer-back',
        replyTo: target.id
      },
      'decoder'
    )
    await first.repository.flushNow()

    const second = await createHarness({ snapshotLook }, storage)
    expect(second.state.getCharade(target.id)?.reply).toMatchObject({ address: 'decoder', name: 'Decoder' })
    await negotiate(second.protocol, 'author')
    expect(messagesOfType(second.sent, 'since').map((message) => message.data)).toEqual([
      expect.objectContaining({ triedYou: 1, gotYou: 1, replies: 1 })
    ])
    expect(second.state.playerStats.get('author')?.pending).toEqual({ triedYou: 0, gotYou: 0, replies: 0, mail: 0 })
    await second.repository.flushNow()

    const third = await createHarness({ snapshotLook }, storage)
    await negotiate(third.protocol, 'author')
    expect(messagesOfType(third.sent, 'since')).toEqual([])
    expect(third.state.getCharade(target.id)?.reply).toMatchObject({ address: 'decoder', name: 'Decoder' })
  })
})

describe('live protocol', () => {
  it('relays valid reactions only to other present players', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { sent, protocol } = await createHarness({ snapshotLook })
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
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
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')

    expect(messagesOfType(sent, 'roundStart')).toEqual([])
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    expect(messagesOfType(sent, 'roundStart')).toEqual([
      { type: 'roundStart', data: { charadeId: charade.id }, to: undefined }
    ])
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

  it('reveals house guesses across consecutive varied fallback rounds', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    sent.length = 0

    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const phrase = DECK.find((candidate) => candidate.id === state.getCharade(served.id)?.phraseId)!
    const correctIndex = served.answers.indexOf(phrase.text)
    const wrongIndex = (correctIndex + 1) % served.answers.length

    await protocol.handleRoundGuess(
      { charadeId: served.id, answerIndex: correctIndex, requestId: 'alice-first' },
      'alice'
    )
    await protocol.handleRoundGuess({ charadeId: served.id, answerIndex: wrongIndex, requestId: 'bob-first' }, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest([served.id]), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest([served.id]), 'bob')
    const nextServed = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const nextPhrase = DECK.find((candidate) => candidate.id === state.getCharade(nextServed.id)?.phraseId)!
    const nextCorrectIndex = nextServed.answers.indexOf(nextPhrase.text)
    const nextWrongIndex = (nextCorrectIndex + 1) % nextServed.answers.length
    sent.length = 0

    await protocol.handleRoundGuess(
      { charadeId: nextServed.id, answerIndex: nextWrongIndex, requestId: 'bob-second' },
      'bob'
    )
    await protocol.handleRoundGuess(
      { charadeId: nextServed.id, answerIndex: nextCorrectIndex, requestId: 'alice-second' },
      'alice'
    )

    expect(nextServed.id).not.toBe(served.id)
    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(messagesOfType(sent, 'error')).toEqual([])
  })

  it('starts a fresh round after every present player guesses wrong', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    state.upsertCharade(makeCharade('live-a', { author: { address: 'outside-a' } }))
    state.upsertCharade(makeCharade('live-b', { author: { address: 'outside-b' } }))
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    sent.length = 0

    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
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

    await protocol.handleNextCharade(nextCharadeRequest([firstRound.id]), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest([firstRound.id]), 'bob')

    const nextRound = messagesOfType(sent, 'charade').map((message) => dataOf<CharadeMessage>(message).id)
    expect(nextRound).toHaveLength(2)
    expect(nextRound.every((id) => id !== firstRound.id)).toBe(true)
  })

  it('serves a fresh charade to a player who already guessed while the partner is idle', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    state.upsertCharade(makeCharade('live-a', { author: { address: 'outside-a' } }))
    state.upsertCharade(makeCharade('live-b', { author: { address: 'outside-b' } }))
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    sent.length = 0

    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
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

    await protocol.handleNextCharade(nextCharadeRequest([firstRound.id]), 'alice')

    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0]).id).not.toBe(firstRound.id)
    expect(protocol.rounds.current).toMatchObject({ charadeId: firstRound.id, guessed: ['alice'], winner: null })
  })

  it('does not add a latecomer who already saw the active charade to the round', async () => {
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
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    expect(served.id).toBe(live.id)

    await negotiate(protocol, 'carol')
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'carol')

    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0]).id).toBe(alternate.id)
    expect(protocol.rounds.hasPlayer('carol')).toBe(false)
    expect(protocol.rounds.current?.guessed).not.toContain('carol')

    const phrase = DECK.find((candidate) => candidate.id === live.phraseId)!
    const correctIndex = served.answers.indexOf(phrase.text)
    const wrongIndex = (correctIndex + 1) % served.answers.length
    await protocol.handleRoundGuess({ charadeId: live.id, answerIndex: wrongIndex, requestId: 'alice-wrong' }, 'alice')
    await protocol.handleRoundGuess({ charadeId: live.id, answerIndex: wrongIndex, requestId: 'bob-wrong' }, 'bob')

    expect(protocol.rounds.isSettled).toBe(true)
  })

  it('serves a re-entering author another charade without counting a self-attempt', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const live = makeCharade('author-live', {
      author: { address: 'author', name: 'Author' },
      createdAt: FIXED_NOW - 2
    })
    const alternate = makeCharade('author-alternate', {
      author: { address: 'outside', name: 'Outside' },
      createdAt: FIXED_NOW - 1
    })
    state.upsertCharade(live)
    state.upsertCharade(alternate)
    await negotiate(protocol, 'author')
    await protocol.handleLeave('author')
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const liveMessage = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    expect(liveMessage.id).toBe(live.id)

    await negotiate(protocol, 'author')
    const authorStats = state.playerStats.get('author')!
    const triedYouBefore = authorStats.pending.triedYou
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'author')

    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0]).id).toBe(alternate.id)
    expect(protocol.rounds.hasPlayer('author')).toBe(false)
    expect(protocol.rounds.current?.guessed).not.toContain('author')
    expect(authorStats.pending.triedYou).toBe(triedYouBefore)

    const phrase = DECK.find((candidate) => candidate.id === live.phraseId)!
    const wrongIndex = (liveMessage.answers.indexOf(phrase.text) + 1) % liveMessage.answers.length
    await protocol.handleRoundGuess({ charadeId: live.id, answerIndex: wrongIndex, requestId: 'alice-wrong' }, 'alice')
    expect(protocol.rounds.isSettled).toBe(false)
    await protocol.handleRoundGuess({ charadeId: live.id, answerIndex: wrongIndex, requestId: 'bob-wrong' }, 'bob')

    expect(protocol.rounds.isSettled).toBe(true)
    expect(authorStats.pending.triedYou).toBe(triedYouBefore + 2)
  })

  it("accepts a survivor's round guess as a plain guess after the other player leaves", async () => {
    const snapshotLook = async (address: string) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const charade = makeCharade('abandoned-round', { author: { address: 'outside', name: 'Outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
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

  it('keeps each maximal-look wire payload below 4,000 bytes and records exact sizes', async () => {
    const wearables = Array.from({ length: 20 }, (_, index) =>
      `urn:decentraland:matic:collections-v2:wearable-${index.toString().padStart(2, '0')}`.padEnd(85, 'x')
    )
    const storage = new FakeStorage()
    storage.putPlayerJSON(
      'player',
      PLAYER_STATS_KEY,
      makeStats({ pending: { triedYou: 99, gotYou: 50, replies: 9, mail: 4 } })
    )
    const { state, sent, protocol } = await createHarness({}, storage)
    const phrase = DECK.find((candidate) => candidate.theme === themeForTimestamp(FIXED_NOW).id)!
    const target = makeCharade('ghost-0000000000000000', {
      phraseId: phrase.id,
      author: {
        address: `0x${'a'.repeat(40)}`,
        name: 'A'.repeat(30),
        wearables
      },
      guesses: { total: 1, correct: 0 },
      createdAt: FIXED_NOW - 10_000,
      reply: makeReply(`0x${'b'.repeat(40)}`, 'B'.repeat(30), {
        look: { ...makeLook(`0x${'b'.repeat(40)}`, 'B'.repeat(30)), wearables }
      })
    })
    state.upsertCharade(target)
    for (let index = 1; index < 10; index += 1) {
      state.upsertCharade(
        makeCharade(`ghost-${index.toString().padStart(16, '0')}`, {
          phraseId: phrase.id,
          author: {
            address: `0x${index.toString(16).repeat(40).slice(0, 40)}`,
            name: `${index}`.repeat(30)
          },
          guesses: { total: index + 1, correct: index % 2 },
          createdAt: FIXED_NOW - 10_000 + index
        })
      )
    }
    for (let index = 0; index < 10; index += 1) {
      state.recordDecoder(
        `0x${(index + 10).toString(16).repeat(40).slice(0, 40)}`,
        `${index}`.repeat(30),
        index % 2 === 0
      )
    }
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')

    const charade = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const reply = dataOf<CharadeReplyMessage>(messagesOfType(sent, 'charadeReply').at(-1)!)
    const since = messagesOfType(sent, 'since').at(-1)!.data
    const boards = messagesOfType(sent, 'boards').at(-1)!.data
    const ready = messagesOfType(sent, 'ready').at(-1)!.data
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
    const wireMeasurements = {
      charade: bytes(charade),
      mailCharade: bytes({ ...charade, recipient: `0x${'c'.repeat(40)}` }),
      charadeReply: bytes(reply),
      since: bytes(since),
      boards: bytes(boards),
      ready: bytes(ready)
    }
    const inlineCharade = bytes({
      ...charade,
      reply: {
        address: reply.address,
        name: reply.name,
        look: reply.look,
        emotes: reply.emotes,
        createdAt: reply.createdAt
      }
    })

    expect(charade.id).toBe(target.id)
    expect(charade.look.wearables).toHaveLength(20)
    expect(reply.look.wearables).toHaveLength(20)
    expect(Object.values(wireMeasurements).every((size) => size < 4_000)).toBe(true)
    expect(inlineCharade).toBeGreaterThan(4_000)
    expect({ ...wireMeasurements, inlineCharade }).toEqual({
      charade: 2_403,
      mailCharade: 2_460,
      charadeReply: 2_278,
      since: 231,
      boards: 3_263,
      ready: 110,
      inlineCharade: 4_653
    })
  })

  it('trims unusually long wearable URNs until every emitted payload stays below 4,000 bytes', async () => {
    const wearables = Array.from({ length: 20 }, (_, index) =>
      `urn:decentraland:matic:collections-v2:oversized-${index.toString().padStart(2, '0')}`.padEnd(200, 'x')
    )
    const { state, sent, protocol } = await createHarness()
    const phrase = DECK.find((candidate) => candidate.theme === themeForTimestamp(FIXED_NOW).id)!
    const longAddress = `0x${'a'.repeat(198)}`
    const longName = 'Performer'.repeat(25)
    const target = makeCharade('oversized-wire-look', {
      phraseId: phrase.id,
      author: { address: longAddress, name: longName, wearables },
      guesses: { total: 1, correct: 0 },
      reply: makeReply(`0x${'b'.repeat(198)}`, longName, {
        look: { ...makeLook(`0x${'b'.repeat(198)}`, longName), wearables }
      })
    })
    state.upsertCharade(target)
    state.boards = {
      decoders: Array.from({ length: 10 }, (_, index) => ({
        address: `${index}${longAddress}`,
        name: `${index}${longName}`,
        correct: index,
        total: 10
      })),
      hardest: Array.from({ length: 10 }, (_, index) => ({
        charadeId: `${index}${'charade'.repeat(30)}`,
        authorName: `${index}${longName}`,
        correct: index,
        total: 10
      }))
    }

    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')

    const charade = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const reply = dataOf<CharadeReplyMessage>(messagesOfType(sent, 'charadeReply').at(-1)!)
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
    expect(charade.look.wearables.length).toBeLessThan(20)
    expect(reply.look.wearables.length).toBeLessThan(20)
    expect(sent.every((message) => bytes(message.data) < 4_000)).toBe(true)
  })
})
