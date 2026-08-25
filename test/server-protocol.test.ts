import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, themeForTimestamp } from '../src/shared/config'
import { DECK, HOUSE_CHARADE, HOUSE_CHARADES } from '../src/shared/deck'
import { pickDecoys, shuffleSeeded } from '../src/shared/pick'
import {
  createServerProtocol,
  runServerHandler,
  type ProtocolSend,
  type ServerProtocolOptions
} from '../src/server/server'
import { GhostlightState } from '../src/server/state'
import {
  MAX_DIRTY_ENTRIES,
  PLAYER_STATS_KEY,
  StorageCapacityError,
  StorageUnavailableError,
  createStorageRepository
} from '../src/server/storage'
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
  answerIds: string[]
  emotes: string[]
  look: ReturnType<typeof makeLook>
  isHouse: boolean
  recipient?: string
  setRound?: number
  setSize?: number
  setScore?: number
  setStreak?: number
  isFinale?: boolean
}

type ErrorMessage = { code: string }
type PostedMessage = { requestId: string; charadeId: string; replyTo?: string; revision: number }

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

async function negotiate(protocol: ReturnType<typeof createServerProtocol>, address: string) {
  await protocol.handleEnter(address)
  return protocol.handleHello({ displayName: address, isGuest: false, protocolVersion: PROTOCOL_VERSION }, address)
}

async function createHarness(
  overrides: Partial<
    Pick<
      ServerProtocolOptions,
      | 'snapshotLook'
      | 'ready'
      | 'flush'
      | 'now'
      | 'lookAttempts'
      | 'lookRetryMilliseconds'
      | 'random'
      | 'roundDurationMilliseconds'
      | 'send'
    >
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
    await overrides.send?.(type, data, to)
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
    lookRetryMilliseconds: overrides.lookRetryMilliseconds ?? 0,
    random: overrides.random ?? (() => 0.5),
    roundDurationMilliseconds: overrides.roundDurationMilliseconds
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
  it('contains rejected fire-and-forget handlers at the production callback boundary', async () => {
    const failure = new StorageCapacityError('saturated')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    runServerHandler(Promise.reject(failure))

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('[protocol] handler failed', failure))
    errorSpy.mockRestore()
  })

  it('requires an enter generation before protocol negotiation', async () => {
    const snapshotLook = vi.fn(async () => makeLook('player'))
    const { sent, protocol } = await createHarness({ snapshotLook })

    await protocol.handleHello({ displayName: 'Player', isGuest: false, protocolVersion: PROTOCOL_VERSION }, 'player')

    expect(snapshotLook).not.toHaveBeenCalled()
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'error', data: { code: 'protocol-required' }, to: ['player'] }
    ])
  })

  it('bounds pre-hydration ping work and ignores pings from players who are not present', async () => {
    const ready = deferred<void>()
    let timestamp = FIXED_NOW
    const { sent, protocol } = await createHarness({ ready: ready.promise, now: () => timestamp })
    const pings = Array.from({ length: 20 }, (_, seq) => protocol.handlePing({ seq }, '0xPlayer'))

    expect(sent).toEqual([])
    expect(protocol.resourceCounts().outstandingRequests).toBe(4)
    ready.resolve()
    await Promise.all(pings)

    expect(sent).toEqual([])
    expect(protocol.resourceCounts().outstandingRequests).toBe(0)
    expect(messagesOfType(sent, 'since')).toEqual([])
    expect(messagesOfType(sent, 'progress')).toEqual([])
    expect(messagesOfType(sent, 'audience')).toEqual([])
    expect(messagesOfType(sent, 'boards')).toEqual([])

    timestamp += 2_000
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

    await protocol.handleEnter('0xPlayer')
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
        revision: 0,
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

    await protocol.handleEnter('player')
    await protocol.handleHello({ displayName: 'Player', isGuest: false, protocolVersion: 999 }, 'player')

    expect(snapshotLook).not.toHaveBeenCalled()
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'error', data: { code: 'protocol-version' }, to: ['player'] }
    ])
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
        revision: 0,
        title: '',
        nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 }
      }
    ])
    expect(messagesOfType(sent, 'audience')).toHaveLength(1)
    expect(messagesOfType(sent, 'boards')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])
  })

  it('does not deliver an old welcome failure to a re-entered session', async () => {
    const firstLook = deferred<ReturnType<typeof makeLook> | null>()
    const secondLook = deferred<ReturnType<typeof makeLook> | null>()
    const snapshotLook = vi
      .fn<ServerProtocolOptions['snapshotLook']>()
      .mockReturnValueOnce(firstLook.promise)
      .mockReturnValueOnce(secondLook.promise)
    const { sent, protocol } = await createHarness({ snapshotLook })

    const firstEnter = negotiate(protocol, 'player')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledOnce())
    await protocol.handleLeave('player')
    const secondEnter = negotiate(protocol, 'player')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledTimes(2))
    firstLook.reject(new StorageUnavailableError(['player:stats']))
    await firstEnter
    secondLook.resolve(makeLook('player', 'Fresh Player'))
    await secondEnter

    expect(messagesOfType(sent, 'error')).toEqual([])
  })

  it.each(['playerTitle', 'audience', 'boards'] as const)(
    'stops an old welcome after a delayed %s send when the address re-enters',
    async (heldType) => {
      const sendGate = deferred<void>()
      let held = false
      const send = vi.fn<ProtocolSend>(async (type, _data, to) => {
        if (!held && type === heldType && to?.[0] === 'player') {
          held = true
          await sendGate.promise
        }
      })
      const { state, sent, protocol } = await createHarness({ send })
      state.upsertCharade(makeCharade('welcome-ghost', { guesses: { total: 2, correct: 0 } }))
      await negotiate(protocol, 'other')

      const firstWelcome = negotiate(protocol, 'player')
      await vi.waitFor(() => expect(held).toBe(true))
      await protocol.handleLeave('player')
      await negotiate(protocol, 'player')
      const messageCount = sent.length
      sendGate.resolve()
      await firstWelcome

      expect(sent).toHaveLength(messageCount)
      expect(messagesOfType(sent, 'error')).toEqual([])
    }
  )

  it('does not let a stale post mutate state after its session leaves', async () => {
    const postLook = deferred<ReturnType<typeof makeLook> | null>()
    const snapshotLook = vi
      .fn<ServerProtocolOptions['snapshotLook']>()
      .mockResolvedValueOnce(makeLook('player', 'Welcome'))
      .mockReturnValueOnce(postLook.promise)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    await negotiate(protocol, 'player')
    sent.length = 0

    const posting = protocol.handlePost(
      { requestId: 'stale-post', phraseId: DECK[0].id, emotes: [...DECK[0].suggested] },
      'player'
    )
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledTimes(2))
    await protocol.handleLeave('player')
    postLook.resolve(makeLook('player', 'Stale'))
    await posting

    expect(state.getPool()).toEqual([])
    expect(messagesOfType(sent, 'posted')).toEqual([])
  })

  it('releases session generations and request buckets after repeated guest churn', async () => {
    const snapshotLook = async (address: string) => ({ ...makeLook(address, address), isGuest: true })
    const { protocol } = await createHarness({ snapshotLook })

    for (let index = 0; index < 64; index += 1) {
      const address = `guest-${index}`
      await negotiate(protocol, address)
      await protocol.handleLeave(address)
    }

    expect(protocol.resourceCounts()).toMatchObject({
      present: 0,
      sessionGenerations: 0,
      completedRequests: 0,
      nextRequests: 0,
      outstandingRequests: 0,
      requestBuckets: 0
    })
  })

  it('cleans protocol and round state when leave persistence exceeds the dirty budget', async () => {
    const { repository, protocol } = await createHarness()
    await negotiate(protocol, 'player')
    await repository.flushNow()
    for (let index = 0; index < MAX_DIRTY_ENTRIES; index += 1) {
      repository.markDirty(`saturated-${index}`, { index })
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(protocol.handleLeave('player')).resolves.toBeUndefined()

    expect(protocol.resourceCounts()).toMatchObject({ present: 0, sessionGenerations: 0, requestBuckets: 0 })
    expect(protocol.rounds.hasPlayer('player')).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith('[storage] leave persistence failed', expect.any(StorageCapacityError))
    errorSpy.mockRestore()
  })

  it('normalizes authoritative player names and reserves first-party labels', async () => {
    const snapshotLook = async (address: string) => makeLook(address, '\u202eHOUSE GHOST\u202c')
    const { state, sent, protocol } = await createHarness({ snapshotLook })

    await negotiate(protocol, 'player')

    expect(state.recentVisitors[0].name).toBe('PLAYER')
    expect(JSON.stringify(sent)).not.toContain('\u202e')
    expect(JSON.stringify(sent)).not.toContain('\u202c')
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

  it('does not send rollover state to a session that leaves during a player-stats read', async () => {
    let timestamp = Date.UTC(2026, 7, 23, 23, 59, 59, 999)
    const { state, sent, protocol } = await createHarness({ now: () => timestamp })
    await negotiate(protocol, 'player')
    state.evictStats('player')
    const statsGate = deferred<ReturnType<typeof makeStats>>()
    const statsSpy = vi.spyOn(state, 'getOrCreateStats').mockReturnValueOnce(statsGate.promise)
    timestamp += 1
    sent.length = 0

    const ping = protocol.handlePing({ seq: 99 }, 'player')
    await vi.waitFor(() => expect(statsSpy).toHaveBeenCalledOnce())
    await protocol.handleLeave('player')
    statsGate.resolve(makeStats())
    await ping

    expect(sent).toEqual([])
  })
})

describe('charade serving and guesses', () => {
  it('rejects oversized identifiers and exclusion sets before constructing request state', async () => {
    const { sent, protocol } = await createHarness()
    await negotiate(protocol, 'player')
    sent.length = 0
    const oversized = 'x'.repeat(65)

    await protocol.handleNextCharade({ requestId: oversized, exclude: [] }, 'player')
    await protocol.handleNextCharade(
      { requestId: 'bounded', exclude: Array.from({ length: 21 }, (_, i) => `id-${i}`) },
      'player'
    )
    await protocol.handleNextCharade({ requestId: 'bounded-2', exclude: [oversized] }, 'player')
    await protocol.handleGuess({ requestId: oversized, charadeId: 'charade', answerIndex: 0 }, 'player')
    await protocol.handleGuess({ requestId: 'guess', charadeId: oversized, answerIndex: 0 }, 'player')
    await protocol.handlePost({ requestId: oversized, phraseId: DECK[0].id, emotes: [...DECK[0].suggested] }, 'player')

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-next-charade',
      'invalid-next-charade',
      'invalid-next-charade',
      'invalid-guess',
      'invalid-guess',
      'invalid-post'
    ])
    expect(messagesOfType(sent, 'charade')).toEqual([])
  })

  it('bounds and expires per-player next-charade selections', async () => {
    let timestamp = FIXED_NOW
    const { sent, protocol } = await createHarness({ now: () => timestamp })
    await negotiate(protocol, 'player')
    sent.length = 0

    await protocol.handleNextCharade({ requestId: 'oldest', exclude: [] }, 'player')
    const original = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!).id
    for (let index = 0; index < 33; index += 1) {
      timestamp += 1_000
      await protocol.handleNextCharade({ requestId: `fill-${index}`, exclude: [] }, 'player')
    }
    timestamp += 1_000
    await protocol.handleNextCharade({ requestId: 'oldest', exclude: [] }, 'player')
    const afterEviction = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!).id
    timestamp += 16_000
    await protocol.handleNextCharade({ requestId: 'oldest', exclude: [] }, 'player')
    const afterExpiry = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!).id

    expect(afterEviction).not.toBe(original)
    expect(afterExpiry).not.toBe(afterEviction)
    expect(messagesOfType(sent, 'error')).toEqual([])
  })

  it('bounds completed replay entries and consumes every served answer after one accepted guess', async () => {
    let timestamp = FIXED_NOW
    const { sent, protocol } = await createHarness({ now: () => timestamp })
    await negotiate(protocol, 'player')
    sent.length = 0

    await protocol.handleNextCharade({ requestId: 'first-next', exclude: [] }, 'player')
    const first = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const firstGuess = { requestId: 'oldest-guess', charadeId: first.id, answerIndex: 0 }
    await protocol.handleGuess(firstGuess, 'player')
    for (let index = 0; index < 33; index += 1) {
      timestamp += 1_000
      await protocol.handleNextCharade({ requestId: `next-${index}`, exclude: [] }, 'player')
      const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
      await protocol.handleGuess({ requestId: `guess-${index}`, charadeId: served.id, answerIndex: 0 }, 'player')
    }
    sent.length = 0

    await protocol.handleGuess(firstGuess, 'player')

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'error', data: { code: 'charade-not-served' }, to: ['player'] }
    ])
  })

  it('caps concurrent handlers per player while allowing admitted requests to finish', async () => {
    const gate = deferred<void>()
    const send = vi.fn<ProtocolSend>(async (type) => {
      if (type === 'charade') await gate.promise
    })
    const { sent, protocol } = await createHarness({ send })
    await negotiate(protocol, 'player')
    sent.length = 0
    send.mockClear()

    const admitted = Array.from({ length: 4 }, (_, index) =>
      protocol.handleNextCharade({ requestId: `pending-${index}`, exclude: [] }, 'player')
    )
    await vi.waitFor(() => expect(messagesOfType(sent, 'charade')).toHaveLength(4))
    await protocol.handleNextCharade({ requestId: 'rejected-fifth', exclude: [] }, 'player')

    expect(messagesOfType(sent, 'charade')).toHaveLength(4)
    expect(messagesOfType(sent, 'error')).toEqual([])
    gate.resolve()
    await Promise.all(admitted)
  })

  it('rate-limits sustained valid request traffic per player', async () => {
    let timestamp = FIXED_NOW
    const { sent, protocol } = await createHarness({ now: () => timestamp })
    await negotiate(protocol, 'player')
    timestamp += 2_000
    sent.length = 0

    for (let index = 0; index < 17; index += 1) {
      await protocol.handleNextCharade({ requestId: `burst-${index}`, exclude: [] }, 'player')
    }

    expect(messagesOfType(sent, 'charade')).toHaveLength(16)
    expect(messagesOfType(sent, 'error')).toEqual([])
  })

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

  it('does not send a charade reply from an old session after a delayed charade send', async () => {
    const sendGate = deferred<void>()
    let held = false
    const send = vi.fn<ProtocolSend>(async (type, _data, to) => {
      if (!held && type === 'charade' && to?.[0] === 'player') {
        held = true
        await sendGate.promise
      }
    })
    const { state, sent, protocol } = await createHarness({ send })
    state.upsertCharade(makeCharade('reply-stage', { reply: makeReply('replier', 'Replier') }))
    await negotiate(protocol, 'player')
    sent.length = 0

    const serving = protocol.handleNextCharade(nextCharadeRequest(), 'player')
    await vi.waitFor(() => expect(held).toBe(true))
    await protocol.handleLeave('player')
    await negotiate(protocol, 'player')
    const messageCount = sent.length
    sendGate.resolve()
    await serving

    expect(sent).toHaveLength(messageCount)
    expect(messagesOfType(sent, 'charadeReply')).toEqual([])
  })

  it('uses private answer entropy, records one guess, and replays a completed request without mutating twice', async () => {
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
    expect(secondServed.id).toBe(firstServed.id)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const answerIndex = secondServed.answers.indexOf(phrase.text)
    const answerPhrases = secondServed.answerIds.map((answerId) => DECK.find((candidate) => candidate.id === answerId))
    expect(answerPhrases.every((answerPhrase) => answerPhrase !== undefined)).toBe(true)
    expect(answerPhrases.map((answerPhrase) => answerPhrase!.text)).toEqual(secondServed.answers)
    expect(new Set(answerPhrases.map((answerPhrase) => answerPhrase!.category))).toEqual(new Set([phrase.category]))
    expect(new Set(answerPhrases.map((answerPhrase) => answerPhrase!.theme))).toEqual(new Set([phrase.theme]))
    expect(new Set(answerPhrases.map((answerPhrase) => [...answerPhrase!.suggested].sort().join(':'))).size).toBe(3)
    const publiclyRecovered = secondServed.answerIds.filter((candidateId) => {
      const candidate = DECK.find((entry) => entry.id === candidateId)!
      const decoys = pickDecoys(candidate.id, charade.emotes, DECK, charade.id)
      const ordered = shuffleSeeded([candidate, ...decoys], `${charade.id}:answers`).map((entry) => entry.id)
      return ordered.join('|') === secondServed.answerIds.join('|')
    })
    expect(publiclyRecovered).toEqual([])
    const guess = { charadeId: charade.id, answerIndex, requestId: 'guess-1' }
    sent.length = 0
    await protocol.handleGuess(guess, '0xPlayer')
    const firstReveal = messagesOfType(sent, 'reveal')[0]
    expect(firstReveal.data).toMatchObject({ requestId: 'guess-1', revision: 1 })
    await protocol.handleGuess(guess, '0xPlayer')

    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(messagesOfType(sent, 'reveal')[1].data).toEqual(firstReveal.data)
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
    expect(state.playerStats.get('0xplayer')).toMatchObject({ decoded: 1, correct: 1, seen: [charade.id] })
    expect(state.playerStats.get('0xauthor')?.pending).toEqual({ triedYou: 1, gotYou: 1, replies: 0, mail: 0 })
    expect(checkpoint).toHaveBeenCalledOnce()

    await protocol.handleGuess({ ...guess, requestId: 'guess-2' }, '0xPlayer')
    expect(dataOf<ErrorMessage>(messagesOfType(sent, 'error').at(-1)!).code).toBe('charade-not-served')
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

  it('does not deliver a stale checkpoint error after the same address re-enters', async () => {
    const checkpointGate = deferred<void>()
    let holdAndFail = false
    const flush = vi.fn(async () => {
      if (!holdAndFail) return
      await checkpointGate.promise
      throw new StorageUnavailableError(['scene:required'])
    })
    const { state, sent, protocol } = await createHarness({ flush })
    const charade = makeCharade('stale-checkpoint', { author: { address: 'author' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    holdAndFail = true

    const guessing = protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: served.answers.indexOf(phrase.text),
        requestId: 'stale-checkpoint-guess'
      },
      'player'
    )
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2))
    holdAndFail = false
    await protocol.handleLeave('player')
    await negotiate(protocol, 'player')
    sent.length = 0
    checkpointGate.resolve()
    await guessing

    expect(sent).toEqual([])
  })

  it('keeps a served guess retryable when the persistent author record is corrupt', async () => {
    const author = `0x${'a'.repeat(40)}`
    const decoder = `0x${'b'.repeat(40)}`
    const { storage, state, sent, protocol } = await createHarness()
    const charade = makeCharade('corrupt-guess-author', { author: { address: author, name: 'Author' } })
    state.upsertCharade(charade)
    storage.players.set(author, new Map([[PLAYER_STATS_KEY, '{']]))
    await negotiate(protocol, decoder)
    await protocol.handleNextCharade(nextCharadeRequest(), decoder)
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const guess = {
      charadeId: served.id,
      answerIndex: served.answers.indexOf(phrase.text),
      requestId: 'corrupt-author-guess'
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    sent.length = 0

    await protocol.handleGuess(guess, decoder)

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'storage-unavailable'
    ])
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(state.playerStats.get(decoder)?.seen).not.toContain(charade.id)

    storage.putPlayerJSON(author, PLAYER_STATS_KEY, makeStats({ name: 'Author' }))
    sent.length = 0
    await protocol.handleGuess(guess, decoder)
    errorSpy.mockRestore()

    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
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
      expect(served.id).toMatch(/^house-[a-f0-9]{16}$/u)
      expect(HOUSE_CHARADES.map((charade) => charade.id)).not.toContain(served.id)
      expect(state.getCharade(served.id)).toBeNull()
      await protocol.handleGuess(
        {
          charadeId: served.id,
          answerIndex: 0,
          requestId: `house-${attempt}`
        },
        'player'
      )
    }

    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.playerStats.get('player')).toMatchObject({ decoded: 0, correct: 0, seen: [] })
  })

  it('scores a five-ghost Show Set, prices Spotlight, and replays a guess without double-scoring', async () => {
    const { state, sent, protocol } = await createHarness()
    await negotiate(protocol, 'player')
    sent.length = 0

    const playHouseRound = async (correct: boolean, spotlight: boolean, requestId: string) => {
      await protocol.handleNextCharade(nextCharadeRequest(), 'player')
      const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
      const house = HOUSE_CHARADES.find((candidate) => candidate.emotes.join(':') === served.emotes.join(':'))!
      const correctIndex = served.answerIds.indexOf(house.phraseId)
      const guess = {
        charadeId: served.id,
        answerIndex: correct ? correctIndex : (correctIndex + 1) % served.answers.length,
        requestId,
        spotlight
      }
      await protocol.handleGuess(guess, 'player')
      return {
        guess,
        served,
        reveal: dataOf<Record<string, unknown>>(messagesOfType(sent, 'reveal').at(-1)!)
      }
    }

    const first = await playHouseRound(true, false, 'show-set-1')
    expect(first.served).toMatchObject({ setRound: 1, setSize: 5, setScore: 0, setStreak: 0, isFinale: false })
    expect(first.reveal).toMatchObject({
      spotlight: false,
      scoreDelta: 100,
      setRound: 1,
      setSize: 5,
      setScore: 100,
      setStreak: 1,
      setBestStreak: 1,
      setUnderstood: 1,
      setComplete: false,
      isFinale: false
    })
    await protocol.handleGuess({ ...first.guess, spotlight: true }, 'player')
    expect(dataOf<Record<string, unknown>>(messagesOfType(sent, 'reveal').at(-1)!)).toEqual(first.reveal)
    expect(state.playerStats.get('player')?.showSet).toEqual({
      round: 1,
      score: 100,
      streak: 1,
      bestStreak: 1,
      understood: 1
    })

    const second = await playHouseRound(true, true, 'show-set-2')
    expect(second.reveal).toMatchObject({ scoreDelta: 200, setRound: 2, setScore: 300, setStreak: 2 })
    const third = await playHouseRound(false, false, 'show-set-3')
    expect(third.reveal).toMatchObject({ scoreDelta: 0, setRound: 3, setScore: 300, setStreak: 0 })
    const fourth = await playHouseRound(false, true, 'show-set-4')
    expect(fourth.reveal).toMatchObject({ scoreDelta: -100, setRound: 4, setScore: 200, setStreak: 0 })
    const finale = await playHouseRound(true, false, 'show-set-5')
    expect(finale.served).toMatchObject({ setRound: 5, setSize: 5, setScore: 200, setStreak: 0, isFinale: true })
    expect(finale.reveal).toMatchObject({
      spotlight: false,
      scoreDelta: 100,
      setRound: 5,
      setSize: 5,
      setScore: 300,
      setStreak: 1,
      setBestStreak: 2,
      setUnderstood: 3,
      setComplete: true,
      isFinale: true
    })
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 0,
      correct: 0,
      seen: [],
      showSet: { round: 5, score: 300, streak: 1, bestStreak: 2, understood: 3 }
    })
    expect(state.boards).toEqual({ decoders: [], hardest: [] })

    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)).toMatchObject({
      setRound: 1,
      setSize: 5,
      setScore: 0,
      setStreak: 0,
      isFinale: false
    })
  })

  it('floors a Spotlight miss at zero and resumes an interrupted set after server sleep', async () => {
    const storage = new FakeStorage()
    const first = await createHarness({}, storage)
    await negotiate(first.protocol, 'player')
    first.sent.length = 0
    await first.protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(first.sent, 'charade').at(-1)!)
    const house = HOUSE_CHARADES.find((candidate) => candidate.emotes.join(':') === served.emotes.join(':'))!
    const correctIndex = served.answerIds.indexOf(house.phraseId)
    await first.protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: (correctIndex + 1) % served.answers.length,
        requestId: 'spotlight-floor',
        spotlight: true
      },
      'player'
    )

    expect(dataOf<Record<string, unknown>>(messagesOfType(first.sent, 'reveal').at(-1)!)).toMatchObject({
      scoreDelta: -100,
      setScore: 0,
      setRound: 1,
      setComplete: false
    })
    await first.repository.flushNow()

    const second = await createHarness({}, storage)
    await negotiate(second.protocol, 'player')
    second.sent.length = 0
    await second.protocol.handleNextCharade(nextCharadeRequest(), 'player')

    expect(dataOf<CharadeMessage>(messagesOfType(second.sent, 'charade').at(-1)!)).toMatchObject({
      setRound: 2,
      setSize: 5,
      setScore: 0,
      setStreak: 0,
      isFinale: false
    })
  })

  it('skips stored charades with unknown phrases and immediately serves an opaque house fallback', async () => {
    const { state, sent, protocol } = await createHarness()
    state.upsertCharade(makeCharade('invalid-stored', { phraseId: 'removed-phrase' }))
    await negotiate(protocol, 'player')
    sent.length = 0

    await protocol.handleNextCharade(nextCharadeRequest(), 'player')

    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    expect(served).toMatchObject({ isHouse: true })
    expect(served.id).not.toBe('invalid-stored')
    expect(messagesOfType(sent, 'error')).toEqual([])
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
  it('keeps guest guesses and authoring out of persistent global effects', async () => {
    const snapshotLook = async (address: string) => ({ ...makeLook(address, 'Guest'), isGuest: true })
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const charade = makeCharade('stable-charade', { author: { address: 'author', name: 'Author' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'guest-session')
    sent.length = 0

    await protocol.handleNextCharade(nextCharadeRequest(), 'guest-session')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    await protocol.handleGuess(
      {
        requestId: 'guest-guess',
        charadeId: served.id,
        answerIndex: served.answers.indexOf(phrase.text)
      },
      'guest-session'
    )
    await protocol.handlePost(
      { requestId: 'guest-post', phraseId: DECK[1].id, emotes: [...DECK[1].suggested] },
      'guest-session'
    )
    await protocol.handleReact({ kind: 'applause' }, 'guest-session')

    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(state.playerStats.get('guest-session')).toMatchObject({ decoded: 0, correct: 0, authoredCount: 0 })
    expect(state.playerStats.has('author')).toBe(false)
    expect(state.boards).toEqual({ decoders: [], hardest: [] })
    expect(state.getPool().map((entry) => entry.id)).toEqual([charade.id])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'post-guest',
      'reaction-guest'
    ])
  })

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

  it('returns server-busy without progression when the durable charade budget is full', async () => {
    const { state, sent, protocol } = await createHarness()
    for (let index = 0; index < 128; index += 1) {
      expect(
        state.upsertCharade(
          makeCharade(`capacity-${index}`, {
            author: { address: `author-${index}` },
            createdAt: FIXED_NOW + index
          })
        )
      ).toBe(true)
    }
    await negotiate(protocol, 'player')
    sent.length = 0

    await protocol.handlePost(
      { requestId: 'over-capacity', phraseId: DECK[0].id, emotes: [...DECK[0].suggested] },
      'player'
    )

    expect(messagesOfType(sent, 'posted')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([{ type: 'error', data: { code: 'server-busy' }, to: ['player'] }])
    expect(state.playerStats.get('player')).toMatchObject({ authored: [], authoredCount: 0, revision: 0 })
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
    const post = { phraseId: DECK[3].id, emotes: ['wave', 'wave', 'clap'], requestId: 'post-1' }

    await protocol.handlePost(post, '0xPlayer')
    const firstPosted = dataOf<PostedMessage>(messagesOfType(sent, 'posted')[0])
    expect(firstPosted).toMatchObject({ requestId: 'post-1', revision: 1 })
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

  it("never promotes a solo recipient's private mail into a shared live round", async () => {
    const observerAddress = `0x${'3'.repeat(40)}`
    const snapshotLook = async (address: string) =>
      makeLook(address, address === recipientAddress ? 'Recipient' : 'Observer')
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    await negotiate(protocol, recipientAddress)
    await protocol.handleNextCharade(nextCharadeRequest(), recipientAddress)
    const mail = makeCharade('private-live-cache', {
      author: { address: senderAddress, name: 'Sender' },
      recipient: recipientAddress
    })
    state.upsertCharade(mail)
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), recipientAddress)
    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)).toMatchObject({
      id: mail.id,
      recipient: recipientAddress
    })

    await negotiate(protocol, observerAddress)
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), observerAddress)

    const observerCharade = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    expect(observerCharade.id).not.toBe(mail.id)
    expect(observerCharade.recipient).toBeUndefined()
    expect(protocol.rounds.current?.charadeId).not.toBe(mail.id)
  })
  const otherAddress = `0x${'3'.repeat(40)}`

  it('loads recipient stats before mutation and never reports an undurable mail retry as successful', async () => {
    const storage = new FakeStorage()
    const snapshotLook = async (address: string) =>
      makeLook(address, address === senderAddress ? 'Sender' : 'Recipient')
    const harness = await createHarness({ snapshotLook }, storage)
    harness.state.recentVisitors = [{ ...makeLook(recipientAddress, 'Recipient'), lastSeenAt: FIXED_NOW }]
    await negotiate(harness.protocol, senderAddress)
    harness.sent.length = 0
    storage.players.set(recipientAddress, new Map([[PLAYER_STATS_KEY, '{']]))
    const post = {
      requestId: 'staged-mail',
      phraseId: DECK[0].id,
      emotes: [...DECK[0].suggested],
      recipient: recipientAddress
    }

    await harness.protocol.handlePost(post, senderAddress)

    expect(harness.state.getPlayerCharades()).toEqual([])
    expect(harness.state.playerStats.get(senderAddress)).toMatchObject({ authoredCount: 0, revision: 0 })
    expect(messagesOfType(harness.sent, 'posted')).toEqual([])
    expect(messagesOfType(harness.sent, 'error')).toEqual([
      { type: 'error', data: { code: 'storage-unavailable' }, to: [senderAddress] }
    ])

    storage.putPlayerJSON(recipientAddress, PLAYER_STATS_KEY, makeStats({ name: 'Recipient' }))
    harness.sent.length = 0
    await harness.protocol.handlePost(post, senderAddress)

    expect(messagesOfType(harness.sent, 'posted')).toHaveLength(1)
    expect(harness.state.getPlayerCharades()).toHaveLength(1)
  })

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
    expect(first.state.playerStats.get(senderAddress)).toMatchObject({
      authored: [],
      authoredCount: 0,
      revision: 0,
      daily: { authored: 0, stamped: false },
      title: ''
    })
    expect(posted).toMatchObject({ stampAwarded: false, revision: 0, titleUnlocked: false })
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
    expect(recipientVisit.state.playerStats.get(recipientAddress)).toMatchObject({
      decoded: 0,
      correct: 0,
      revision: 0,
      daily: { decoded: 0, stamped: false }
    })
    expect(recipientVisit.state.getCharade(mailId)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(recipientVisit.state.boards.decoders).toEqual([])
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

  it('keeps an answer-back retryable when the persistent author record is corrupt', async () => {
    const author = `0x${'a'.repeat(40)}`
    const replier = `0x${'b'.repeat(40)}`
    const { storage, state, sent, protocol } = await createHarness()
    const target = makeCharade('corrupt-reply-author', { author: { address: author, name: 'Author' } })
    state.upsertCharade(target)
    storage.players.set(author, new Map([[PLAYER_STATS_KEY, '{']]))
    await negotiate(protocol, replier)
    state.playerStats.get(replier)!.seen.push(target.id)
    const reply = {
      phraseId: target.phraseId,
      emotes: [...DECK[0].suggested],
      requestId: 'corrupt-author-reply',
      replyTo: target.id
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    sent.length = 0

    await protocol.handlePost(reply, replier)

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'storage-unavailable'
    ])
    expect(messagesOfType(sent, 'posted')).toEqual([])
    expect(state.getCharade(target.id)?.reply).toBeUndefined()

    storage.putPlayerJSON(author, PLAYER_STATS_KEY, makeStats({ name: 'Author' }))
    sent.length = 0
    await protocol.handlePost(reply, replier)
    errorSpy.mockRestore()

    expect(messagesOfType(sent, 'posted')).toHaveLength(1)
    expect(state.getCharade(target.id)?.reply?.address).toBe(replier)
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
    const firstEmotes = ['wave', 'wave', 'clap']

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
  it('relays every valid reaction only to other present players', async () => {
    let timestamp = FIXED_NOW
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook, now: () => timestamp })
    state.upsertCharade(makeCharade('reaction-live', { author: { address: 'outside' } }))
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await negotiate(protocol, 'carol')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'carol')
    const bobCharade = dataOf<CharadeMessage>(
      messagesOfType(sent, 'charade').find((message) => message.to?.includes('bob'))!
    )
    const bobPhraseId = state.getCharade(bobCharade.id)!.phraseId
    await protocol.handleRoundGuess(
      {
        charadeId: bobCharade.id,
        answerIndex: (bobCharade.answerIds.indexOf(bobPhraseId) + 1) % 3,
        requestId: 'bob-spectates'
      },
      'bob'
    )
    sent.length = 0

    for (const kind of ['laugh', 'gasp', 'applause']) {
      await protocol.handleReact({ kind }, 'bob')
      timestamp += 1_000
    }

    expect(messagesOfType(sent, 'react').map((message) => message.data)).toEqual([
      { kind: 'laugh' },
      { kind: 'gasp' },
      { kind: 'applause' }
    ])
    expect(messagesOfType(sent, 'react').every((message) => message.to?.join(',') === 'alice,carol')).toBe(true)
    expect(messagesOfType(sent, 'react').every((message) => !message.to?.includes('bob'))).toBe(true)
  })

  it('rate-limits reactions per address without sleeps', async () => {
    let timestamp = FIXED_NOW
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook, now: () => timestamp })
    state.upsertCharade(makeCharade('reaction-rate-live', { author: { address: 'outside' } }))
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await negotiate(protocol, 'carol')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'carol')
    const aliceCharade = dataOf<CharadeMessage>(
      messagesOfType(sent, 'charade').find((message) => message.to?.includes('alice'))!
    )
    const alicePhraseId = state.getCharade(aliceCharade.id)!.phraseId
    await protocol.handleRoundGuess(
      {
        charadeId: aliceCharade.id,
        answerIndex: (aliceCharade.answerIds.indexOf(alicePhraseId) + 1) % 3,
        requestId: 'alice-spectates'
      },
      'alice'
    )
    sent.length = 0

    await protocol.handleReact({ kind: 'applause' }, 'alice')
    await protocol.handleReact({ kind: 'gasp' }, 'alice')
    await protocol.handleReact({ kind: 'laugh' }, 'bob')
    timestamp += 999
    await protocol.handleReact({ kind: 'laugh' }, 'alice')
    timestamp += 1
    await protocol.handleReact({ kind: 'laugh' }, 'alice')

    expect(messagesOfType(sent, 'react')).toEqual([
      { type: 'react', data: { kind: 'applause' }, to: ['bob', 'carol'] },
      { type: 'react', data: { kind: 'laugh' }, to: ['alice', 'carol'] },
      { type: 'react', data: { kind: 'laugh' }, to: ['bob', 'carol'] }
    ])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'error', data: { code: 'reaction-rate-limited' }, to: ['alice'] },
      { type: 'error', data: { code: 'reaction-rate-limited' }, to: ['alice'] }
    ])
  })

  it('does not relay malformed or ineligible reaction requests', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { sent, protocol } = await createHarness({ snapshotLook })
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    sent.length = 0

    await protocol.handleReact({ kind: 'invalid' }, 'alice')
    await protocol.handleReact({ kind: 'applause' }, 'not-present')

    expect(messagesOfType(sent, 'react')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'error', data: { code: 'invalid-reaction' }, to: ['alice'] },
      { type: 'error', data: { code: 'protocol-required' }, to: ['not-present'] }
    ])
  })

  it('leaves the active decode and reveal state unchanged', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const charade = makeCharade('reaction-stage', { author: { address: 'outside', name: 'Outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const beforeRound = protocol.rounds.current
    const beforeGuesses = { ...state.getCharade(charade.id)!.guesses }
    sent.length = 0

    await protocol.handleReact({ kind: 'applause' }, 'alice')

    expect(protocol.rounds.current).toEqual(beforeRound)
    expect(state.getCharade(charade.id)?.guesses).toEqual(beforeGuesses)
    expect(messagesOfType(sent, 'roundStart')).toEqual([])
    expect(messagesOfType(sent, 'roundWinner')).toEqual([])
    expect(messagesOfType(sent, 'reveal')).toEqual([])

    await protocol.handleRoundGuess(
      {
        charadeId: charade.id,
        answerIndex: served.answers.indexOf(phrase.text),
        requestId: 'reaction-safe-guess'
      },
      'alice'
    )

    expect(messagesOfType(sent, 'roundWinner')).toEqual([
      {
        type: 'roundWinner',
        data: { roundId: '1', charadeId: charade.id, address: 'alice', name: 'Alice' },
        to: undefined
      }
    ])
    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
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
      { type: 'roundStart', data: { roundId: '1', charadeId: charade.id }, to: undefined }
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
      {
        type: 'roundWinner',
        data: { roundId: '1', charadeId: charade.id, address: 'alice', name: 'Alice' },
        to: undefined
      }
    ])
    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(protocol.rounds.current?.winner).toEqual({ address: 'alice', name: 'Alice' })
  })

  it('reveals house guesses without awarding a deterministic live-round winner', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    sent.length = 0

    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const firstHouse = HOUSE_CHARADES.find((charade) => charade.emotes.join(':') === served.emotes.join(':'))!
    const firstCorrect = served.answerIds.indexOf(firstHouse.phraseId)
    await protocol.handleRoundGuess(
      { charadeId: served.id, answerIndex: firstCorrect, requestId: 'alice-first' },
      'alice'
    )
    await protocol.handleRoundGuess({ charadeId: served.id, answerIndex: 1, requestId: 'bob-first' }, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest([served.id]), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest([served.id]), 'bob')
    const nextServed = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    sent.length = 0

    await protocol.handleRoundGuess({ charadeId: nextServed.id, answerIndex: 0, requestId: 'bob-second' }, 'bob')
    await protocol.handleRoundGuess({ charadeId: nextServed.id, answerIndex: 1, requestId: 'alice-second' }, 'alice')

    expect(nextServed.id).not.toBe(served.id)
    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(messagesOfType(sent, 'roundWinner')).toEqual([])
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

  it('reselects a solo charade already guessed before a second player starts the round', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const first = makeCharade('solo-first', { author: { address: 'outside-a' }, createdAt: FIXED_NOW - 2 })
    const second = makeCharade('solo-second', { author: { address: 'outside-b' }, createdAt: FIXED_NOW - 1 })
    state.upsertCharade(first)
    state.upsertCharade(second)
    await negotiate(protocol, 'alice')
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    const solo = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const phrase = DECK.find((candidate) => candidate.id === first.phraseId)!
    await protocol.handleGuess(
      {
        charadeId: solo.id,
        answerIndex: solo.answers.indexOf(phrase.text),
        requestId: 'solo-guess'
      },
      'alice'
    )

    await negotiate(protocol, 'bob')
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')

    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0]).id).toBe(second.id)
    expect(protocol.rounds.current?.charadeId).toBe(second.id)
    expect(messagesOfType(sent, 'roundStart')).toEqual([
      { type: 'roundStart', data: { roundId: '1', charadeId: second.id }, to: undefined }
    ])
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
      charade: 2_569,
      mailCharade: 2_626,
      charadeReply: 2_278,
      since: 244,
      boards: 3_049,
      ready: 110,
      inlineCharade: 4_819
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
