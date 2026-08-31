import { describe, expect, it, vi } from 'vitest'
import { EMOTE_STEP_SECONDS, PROTOCOL_VERSION, themeForTimestamp } from '../src/shared/config'
import {
  authorBeatChoices,
  canonicalPerformance,
  DECK,
  EMOTE_VOCABULARY,
  HOUSE_CHARADE,
  HOUSE_CHARADES,
  PLAYABLE_DECK,
  playablePhrase
} from '../src/shared/deck'
import { pickDecoys, shuffleSeeded } from '../src/shared/pick'
import { showPolicyForTimestamp } from '../src/shared/show-policy'
import { SEASON_ZERO_WEEKS } from '../src/shared/seasons'
import {
  createServerProtocol,
  runServerHandler,
  type ProtocolSend,
  type ServerProtocolOptions
} from '../src/server/server'
import {
  DURABLE_MUTATION_JOURNAL_KEY,
  GhostlightState,
  MAX_DAILY_DECODERS,
  MAX_DURABLE_COMPLETIONS,
  MAX_DURABLE_JOURNAL_BYTES,
  dayKey,
  type DurableMutation
} from '../src/server/state'
import {
  MAX_DIRTY_ENTRIES,
  MAX_STORAGE_VALUE_BYTES,
  PLAYER_STATS_KEY,
  RECENT_VISITORS_KEY,
  StorageCapacityError,
  StorageUnavailableError,
  decoderAggregateKey,
  createStorageRepository
} from '../src/server/storage'
import {
  FIXED_NOW,
  FakeStorage,
  deferred,
  makeCharade as makeStoredCharade,
  makeLook,
  makeReply as makeStoredReply,
  makeStats
} from './test-helpers'

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
type RetryMessage = {
  requestId: string
  charadeId: string
  removedAnswerIndex: number
  replayBeatIndex: number
}
type PostedMessage = { requestId: string; charadeId: string; replyTo?: string; revision: number }

type CharadeReplyMessage = ReturnType<typeof makeReply> & {
  charadeId: string
}

function messagesOfType(sent: SentMessage[], type: string) {
  return sent.filter((message) =>
    type === 'error' ? message.type === 'error' || message.type === 'requestError' : message.type === type
  )
}

function dataOf<T>(message: SentMessage): T {
  return message.data as T
}

let nextRequestSequence = 0
const TEST_PHRASE = PLAYABLE_DECK[0]
const TEST_PERFORMANCE = canonicalPerformance(TEST_PHRASE)!

function makeCharade(
  id: Parameters<typeof makeStoredCharade>[0],
  overrides: Parameters<typeof makeStoredCharade>[1] = {}
) {
  const phrase = playablePhrase(overrides.phraseId ?? '') ?? PLAYABLE_DECK[0]
  return makeStoredCharade(id, {
    phraseId: phrase.id,
    emotes: canonicalPerformance(phrase)!,
    ...overrides
  })
}

function makeReply(
  address?: Parameters<typeof makeStoredReply>[0],
  name?: Parameters<typeof makeStoredReply>[1],
  overrides: Parameters<typeof makeStoredReply>[2] = {}
) {
  return makeStoredReply(address, name, { emotes: TEST_PERFORMANCE, ...overrides })
}

function nextCharadeRequest(exclude: string[] = []) {
  return { requestId: `next-${++nextRequestSequence}`, exclude }
}

async function negotiate(protocol: ReturnType<typeof createServerProtocol>, address: string) {
  await protocol.handleEnter(address)
  return protocol.handleHello({ displayName: address, isGuest: false, protocolVersion: PROTOCOL_VERSION }, address)
}

async function handleCurrentRoundGuess(
  protocol: ReturnType<typeof createServerProtocol>,
  data: { charadeId: string; answerIndex: number; requestId: string; spotlight?: boolean },
  address: string
) {
  const roundId = protocol.rounds.current?.roundId
  if (!roundId) throw new Error('Expected an active round')
  return protocol.handleRoundGuess({ roundId, ...data }, address)
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
      | 'firstGuessDelayMilliseconds'
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
  const rawProtocol = createServerProtocol({
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
    roundDurationMilliseconds: overrides.roundDurationMilliseconds,
    firstGuessDelayMilliseconds: overrides.firstGuessDelayMilliseconds ?? 0
  })
  const protocol = {
    ...rawProtocol,
    handlePost: (data: Parameters<typeof rawProtocol.handlePost>[0], address: string) =>
      rawProtocol.handlePost({ touringConsent: false, ...data }, address)
  }
  return { storage, repository, state, sent, snapshotLook, checkpoint, protocol, rawProtocol }
}

function degradedStorage() {
  const storage = new FakeStorage()
  storage.getErrors.add(DURABLE_MUTATION_JOURNAL_KEY)
  storage.getValuesErrors.add(DURABLE_MUTATION_JOURNAL_KEY)
  return storage
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

function servedPhraseId(state: GhostlightState, served: CharadeMessage) {
  return (
    state.getCharade(served.id)?.phraseId ??
    HOUSE_CHARADES.find((charade) => charade.emotes.join(':') === served.emotes.join(':'))?.phraseId
  )
}

function correctAnswerIndex(state: GhostlightState, served: CharadeMessage) {
  return served.answerIds.indexOf(servedPhraseId(state, served)!)
}

function wrongAnswerIndexes(state: GhostlightState, served: CharadeMessage) {
  const correctIndex = correctAnswerIndex(state, served)
  return served.answerIds.map((_answerId, index) => index).filter((index) => index !== correctIndex)
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

  it('never attempts storage recovery for traffic from a non-present address', async () => {
    const storage = degradedStorage()
    const { state, protocol } = await createHarness({}, storage)
    const recoverStorage = vi.spyOn(state, 'recoverStorage').mockResolvedValue(false)

    await protocol.handleHello({ displayName: 'Absent', isGuest: false, protocolVersion: PROTOCOL_VERSION }, 'absent')
    await protocol.handlePing({ seq: 1 }, 'absent')
    await protocol.handleNextCharade({ requestId: 'absent-next', exclude: [] }, 'absent')
    await protocol.handleGuess({ requestId: 'absent-guess', charadeId: 'absent-charade', answerIndex: 0 }, 'absent')
    await protocol.handlePost(
      { requestId: 'absent-post', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE },
      'absent'
    )
    await protocol.handleReact({ kind: 'applause' }, 'absent')

    expect(state.isReadOnly).toBe(true)
    expect(recoverStorage).not.toHaveBeenCalled()
  })

  it('does not pong a present player before successful hello negotiation', async () => {
    const { sent, protocol } = await createHarness()
    await protocol.handleEnter('player')
    sent.length = 0

    await protocol.handlePing({ seq: 1 }, 'player')

    expect(messagesOfType(sent, 'pong')).toEqual([])
    await protocol.handleHello({ displayName: 'Player', isGuest: false, protocolVersion: PROTOCOL_VERSION }, 'player')
    sent.length = 0
    await protocol.handlePing({ seq: 2 }, 'player')
    expect(messagesOfType(sent, 'pong')).toEqual([{ type: 'pong', data: { seq: 2 }, to: ['player'] }])
  })

  it('does not run an admitted request against a re-entered session after delayed recovery', async () => {
    const storage = degradedStorage()
    const { state, sent, protocol } = await createHarness({}, storage)
    await negotiate(protocol, 'player')
    const recovery = deferred<boolean>()
    const recoverStorage = vi
      .spyOn(state, 'recoverStorage')
      .mockReturnValueOnce(recovery.promise)
      .mockResolvedValue(false)
    sent.length = 0

    const stalePing = protocol.handlePing({ seq: 1 }, 'player')
    await vi.waitFor(() => expect(recoverStorage).toHaveBeenCalledOnce())
    await protocol.handleLeave('player')
    await negotiate(protocol, 'player')
    sent.length = 0
    recovery.resolve(false)
    await stalePing

    expect(messagesOfType(sent, 'pong')).toEqual([])
  })

  it('caps repeated present heartbeat recovery at the global backoff schedule', async () => {
    let timestamp = FIXED_NOW
    const storage = degradedStorage()
    const { state, protocol } = await createHarness({ now: () => timestamp }, storage)
    await negotiate(protocol, 'player')
    expect(state.isReadOnly).toBe(true)
    storage.sceneGets.length = 0

    for (let ping = 0; ping < 8; ping += 1) await protocol.handlePing({ seq: ping }, 'player')
    expect(storage.sceneGets.filter((key) => key === DURABLE_MUTATION_JOURNAL_KEY)).toHaveLength(0)

    let expectedAttempts = 0
    for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      timestamp += delay
      for (let ping = 0; ping < 8; ping += 1) {
        await protocol.handlePing({ seq: expectedAttempts * 10 + ping }, 'player')
      }
      expectedAttempts += 1
      expect(storage.sceneGets.filter((key) => key === DURABLE_MUTATION_JOURNAL_KEY)).toHaveLength(expectedAttempts * 3)
    }
  })

  it('keeps degraded players in waking mode until a recovery probe restores authoritative play', async () => {
    let timestamp = FIXED_NOW
    const storage = degradedStorage()
    const { state, sent, protocol } = await createHarness({ now: () => timestamp }, storage)
    await protocol.handleEnter('player')
    expect(protocol.resourceCounts().present).toBe(1)
    expect(messagesOfType(sent, 'ready')).toEqual([])

    await protocol.handleHello({ displayName: 'Player', isGuest: false, protocolVersion: PROTOCOL_VERSION }, 'player')
    await protocol.handlePing({ seq: 1 }, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')

    expect(state.isReadOnly).toBe(true)
    expect(messagesOfType(sent, 'ready')).toEqual([])
    expect(messagesOfType(sent, 'showSchedule')).toEqual([])
    expect(messagesOfType(sent, 'pong')).toEqual([])
    expect(messagesOfType(sent, 'progress')).toEqual([])
    expect(messagesOfType(sent, 'boards')).toEqual([])
    expect(messagesOfType(sent, 'charade')).toEqual([])
    expect(state.playerStats.size).toBe(0)

    storage.getErrors.clear()
    storage.getValuesErrors.clear()
    timestamp += 2_000
    sent.length = 0
    await protocol.handleHello({ displayName: 'Player', isGuest: false, protocolVersion: PROTOCOL_VERSION }, 'player')

    expect(state.isReadOnly).toBe(false)
    expect(messagesOfType(sent, 'ready')).toHaveLength(1)
    expect(messagesOfType(sent, 'showSchedule')).toHaveLength(1)
    expect(messagesOfType(sent, 'progress')).toHaveLength(1)
    expect(messagesOfType(sent, 'boards')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])

    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    expect(served.isHouse).toBe(true)

    const finalGuess = {
      requestId: 'recovered-house-guess',
      charadeId: served.id,
      answerIndex: correctAnswerIndex(state, served)
    }
    sent.length = 0
    await protocol.handleGuess(finalGuess, 'player')
    const reveal = messagesOfType(sent, 'reveal').at(-1)!.data
    await protocol.handleGuess(finalGuess, 'player')

    expect(messagesOfType(sent, 'reveal').map((message) => message.data)).toEqual([reveal, reveal])
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.playerStats.get('player')).toMatchObject({ decoded: 1, correct: 1, revision: 1 })
    expect(state.boards).toEqual({ decoders: [], hardest: [] })
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

  it('rejects the previous protocol version without reading a look', async () => {
    const snapshotLook = vi.fn(async () => makeLook('player'))
    const { sent, protocol } = await createHarness({ snapshotLook })

    await protocol.handleEnter('player')
    await protocol.handleHello({ displayName: 'Player', isGuest: false, protocolVersion: 3 }, 'player')

    expect(snapshotLook).not.toHaveBeenCalled()
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'error', data: { code: 'protocol-version' }, to: ['player'] }
    ])
    expect(messagesOfType(sent, 'showSchedule')).toEqual([])
  })

  it('sends only readiness on enter and gates every stateful action until a valid hello', async () => {
    const snapshotLook = vi.fn(async () => makeLook('player'))
    const { state, sent, protocol } = await createHarness({ snapshotLook })

    await protocol.handleEnter('player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    await protocol.handlePost(
      { phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE, requestId: 'blocked-post' },
      'player'
    )
    await protocol.handleReact({ kind: 'genius' }, 'player')

    expect(messagesOfType(sent, 'ready')).toHaveLength(1)
    expect(messagesOfType(sent, 'showSchedule')).toEqual([])
    expect(messagesOfType(sent, 'progress')).toEqual([])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'protocol-required',
      'protocol-required',
      'protocol-required'
    ])
    expect(snapshotLook).not.toHaveBeenCalled()
    expect(state.getPool()).toEqual([])
  })

  it('announces exact canonical Season Zero metadata at every half-open week boundary', async () => {
    for (const week of SEASON_ZERO_WEEKS) {
      for (const timestamp of [week.eligibility.startsAt, week.eligibility.endsAt - 1]) {
        const { sent, protocol } = await createHarness({ now: () => timestamp })

        await protocol.handleEnter('player')
        expect(messagesOfType(sent, 'showSchedule')).toEqual([])
        await protocol.handleHello(
          { displayName: 'Player', isGuest: false, protocolVersion: PROTOCOL_VERSION },
          'player'
        )

        expect(messagesOfType(sent, 'showSchedule').map((message) => message.data)).toEqual([
          {
            instanceId: 'test-instance',
            serverTime: timestamp,
            showKey: `season-zero:${week.id}`,
            season: {
              id: 'season-zero',
              weekId: week.id,
              startsAt: week.eligibility.startsAt,
              endsAt: week.eligibility.endsAt,
              titleId: week.title.id,
              propId: week.prop.id,
              finale: {
                id: week.finale.id,
                startsAt: week.finale.window.startsAt,
                endsAt: week.finale.window.endsAt
              }
            }
          }
        ])
      }
    }

    const timestamp = SEASON_ZERO_WEEKS.at(-1)!.eligibility.endsAt
    const { sent, protocol } = await createHarness({ now: () => timestamp })
    await negotiate(protocol, 'player')

    expect(messagesOfType(sent, 'showSchedule').map((message) => message.data)).toEqual([
      {
        instanceId: 'test-instance',
        serverTime: timestamp,
        showKey: `daily:${new Date(timestamp).toISOString().slice(0, 10)}`
      }
    ])
  })

  it('pairs ready and show schedule with one timestamp after hello and UTC rollover', async () => {
    let timestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt
    let advanceOnReady = false
    const { sent, protocol } = await createHarness({
      now: () => timestamp,
      send: async (type) => {
        if (advanceOnReady && type === 'ready') timestamp += 1
      }
    })

    await protocol.handleEnter('player')
    expect(messagesOfType(sent, 'showSchedule')).toEqual([])
    advanceOnReady = true
    await protocol.handleHello({ displayName: 'Player', isGuest: false, protocolVersion: PROTOCOL_VERSION }, 'player')

    const helloReadyIndex = sent.findIndex((message, index) => index > 0 && message.type === 'ready')
    expect(sent[helloReadyIndex + 1].type).toBe('showSchedule')
    expect(dataOf<{ serverTime: number }>(sent[helloReadyIndex]).serverTime).toBe(
      dataOf<{ serverTime: number }>(sent[helloReadyIndex + 1]).serverTime
    )

    advanceOnReady = false
    timestamp = SEASON_ZERO_WEEKS[1].eligibility.startsAt
    sent.length = 0
    advanceOnReady = true
    await protocol.handlePing({ seq: 77 }, 'player')

    const rolloverReadyIndex = sent.findIndex((message) => message.type === 'ready')
    expect(sent[rolloverReadyIndex + 1].type).toBe('showSchedule')
    expect(dataOf<{ serverTime: number }>(sent[rolloverReadyIndex]).serverTime).toBe(
      dataOf<{ serverTime: number }>(sent[rolloverReadyIndex + 1]).serverTime
    )
  })

  it('sends one schedule pair when the negotiating hello itself triggers rollover', async () => {
    let timestamp = SEASON_ZERO_WEEKS[0].eligibility.endsAt - 1
    const { sent, protocol } = await createHarness({ now: () => timestamp })
    await protocol.handleEnter('player')
    sent.length = 0
    timestamp = SEASON_ZERO_WEEKS[1].eligibility.startsAt

    await protocol.handleHello({ displayName: 'Player', isGuest: false, protocolVersion: PROTOCOL_VERSION }, 'player')

    expect(messagesOfType(sent, 'ready')).toHaveLength(1)
    expect(messagesOfType(sent, 'showSchedule')).toHaveLength(1)
    expect(messagesOfType(sent, 'showSchedule')[0].data).toMatchObject({
      serverTime: timestamp,
      showKey: `season-zero:${SEASON_ZERO_WEEKS[1].id}`
    })
  })

  it('replays the canonical schedule on a negotiated heartbeat so a dropped announcement recovers', async () => {
    let timestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt + 1_000
    const { sent, protocol } = await createHarness({ now: () => timestamp })
    await negotiate(protocol, 'player')
    sent.length = 0
    timestamp += 10_000

    await protocol.handlePing({ seq: 79 }, 'player')

    expect(sent.map((message) => message.type)).toEqual(['pong', 'showSchedule'])
    expect(messagesOfType(sent, 'showSchedule').map((message) => message.data)).toEqual([
      expect.objectContaining({
        serverTime: timestamp,
        showKey: `season-zero:${SEASON_ZERO_WEEKS[0].id}`,
        season: expect.objectContaining({ weekId: SEASON_ZERO_WEEKS[0].id })
      })
    ])
  })

  it('replays a participant round after the heartbeat schedule so a dropped rollover schedule recovers', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const charade = makeCharade('heartbeat-round', { author: { address: 'outside', name: 'Outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    sent.length = 0

    await protocol.handlePing({ seq: 80 }, 'alice')

    expect(sent.map((message) => message.type)).toEqual(['pong', 'showSchedule', 'roundStart'])
    expect(messagesOfType(sent, 'roundStart')).toEqual([
      {
        type: 'roundStart',
        data: {
          instanceId: 'test-instance',
          roundId: '1',
          charadeId: charade.id,
          showKey: 'daily:2026-08-23'
        },
        to: ['alice']
      }
    ])
  })

  it('drains a later rollover request after an in-flight rollover before pairing its schedule', async () => {
    let timestamp = SEASON_ZERO_WEEKS[0].eligibility.endsAt - 1
    let blockRollover = false
    let blocked = false
    const rolloverStarted = deferred<void>()
    const releaseRollover = deferred<void>()
    const { sent, state, protocol } = await createHarness({
      now: () => timestamp,
      flush: async () => {
        if (!blockRollover || blocked) return
        blocked = true
        rolloverStarted.resolve()
        await releaseRollover.promise
      }
    })
    await negotiate(protocol, 'first')
    await negotiate(protocol, 'second')
    sent.length = 0

    blockRollover = true
    timestamp = SEASON_ZERO_WEEKS[1].eligibility.startsAt
    const firstRollover = protocol.handlePing({ seq: 80 }, 'first')
    await rolloverStarted.promise
    timestamp = SEASON_ZERO_WEEKS[2].eligibility.startsAt
    const laterRollover = protocol.handlePing({ seq: 81 }, 'second')
    releaseRollover.resolve()
    await Promise.all([firstRollover, laterRollover])

    const secondSchedule = messagesOfType(sent, 'showSchedule').findLast((message) => message.to?.[0] === 'second')
    expect(secondSchedule?.data).toMatchObject({
      serverTime: timestamp,
      showKey: `season-zero:${SEASON_ZERO_WEEKS[2].id}`,
      season: expect.objectContaining({ weekId: SEASON_ZERO_WEEKS[2].id })
    })
    expect(state.playerStats.get('second')?.showSet?.showKey).toBe(`season-zero:${SEASON_ZERO_WEEKS[2].id}`)
  })

  it('updates a negotiated session whose authoritative look is still pending at rollover', async () => {
    let timestamp = SEASON_ZERO_WEEKS[0].eligibility.endsAt - 1
    const pendingLook = deferred<ReturnType<typeof makeLook> | null>()
    const snapshotLook = vi.fn((address: string) =>
      address === 'pending' ? pendingLook.promise : Promise.resolve(makeLook(address, address))
    )
    const { sent, protocol } = await createHarness({ now: () => timestamp, snapshotLook })
    await negotiate(protocol, 'trigger')
    sent.length = 0

    const pendingNegotiation = negotiate(protocol, 'pending')
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledWith('pending'))
    sent.length = 0
    timestamp = SEASON_ZERO_WEEKS[1].eligibility.startsAt
    await protocol.handlePing({ seq: 78 }, 'trigger')
    const pendingSchedules = messagesOfType(sent, 'showSchedule').filter((message) => message.to?.[0] === 'pending')
    pendingLook.resolve(makeLook('pending', 'Pending'))
    await pendingNegotiation

    expect(pendingSchedules.map((message) => message.data)).toEqual([
      expect.objectContaining({
        serverTime: timestamp,
        showKey: `season-zero:${SEASON_ZERO_WEEKS[1].id}`,
        season: expect.objectContaining({ weekId: SEASON_ZERO_WEEKS[1].id })
      })
    ])
  })

  it('announces an empty fail-closed schedule when no active show policy is valid', async () => {
    const timestamp = -1
    const { sent, protocol } = await createHarness({ now: () => timestamp })

    await negotiate(protocol, 'player')

    expect(messagesOfType(sent, 'showSchedule').map((message) => message.data)).toEqual([
      { instanceId: 'test-instance', serverTime: timestamp, showKey: '' }
    ])
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
      { requestId: 'stale-post', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE },
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

  it('coalesces reconnect leave churn behind a slow checkpoint without starving mutations', async () => {
    const checkpointStarted = deferred<void>()
    const checkpointGate = deferred<void>()
    let holdCheckpoint = false
    let aliceLookSequence = 0
    const snapshotLook = vi.fn(async (address: string) =>
      makeLook(address, address === 'alice' ? `Alice ${++aliceLookSequence}` : 'Bob')
    )
    const { storage, repository, state, sent, checkpoint, protocol } = await createHarness({
      snapshotLook,
      flush: async () => {
        if (!holdCheckpoint) return
        checkpointStarted.resolve()
        await checkpointGate.promise
      }
    })
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    checkpoint.mockClear()
    holdCheckpoint = true

    const firstLeave = protocol.handleLeave('alice')
    await checkpointStarted.promise
    const secondNegotiation = negotiate(protocol, 'alice')
    await vi.waitFor(() => expect(protocol.mutationQueueDepth()).toBe(2))
    await protocol.handleLeave('alice')
    const thirdNegotiation = negotiate(protocol, 'alice')
    await vi.waitFor(() => expect(protocol.mutationQueueDepth()).toBe(3))
    await protocol.handleLeave('alice')
    const posting = protocol.handlePost(
      { requestId: 'post-after-leave-churn', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE },
      'bob'
    )
    await Promise.resolve()
    expect(messagesOfType(sent, 'posted')).toEqual([])

    checkpointGate.resolve()
    await Promise.all([firstLeave, secondNegotiation, thirdNegotiation, posting])
    await vi.waitFor(() => {
      expect(checkpoint).toHaveBeenCalledTimes(3)
      expect(protocol.mutationQueueDepth()).toBe(0)
    })
    await repository.flushNow()

    expect(messagesOfType(sent, 'posted')).toEqual([
      expect.objectContaining({
        to: ['bob'],
        data: expect.objectContaining({ requestId: 'post-after-leave-churn' })
      })
    ])
    expect(state.recentVisitors[0]).toMatchObject({ address: 'alice', name: 'Alice 3' })
    expect(storage.readJSON<Array<{ address: string; name: string }>>(RECENT_VISITORS_KEY)).toEqual(
      expect.arrayContaining([expect.objectContaining({ address: 'alice', name: 'Alice 3' })])
    )
    expect(storage.readPlayerJSON<{ name: string }>('alice', PLAYER_STATS_KEY)).toMatchObject({ name: 'Alice 3' })
    expect(protocol.resourceCounts()).toMatchObject({ present: 1, sessionGenerations: 1 })
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
    const beforePhrase = PLAYABLE_DECK.find((phrase) => phrase.theme === before.id)!
    const afterPhrase = PLAYABLE_DECK.find((phrase) => phrase.theme === after.id)!
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

  it('queues a midnight rollover behind a healthy durable guess commit', async () => {
    let timestamp = Date.UTC(2026, 7, 23, 23, 59, 59, 999)
    const checkpointGate = deferred<void>()
    let blockNextCheckpoint = false
    const flush = vi.fn(async () => {
      if (!blockNextCheckpoint) return
      blockNextCheckpoint = false
      await checkpointGate.promise
    })
    const { state, sent, protocol } = await createHarness({ now: () => timestamp, flush })
    const charade = makeCharade('rollover-queued-guess', { author: { address: 'author' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    blockNextCheckpoint = true
    const flushCount = flush.mock.calls.length
    const guessing = protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: correctAnswerIndex(state, served),
        requestId: 'rollover-queued-guess-request'
      },
      'player'
    )
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(flushCount + 1))

    timestamp += 1
    let pingCompleted = false
    const pinging = protocol.handlePing({ seq: 99 }, 'player').then(() => {
      pingCompleted = true
    })
    await Promise.resolve()

    expect(pingCompleted).toBe(false)
    expect(
      messagesOfType(sent, 'error').filter((message) => dataOf<ErrorMessage>(message).code === 'storage-unavailable')
    ).toEqual([])

    checkpointGate.resolve()
    await Promise.all([guessing, pinging])

    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(
      messagesOfType(sent, 'error').filter((message) => dataOf<ErrorMessage>(message).code === 'storage-unavailable')
    ).toEqual([])
    expect(dataOf<{ serverTime: number }>(messagesOfType(sent, 'ready').at(-1)!)).toMatchObject({
      serverTime: timestamp
    })
  })

  it('revalidates a queued guess inside the mutation lane when midnight passes behind another commit', async () => {
    let timestamp = Date.UTC(2026, 7, 23, 23, 59, 59, 999)
    const checkpointStarted = deferred<void>()
    const checkpointGate = deferred<void>()
    let holdCheckpoint = false
    const policy = showPolicyForTimestamp(timestamp)!
    const phrase = PLAYABLE_DECK.find((candidate) => policy.primaryPhraseIds.includes(candidate.id))!
    const { state, sent, protocol } = await createHarness({
      now: () => timestamp,
      flush: async () => {
        if (!holdCheckpoint) return
        checkpointStarted.resolve()
        await checkpointGate.promise
      }
    })
    const target = makeCharade('queued-midnight-guess', {
      phraseId: phrase.id,
      author: { address: 'outside', name: 'Outside' }
    })
    state.upsertCharade(target)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await negotiate(protocol, 'observer')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    holdCheckpoint = true
    const blocking = protocol.handlePost(
      { requestId: 'midnight-guess-blocker', phraseId: phrase.id, emotes: canonicalPerformance(phrase)! },
      'alice'
    )
    await checkpointStarted.promise
    sent.length = 0

    const guessing = protocol.handleGuess(
      {
        requestId: 'queued-before-midnight-guess',
        charadeId: served.id,
        answerIndex: correctAnswerIndex(state, served)
      },
      'bob'
    )
    await vi.waitFor(() => expect(protocol.mutationQueueDepth()).toBe(2))
    timestamp += 1
    let rolloverCompleted = false
    const rollingOver = protocol.handlePing({ seq: 103 }, 'observer').then(() => {
      rolloverCompleted = true
    })
    await vi.waitFor(() => expect(protocol.mutationQueueDepth()).toBe(3))
    expect(rolloverCompleted).toBe(false)
    checkpointGate.resolve()
    await Promise.all([blocking, guessing, rollingOver])

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'charade-not-served', requestId: 'queued-before-midnight-guess' },
        to: ['bob']
      }
    ])
    expect(state.getCharade(target.id)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(state.playerStats.get('bob')).toMatchObject({ decoded: 0, correct: 0, revision: 0 })
  })

  it('revalidates a queued post inside the mutation lane when the show changes at midnight', async () => {
    const firstWeek = SEASON_ZERO_WEEKS[0]
    const secondWeek = SEASON_ZERO_WEEKS[1]
    let timestamp = firstWeek.eligibility.endsAt - 1
    const firstPolicy = showPolicyForTimestamp(timestamp)!
    const secondPolicy = showPolicyForTimestamp(secondWeek.eligibility.startsAt)!
    const oldPhrase = PLAYABLE_DECK.find(
      (phrase) => firstPolicy.primaryPhraseIds.includes(phrase.id) && !secondPolicy.primaryPhraseIds.includes(phrase.id)
    )!
    const checkpointStarted = deferred<void>()
    const checkpointGate = deferred<void>()
    let holdCheckpoint = false
    const { state, sent, protocol } = await createHarness({
      now: () => timestamp,
      flush: async () => {
        if (!holdCheckpoint) return
        checkpointStarted.resolve()
        await checkpointGate.promise
      }
    })
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await negotiate(protocol, 'observer')
    holdCheckpoint = true
    const blocking = protocol.handlePost(
      { requestId: 'midnight-post-blocker', phraseId: oldPhrase.id, emotes: canonicalPerformance(oldPhrase)! },
      'alice'
    )
    await checkpointStarted.promise
    sent.length = 0

    const queued = protocol.handlePost(
      { requestId: 'queued-before-midnight-post', phraseId: oldPhrase.id, emotes: canonicalPerformance(oldPhrase)! },
      'bob'
    )
    await vi.waitFor(() => expect(protocol.mutationQueueDepth()).toBe(2))
    timestamp = secondWeek.eligibility.startsAt
    let rolloverCompleted = false
    const rollingOver = protocol.handlePing({ seq: 104 }, 'observer').then(() => {
      rolloverCompleted = true
    })
    await vi.waitFor(() => expect(protocol.mutationQueueDepth()).toBe(3))
    expect(rolloverCompleted).toBe(false)
    checkpointGate.resolve()
    await Promise.all([blocking, queued, rollingOver])

    expect(messagesOfType(sent, 'posted').filter((message) => message.to?.[0] === 'bob')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-post', requestId: 'queued-before-midnight-post' },
        to: ['bob']
      }
    ])
    expect(state.getPlayerCharades().filter((charade) => charade.author.address.toLowerCase() === 'bob')).toEqual([])
    expect(state.playerStats.get('bob')).toMatchObject({ authoredCount: 0, revision: 0 })
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

describe('active Season Zero show enforcement', () => {
  it('rejects off-policy public, mail, and reply authoring without mutation while allowing an in-policy post', async () => {
    const timestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt + 1_000
    const policy = showPolicyForTimestamp(timestamp)
    expect(policy?.kind).toBe('season-zero')
    if (!policy || policy.kind !== 'season-zero') throw new Error('Expected an active Season Zero policy')
    const allowedPhrase = PLAYABLE_DECK.find((phrase) => policy.primaryPhraseIds.includes(phrase.id))!
    const offPolicyPhrase = DECK.find((phrase) => !policy.primaryPhraseIds.includes(phrase.id))!
    const sender = `0x${'1'.repeat(40)}`
    const recipient = `0x${'2'.repeat(40)}`
    const replier = `0x${'3'.repeat(40)}`
    const priorAuthor = `0x${'4'.repeat(40)}`
    const snapshotLook = vi.fn(async (address: string) => makeLook(address, address))
    const {
      repository,
      state,
      sent,
      snapshotLook: snapshot,
      checkpoint,
      protocol
    } = await createHarness({
      now: () => timestamp,
      snapshotLook
    })
    state.recentVisitors = [{ ...makeLook(recipient, 'Recipient'), lastSeenAt: timestamp }]
    await negotiate(protocol, sender)
    await negotiate(protocol, replier)
    const target = makeCharade('off-policy-reply-target', {
      phraseId: offPolicyPhrase.id,
      author: { address: priorAuthor, name: 'Prior Author' },
      createdAt: timestamp - 1
    })
    state.upsertCharade(target)
    state.playerStats.get(replier)!.seen.push(target.id)
    const senderBefore = structuredClone(state.playerStats.get(sender))
    const replierBefore = structuredClone(state.playerStats.get(replier))
    const charadesBefore = structuredClone(state.getPlayerCharades())
    const dirtyBefore = repository.getDirtyKeys()
    sent.length = 0
    snapshot.mockClear()
    checkpoint.mockClear()

    await protocol.handlePost(
      {
        requestId: 'off-policy-public',
        phraseId: offPolicyPhrase.id,
        emotes: [...offPolicyPhrase.suggested]
      },
      sender
    )
    await protocol.handlePost(
      {
        requestId: 'off-policy-mail',
        phraseId: offPolicyPhrase.id,
        emotes: [...offPolicyPhrase.suggested],
        recipient
      },
      sender
    )
    await protocol.handlePost(
      {
        requestId: 'off-policy-reply',
        phraseId: offPolicyPhrase.id,
        emotes: [...offPolicyPhrase.suggested],
        replyTo: target.id
      },
      replier
    )

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-post',
      'invalid-post',
      'invalid-reply'
    ])
    expect(messagesOfType(sent, 'posted')).toEqual([])
    expect(state.getPlayerCharades()).toEqual(charadesBefore)
    expect(state.getCharade(target.id)?.reply).toBeUndefined()
    expect(state.playerStats.get(sender)).toEqual(senderBefore)
    expect(state.playerStats.get(replier)).toEqual(replierBefore)
    expect(state.playerStats.has(recipient)).toBe(false)
    expect(repository.getDirtyKeys()).toEqual(dirtyBefore)
    expect(snapshot).not.toHaveBeenCalled()
    expect(checkpoint).not.toHaveBeenCalled()

    sent.length = 0
    await protocol.handlePost(
      { requestId: 'in-policy-public', phraseId: allowedPhrase.id, emotes: canonicalPerformance(allowedPhrase)! },
      sender
    )

    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(messagesOfType(sent, 'posted')).toHaveLength(1)
    const authored = state.getPool().filter((charade) => charade.id !== target.id)
    expect(authored).toEqual([expect.objectContaining({ phraseId: allowedPhrase.id })])
    expect(authored[0].recipient).toBeUndefined()
    expect(state.playerStats.get(sender)).toMatchObject({ authoredCount: 1, revision: 1 })
  })

  it('does not persist an old-week phrase when its fresh-look snapshot crosses the show boundary', async () => {
    const firstWeek = SEASON_ZERO_WEEKS[0]
    const secondWeek = SEASON_ZERO_WEEKS[1]
    let timestamp = firstWeek.eligibility.endsAt - 1
    const firstPolicy = showPolicyForTimestamp(timestamp)
    const secondPolicy = showPolicyForTimestamp(secondWeek.eligibility.startsAt)
    expect(firstPolicy?.kind).toBe('season-zero')
    expect(secondPolicy?.kind).toBe('season-zero')
    if (!firstPolicy || firstPolicy.kind !== 'season-zero' || !secondPolicy || secondPolicy.kind !== 'season-zero') {
      throw new Error('Expected adjacent active Season Zero policies')
    }
    const oldWeekPhrase = PLAYABLE_DECK.find((phrase) => firstPolicy.primaryPhraseIds.includes(phrase.id))!
    const lookGate = deferred<ReturnType<typeof makeLook> | null>()
    const snapshotLook = vi
      .fn<ServerProtocolOptions['snapshotLook']>()
      .mockResolvedValueOnce(makeLook('player', 'Player'))
      .mockReturnValueOnce(lookGate.promise)
    const { state, sent, checkpoint, protocol } = await createHarness({ now: () => timestamp, snapshotLook })
    await negotiate(protocol, 'player')
    const statsBefore = structuredClone(state.playerStats.get('player'))
    sent.length = 0
    checkpoint.mockClear()

    const posting = protocol.handlePost(
      { requestId: 'cross-week-post', phraseId: oldWeekPhrase.id, emotes: canonicalPerformance(oldWeekPhrase)! },
      'player'
    )
    await vi.waitFor(() => expect(snapshotLook).toHaveBeenCalledTimes(2))
    timestamp = secondWeek.eligibility.startsAt
    lookGate.resolve(makeLook('player', 'Boundary Player'))
    await posting

    expect(messagesOfType(sent, 'posted')).toEqual([])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual(['invalid-post'])
    expect(state.getPlayerCharades()).toEqual([])
    expect(state.playerStats.get('player')).toMatchObject({
      authored: statsBefore!.authored,
      authoredCount: statsBefore!.authoredCount,
      revision: statsBefore!.revision,
      daily: {
        decoded: statsBefore!.daily.decoded,
        authored: statsBefore!.daily.authored,
        stamped: statsBefore!.daily.stamped
      }
    })
    expect(checkpoint).toHaveBeenCalledTimes(2)
  })

  it('counts and delivers only in-policy mail without deleting older off-policy mail', async () => {
    const timestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt
    const policy = showPolicyForTimestamp(timestamp)
    expect(policy?.kind).toBe('season-zero')
    if (!policy || policy.kind !== 'season-zero') throw new Error('Expected an active Season Zero policy')
    const recipient = `0x${'2'.repeat(40)}`
    const allowedPhraseId = PLAYABLE_DECK.find((phrase) => policy.primaryPhraseIds.includes(phrase.id))!.id
    const offPolicyPhraseId = DECK.find((phrase) => !policy.primaryPhraseIds.includes(phrase.id))!.id
    const { state, sent, protocol } = await createHarness({ now: () => timestamp })
    const offPolicyMail = makeCharade('older-off-policy-mail', {
      phraseId: offPolicyPhraseId,
      recipient,
      createdAt: timestamp - 2
    })
    const allowedMail = makeCharade('active-policy-mail', {
      phraseId: allowedPhraseId,
      recipient,
      createdAt: timestamp - 1
    })
    state.upsertCharade(offPolicyMail)
    state.upsertCharade(allowedMail)

    await negotiate(protocol, recipient)

    expect(messagesOfType(sent, 'since').map((message) => message.data)).toEqual([expect.objectContaining({ mail: 1 })])
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), recipient)

    expect(dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!).id).toBe(allowedMail.id)
    expect(state.getCharade(offPolicyMail.id)).toEqual(offPolicyMail)
  })

  it('recomputes an eligible mail count when welcome persistence crosses a show boundary', async () => {
    const firstWeek = SEASON_ZERO_WEEKS[0]
    const secondWeek = SEASON_ZERO_WEEKS[1]
    let timestamp = firstWeek.eligibility.endsAt - 1
    const firstPolicy = showPolicyForTimestamp(timestamp)
    const secondPolicy = showPolicyForTimestamp(secondWeek.eligibility.startsAt)
    expect(firstPolicy?.kind).toBe('season-zero')
    expect(secondPolicy?.kind).toBe('season-zero')
    if (!firstPolicy || firstPolicy.kind !== 'season-zero' || !secondPolicy || secondPolicy.kind !== 'season-zero') {
      throw new Error('Expected adjacent active Season Zero policies')
    }
    const firstOnlyPhraseId = PLAYABLE_DECK.find((phrase) => firstPolicy.primaryPhraseIds.includes(phrase.id))!.id
    const recipient = `0x${'5'.repeat(40)}`
    const welcomeCheckpointStarted = deferred<void>()
    const welcomeCheckpointGate = deferred<void>()
    let flushCalls = 0
    const { state, sent, protocol } = await createHarness({
      now: () => timestamp,
      flush: async () => {
        flushCalls += 1
        if (flushCalls === 2) {
          welcomeCheckpointStarted.resolve()
          await welcomeCheckpointGate.promise
        }
      }
    })
    state.upsertCharade(
      makeCharade('old-show-welcome-mail', {
        phraseId: firstOnlyPhraseId,
        recipient,
        createdAt: timestamp
      })
    )
    await negotiate(protocol, 'rollover-player')
    sent.length = 0

    const welcoming = negotiate(protocol, recipient)
    await welcomeCheckpointStarted.promise
    timestamp = secondWeek.eligibility.startsAt
    let pingCompleted = false
    const pinging = protocol.handlePing({ seq: 101 }, 'rollover-player').then(() => {
      pingCompleted = true
    })
    await Promise.resolve()
    expect(pingCompleted).toBe(false)
    welcomeCheckpointGate.resolve()
    await Promise.all([welcoming, pinging])

    expect(messagesOfType(sent, 'since').filter((message) => message.to?.[0] === recipient)).toEqual([
      { type: 'since', data: expect.objectContaining({ mail: 1 }), to: [recipient] }
    ])
    expect(state.playerStats.get(recipient)?.showSet?.showKey).toBe(`season-zero:${secondWeek.id}`)
  })

  it('recomputes an eligible mail count when the welcome progress send crosses a show boundary', async () => {
    const firstWeek = SEASON_ZERO_WEEKS[0]
    const secondWeek = SEASON_ZERO_WEEKS[1]
    let timestamp = firstWeek.eligibility.endsAt - 1
    const firstPolicy = showPolicyForTimestamp(timestamp)
    const secondPolicy = showPolicyForTimestamp(secondWeek.eligibility.startsAt)
    expect(firstPolicy?.kind).toBe('season-zero')
    expect(secondPolicy?.kind).toBe('season-zero')
    if (!firstPolicy || firstPolicy.kind !== 'season-zero' || !secondPolicy || secondPolicy.kind !== 'season-zero') {
      throw new Error('Expected adjacent active Season Zero policies')
    }
    const firstOnlyPhraseId = PLAYABLE_DECK.find((phrase) => firstPolicy.primaryPhraseIds.includes(phrase.id))!.id
    const recipient = `0x${'6'.repeat(40)}`
    const progressSendStarted = deferred<void>()
    const progressSendGate = deferred<void>()
    let blockedProgress = false
    const { state, sent, protocol } = await createHarness({
      now: () => timestamp,
      send: async (type, _data, to) => {
        if (!blockedProgress && type === 'progress' && to?.[0] === recipient) {
          blockedProgress = true
          progressSendStarted.resolve()
          await progressSendGate.promise
        }
      }
    })
    state.upsertCharade(
      makeCharade('old-show-progress-mail', {
        phraseId: firstOnlyPhraseId,
        recipient,
        createdAt: timestamp
      })
    )
    await negotiate(protocol, 'rollover-player')
    sent.length = 0

    const welcoming = negotiate(protocol, recipient)
    await progressSendStarted.promise
    timestamp = secondWeek.eligibility.startsAt
    await protocol.handlePing({ seq: 102 }, 'rollover-player')
    progressSendGate.resolve()
    await welcoming

    expect(messagesOfType(sent, 'since').filter((message) => message.to?.[0] === recipient)).toEqual([
      { type: 'since', data: expect.objectContaining({ mail: 1 }), to: [recipient] }
    ])
    expect(state.playerStats.get(recipient)?.showSet?.showKey).toBe(`season-zero:${secondWeek.id}`)
  })

  it('does not replay an unresolved retry after the active show changes', async () => {
    const firstWeek = SEASON_ZERO_WEEKS[0]
    const secondWeek = SEASON_ZERO_WEEKS[1]
    let timestamp = firstWeek.eligibility.endsAt - 1
    const firstPolicy = showPolicyForTimestamp(timestamp)!
    const { state, sent, protocol } = await createHarness({ now: () => timestamp })
    const charade = makeCharade('pre-boundary-retry', {
      phraseId: PLAYABLE_DECK.find((phrase) => firstPolicy.primaryPhraseIds.includes(phrase.id))!.id,
      author: { address: 'outside-author' },
      createdAt: timestamp
    })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const firstMiss = {
      charadeId: served.id,
      answerIndex: wrongAnswerIndexes(state, served)[0],
      requestId: 'pre-boundary-first-miss'
    }
    sent.length = 0

    await protocol.handleGuess(firstMiss, 'player')
    expect(messagesOfType(sent, 'retry')).toHaveLength(1)

    timestamp = secondWeek.eligibility.startsAt
    sent.length = 0
    await protocol.handleGuess(firstMiss, 'player')

    expect(messagesOfType(sent, 'retry')).toEqual([])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'charade-not-served'
    ])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
  })

  it('does not finish an in-flight solo guess after another request rolls the show forward', async () => {
    const firstWeek = SEASON_ZERO_WEEKS[0]
    const secondWeek = SEASON_ZERO_WEEKS[1]
    let timestamp = firstWeek.eligibility.endsAt - 1
    const firstPolicy = showPolicyForTimestamp(timestamp)!
    const { state, sent, protocol } = await createHarness({ now: () => timestamp })
    const charade = makeCharade('pre-boundary-in-flight-guess', {
      phraseId: PLAYABLE_DECK.find((phrase) => firstPolicy.primaryPhraseIds.includes(phrase.id))!.id,
      author: { address: 'outside-author' },
      createdAt: timestamp
    })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const authorStarted = deferred<void>()
    const authorGate = deferred<void>()
    const getOrCreateStats = state.getOrCreateStats.bind(state)
    vi.spyOn(state, 'getOrCreateStats').mockImplementation(async (address, name, persistent) => {
      if (address === 'outside-author') {
        authorStarted.resolve()
        await authorGate.promise
      }
      return getOrCreateStats(address, name, persistent)
    })
    sent.length = 0

    const guessing = protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: correctAnswerIndex(state, served),
        requestId: 'pre-boundary-in-flight-guess'
      },
      'player'
    )
    await authorStarted.promise
    timestamp = secondWeek.eligibility.startsAt
    await protocol.handlePing({ seq: 99 }, 'player')
    authorGate.resolve()
    await guessing

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-guess'
    ])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 0,
      correct: 0,
      showSet: { showKey: `season-zero:${secondWeek.id}`, round: 0 }
    })
  })

  it('rolls the show when a guess prerequisite crosses the week boundary without another handler', async () => {
    const firstWeek = SEASON_ZERO_WEEKS[0]
    const secondWeek = SEASON_ZERO_WEEKS[1]
    let timestamp = firstWeek.eligibility.endsAt - 1
    const firstPolicy = showPolicyForTimestamp(timestamp)!
    const { state, sent, protocol } = await createHarness({ now: () => timestamp })
    const charade = makeCharade('pre-boundary-player-prerequisite', {
      phraseId: PLAYABLE_DECK.find((phrase) => firstPolicy.primaryPhraseIds.includes(phrase.id))!.id,
      author: { address: 'outside-author' },
      createdAt: timestamp
    })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const guess = {
      charadeId: served.id,
      answerIndex: wrongAnswerIndexes(state, served)[0],
      requestId: 'pre-boundary-player-prerequisite'
    }
    const playerStatsStarted = deferred<void>()
    const playerStatsGate = deferred<void>()
    const getOrCreateStats = state.getOrCreateStats.bind(state)
    let blockedPlayerStats = false
    vi.spyOn(state, 'getOrCreateStats').mockImplementation(async (address, name, persistent) => {
      if (!blockedPlayerStats && address.toLowerCase() === 'player') {
        blockedPlayerStats = true
        playerStatsStarted.resolve()
        await playerStatsGate.promise
      }
      return getOrCreateStats(address, name, persistent)
    })
    sent.length = 0

    const guessing = protocol.handleGuess(guess, 'player')
    await playerStatsStarted.promise
    timestamp = secondWeek.eligibility.startsAt
    playerStatsGate.resolve()
    await guessing

    expect(messagesOfType(sent, 'retry')).toEqual([])
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    const requestErrors = messagesOfType(sent, 'requestError')
    expect(requestErrors).toHaveLength(1)
    expect(dataOf<{ code: string; requestId: string }>(requestErrors[0])).toMatchObject({
      requestId: guess.requestId
    })
    expect(['invalid-guess', 'charade-not-served']).toContain(dataOf<{ code: string }>(requestErrors[0]).code)
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 0,
      correct: 0,
      showSet: { showKey: `season-zero:${secondWeek.id}`, round: 0 }
    })
    expect(protocol.resourceCounts()).toMatchObject({
      servedAnswers: 0,
      retryStates: 0,
      activeDecoders: 0,
      nextRequests: 0
    })
  })

  it("serves every active week primary with only that week's reviewed answers", async () => {
    const primaryViolations: string[] = []
    const decoyViolations: string[] = []

    for (const week of SEASON_ZERO_WEEKS) {
      let timestamp = week.eligibility.startsAt + 1_000
      const policy = showPolicyForTimestamp(timestamp)
      expect(policy?.kind).toBe('season-zero')
      if (!policy || policy.kind !== 'season-zero') throw new Error(`Expected an active policy for ${week.id}`)
      const allowedPrimaries = new Set<string>(policy.primaryPhraseIds)
      const allowedDecoys = new Set<string>(policy.decoyPhraseIds)
      const playablePrimaryIds = policy.primaryPhraseIds.filter((phraseId) => playablePhrase(phraseId) !== null)
      const primaryHarness = await createHarness({ now: () => timestamp })
      const offPolicyPhrase =
        DECK.find((phrase) => !allowedPrimaries.has(phrase.id) && phrase.theme === themeForTimestamp(timestamp).id) ??
        DECK.find((phrase) => !allowedPrimaries.has(phrase.id))!

      primaryHarness.state.upsertCharade(
        makeCharade(`${week.id}-off-policy-primary`, {
          phraseId: offPolicyPhrase.id,
          author: { address: `${week.id}-off-policy-author` },
          createdAt: timestamp - 1
        })
      )

      playablePrimaryIds.forEach((phraseId, index) => {
        primaryHarness.state.upsertCharade(
          makeCharade(`${week.id}-primary-${index}`, {
            phraseId,
            author: { address: `${week.id}-author-${index}` },
            createdAt: timestamp + index
          })
        )
      })
      await negotiate(primaryHarness.protocol, `${week.id}-decoder`)
      primaryHarness.sent.length = 0

      const servedPrimaries = new Set<string>()
      for (let index = 0; index < playablePrimaryIds.length; index += 1) {
        timestamp += 250
        await primaryHarness.protocol.handleNextCharade(
          { requestId: `${week.id}-primary-next-${index}`, exclude: [] },
          `${week.id}-decoder`
        )
        const served = dataOf<CharadeMessage>(messagesOfType(primaryHarness.sent, 'charade').at(-1)!)
        const phraseId = servedPhraseId(primaryHarness.state, served)
        if (!phraseId || !allowedPrimaries.has(phraseId)) primaryViolations.push(`${week.id}:${phraseId ?? 'unknown'}`)
        for (const answerId of served.answerIds) {
          if (!allowedDecoys.has(answerId)) decoyViolations.push(`${week.id}:${answerId}`)
        }
        if (phraseId) servedPrimaries.add(phraseId)
        await primaryHarness.protocol.handleGuess(
          {
            charadeId: served.id,
            answerIndex: correctAnswerIndex(primaryHarness.state, served),
            requestId: `${week.id}-primary-guess-${index}`
          },
          `${week.id}-decoder`
        )
      }

      expect.soft([...servedPrimaries].sort()).toEqual([...playablePrimaryIds].sort())
    }

    expect.soft(primaryViolations).toEqual([])
    expect.soft(decoyViolations).toEqual([])
  })

  it("serves only each active week's reviewed House fallbacks and answers", async () => {
    const houseViolations: string[] = []
    const decoyViolations: string[] = []

    for (const week of SEASON_ZERO_WEEKS) {
      const timestamp = week.eligibility.startsAt + 1_000
      const policy = showPolicyForTimestamp(timestamp)
      expect(policy?.kind).toBe('season-zero')
      if (!policy || policy.kind !== 'season-zero') throw new Error(`Expected an active policy for ${week.id}`)
      const allowedDecoys = new Set<string>(policy.decoyPhraseIds)
      const allowedHouse = new Set<string>(policy.housePhraseIds)
      const houseHarness = await createHarness({ now: () => timestamp })
      for (let index = 0; index < HOUSE_CHARADES.length * 2; index += 1) {
        const address = `${week.id}-house-decoder-${index}`
        await negotiate(houseHarness.protocol, address)
        houseHarness.sent.length = 0
        await houseHarness.protocol.handleNextCharade(
          { requestId: `${week.id}-house-next-${index}`, exclude: [] },
          address
        )
        const served = dataOf<CharadeMessage>(messagesOfType(houseHarness.sent, 'charade').at(-1)!)
        const phraseId = servedPhraseId(houseHarness.state, served)
        if (!phraseId || !allowedHouse.has(phraseId)) houseViolations.push(`${week.id}:${phraseId ?? 'unknown'}`)
        for (const answerId of served.answerIds) {
          if (!allowedDecoys.has(answerId)) decoyViolations.push(`${week.id}:${answerId}`)
        }
        await houseHarness.protocol.handleLeave(address)
      }
    }

    expect.soft(houseViolations).toEqual([])
    expect.soft(decoyViolations).toEqual([])
  })

  it('invalidates volatile serving and round state at a show boundary but keeps completed replay', async () => {
    const firstWeek = SEASON_ZERO_WEEKS[0]
    const secondWeek = SEASON_ZERO_WEEKS[1]
    let timestamp = firstWeek.eligibility.endsAt - 1
    const firstPolicy = showPolicyForTimestamp(timestamp)
    const secondPolicy = showPolicyForTimestamp(secondWeek.eligibility.startsAt)
    expect(firstPolicy?.kind).toBe('season-zero')
    expect(secondPolicy?.kind).toBe('season-zero')
    if (!firstPolicy || firstPolicy.kind !== 'season-zero' || !secondPolicy || secondPolicy.kind !== 'season-zero') {
      throw new Error('Expected adjacent active Season Zero policies')
    }
    const firstPhraseId = PLAYABLE_DECK.find((phrase) => firstPolicy.primaryPhraseIds.includes(phrase.id))!.id
    const secondPhraseId = PLAYABLE_DECK.find(
      (phrase) => secondPolicy.primaryPhraseIds.includes(phrase.id) && phrase.id !== firstPhraseId
    )!.id
    const snapshotLook = async (address: string) => makeLook(address, address)
    const { state, sent, protocol } = await createHarness({ snapshotLook, now: () => timestamp })
    const firstCharade = makeCharade('pre-boundary-charade', {
      phraseId: firstPhraseId,
      author: { address: 'outside-first' },
      createdAt: timestamp - 1
    })
    state.upsertCharade(firstCharade)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    sent.length = 0
    const aliceNext = { requestId: 'alice-pre-boundary-next', exclude: [] as string[] }
    const bobNext = { requestId: 'bob-pre-boundary-next', exclude: [] as string[] }
    await protocol.handleNextCharade(aliceNext, 'alice')
    await protocol.handleNextCharade(bobNext, 'bob')
    const aliceServed = dataOf<CharadeMessage>(
      messagesOfType(sent, 'charade').find((message) => message.to?.[0] === 'alice')!
    )
    const oldRoundId = protocol.rounds.current!.roundId
    const completedGuess = {
      roundId: oldRoundId,
      charadeId: aliceServed.id,
      answerIndex: correctAnswerIndex(state, aliceServed),
      requestId: 'alice-pre-boundary-guess'
    }
    await protocol.handleRoundGuess(completedGuess, 'alice')
    const completedReveal = dataOf<Record<string, unknown>>(messagesOfType(sent, 'reveal').at(-1)!)
    const guessesAfterCompletion = { ...state.getCharade(firstCharade.id)!.guesses }
    const secondCharade = makeCharade('post-boundary-charade', {
      phraseId: secondPhraseId,
      author: { address: 'outside-second' },
      createdAt: timestamp
    })
    state.upsertCharade(secondCharade)

    timestamp = secondWeek.eligibility.startsAt
    sent.length = 0
    await protocol.handleRoundGuess(completedGuess, 'alice')
    expect(messagesOfType(sent, 'reveal').map((message) => message.data)).toEqual([completedReveal])
    expect(state.getCharade(firstCharade.id)?.guesses).toEqual(guessesAfterCompletion)

    sent.length = 0
    await protocol.handleNextCharade(bobNext, 'bob')
    const afterBoundary = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    expect(afterBoundary.id).toBe(secondCharade.id)
    expect(servedPhraseId(state, afterBoundary)).toBe(secondPhraseId)
    expect(protocol.rounds.current?.charadeId).toBe(secondCharade.id)

    sent.length = 0
    await protocol.handleRoundGuess(
      {
        roundId: oldRoundId,
        charadeId: firstCharade.id,
        answerIndex: correctAnswerIndex(state, aliceServed),
        requestId: 'bob-stale-boundary-guess'
      },
      'bob'
    )
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-guess'
    ])
    expect(state.getCharade(firstCharade.id)?.guesses).toEqual(guessesAfterCompletion)
  })
})

describe('charade serving and guesses', () => {
  it('uses the production three-beat first-guess delay when the option is omitted', async () => {
    let timestamp = FIXED_NOW
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const state = new GhostlightState(repository, () => timestamp)
    await state.hydrate()
    const sent: SentMessage[] = []
    const protocol = createServerProtocol({
      state,
      send: async (type, data, to) => {
        sent.push({ type, data, to })
      },
      snapshotLook: async (address) => makeLook(address, 'Player'),
      flush: () => repository.flushNow(),
      now: () => timestamp,
      instanceId: 'default-delay-test',
      lookAttempts: 1,
      lookRetryMilliseconds: 0,
      random: () => 0.5
    })
    const delay = EMOTE_STEP_SECONDS * 3 * 1_000
    expect(delay).toBe(7_500)
    const charade = makeCharade('default-first-guess-delay', { author: { address: 'outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const guess = {
      charadeId: served.id,
      answerIndex: correctAnswerIndex(state, served),
      requestId: 'default-delay-guess'
    }

    timestamp += delay - 1
    sent.length = 0
    await protocol.handleGuess(guess, 'player')
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'requestError', data: { code: 'invalid-guess', requestId: guess.requestId }, to: ['player'] }
    ])

    timestamp += 1
    sent.length = 0
    await protocol.handleGuess(guess, 'player')
    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
  })

  it('rejects a live first guess just before all three beats finish and accepts it at the exact deadline', async () => {
    let timestamp = FIXED_NOW
    const delay = EMOTE_STEP_SECONDS * 3 * 1_000
    const { state, sent, protocol } = await createHarness({
      now: () => timestamp,
      firstGuessDelayMilliseconds: delay,
      snapshotLook: async (address) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    })
    const charade = makeCharade('timed-live-round', { author: { address: 'outside', name: 'Outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(
      messagesOfType(sent, 'charade').find((message) => message.to?.[0] === 'alice')!
    )
    const guess = {
      charadeId: served.id,
      answerIndex: correctAnswerIndex(state, served),
      requestId: 'timed-live-guess'
    }
    sent.length = 0

    timestamp += delay - 1
    await handleCurrentRoundGuess(protocol, guess, 'alice')

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'roundWinner')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'requestError', data: { code: 'invalid-guess', requestId: guess.requestId }, to: ['alice'] }
    ])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(protocol.rounds.current?.winner).toBeNull()

    timestamp += 1
    sent.length = 0
    await handleCurrentRoundGuess(protocol, guess, 'alice')

    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(messagesOfType(sent, 'roundWinner')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ address: 'alice', charadeId: charade.id }) })
    ])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
  })

  it('starts the first-guess deadline only after the exact charade send finishes', async () => {
    let timestamp = FIXED_NOW
    const delay = EMOTE_STEP_SECONDS * 3 * 1_000
    const { state, sent, protocol } = await createHarness({
      now: () => timestamp,
      firstGuessDelayMilliseconds: delay,
      send: async (type) => {
        if (type === 'charade') timestamp += 20_000
      }
    })
    const charade = makeCharade('delayed-charade-send', { author: { address: 'outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const guess = {
      charadeId: served.id,
      answerIndex: correctAnswerIndex(state, served),
      requestId: 'post-send-deadline'
    }
    sent.length = 0

    await protocol.handleGuess(guess, 'player')
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'requestError', data: { code: 'invalid-guess', requestId: guess.requestId }, to: ['player'] }
    ])

    timestamp += delay
    sent.length = 0
    await protocol.handleGuess(guess, 'player')
    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
  })

  it('resets first-guess eligibility when the same served charade is sent again', async () => {
    let timestamp = FIXED_NOW
    const delay = EMOTE_STEP_SECONDS * 3 * 1_000
    const { state, sent, protocol } = await createHarness({
      now: () => timestamp,
      firstGuessDelayMilliseconds: delay
    })
    const charade = makeCharade('same-served-deadline', { author: { address: 'outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    const next = { requestId: 'same-served-next', exclude: [] as string[] }
    await protocol.handleNextCharade(next, 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    timestamp += delay
    await protocol.handleNextCharade(next, 'player')
    sent.length = 0

    await protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: correctAnswerIndex(state, served),
        requestId: 'same-served-early'
      },
      'player'
    )

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-guess', requestId: 'same-served-early' },
        to: ['player']
      }
    ])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
  })

  it('allows an immediate retry and replays its completed response regardless of the first-guess deadline', async () => {
    let timestamp = FIXED_NOW
    const delay = EMOTE_STEP_SECONDS * 3 * 1_000
    const { state, sent, protocol } = await createHarness({
      now: () => timestamp,
      firstGuessDelayMilliseconds: delay
    })
    const charade = makeCharade('timed-retry', { author: { address: 'outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    timestamp += delay
    await protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: wrongAnswerIndexes(state, served)[0],
        requestId: 'timed-first-miss'
      },
      'player'
    )
    const finalGuess = {
      charadeId: served.id,
      answerIndex: correctAnswerIndex(state, served),
      requestId: 'timed-recovery'
    }
    timestamp = FIXED_NOW
    sent.length = 0

    await protocol.handleGuess(finalGuess, 'player')
    const reveal = messagesOfType(sent, 'reveal').at(-1)!.data
    await protocol.handleGuess(finalGuess, 'player')

    expect(messagesOfType(sent, 'reveal').map((message) => message.data)).toEqual([reveal, reveal])
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 0 })
  })

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
    await protocol.handlePost({ requestId: oversized, phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE }, 'player')

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

  it('bounds completed replay entries and consumes every served answer after final resolution', async () => {
    let timestamp = FIXED_NOW
    const { state, sent, protocol } = await createHarness({ now: () => timestamp })
    await negotiate(protocol, 'player')
    sent.length = 0

    await protocol.handleNextCharade({ requestId: 'first-next', exclude: [] }, 'player')
    const first = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const firstGuess = {
      requestId: 'oldest-guess',
      charadeId: first.id,
      answerIndex: correctAnswerIndex(state, first)
    }
    await protocol.handleGuess(firstGuess, 'player')
    for (let index = 0; index < MAX_DURABLE_COMPLETIONS + 1; index += 1) {
      timestamp += 1_000
      await protocol.handleNextCharade({ requestId: `next-${index}`, exclude: [] }, 'player')
      const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
      await protocol.handleGuess(
        { requestId: `guess-${index}`, charadeId: served.id, answerIndex: correctAnswerIndex(state, served) },
        'player'
      )
    }
    sent.length = 0

    await protocol.handleGuess(firstGuess, 'player')

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'requestError', data: { code: 'charade-not-served', requestId: 'oldest-guess' }, to: ['player'] }
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
    await vi.waitFor(() => expect(protocol.resourceCounts().outstandingRequests).toBe(4))
    await vi.waitFor(() => expect(messagesOfType(sent, 'charade')).toHaveLength(1))
    await protocol.handleNextCharade({ requestId: 'rejected-fifth', exclude: [] }, 'player')

    expect(protocol.resourceCounts().outstandingRequests).toBe(4)
    expect(messagesOfType(sent, 'charade')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])
    gate.resolve()
    await Promise.all(admitted)
    expect(messagesOfType(sent, 'charade')).toHaveLength(4)
    expect(protocol.resourceCounts().outstandingRequests).toBe(0)
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

    for (const changed of [
      { ...guess, charadeId: 'different-charade' },
      { ...guess, answerIndex: (answerIndex + 1) % 3 },
      { ...guess, spotlight: true }
    ]) {
      sent.length = 0
      await protocol.handleGuess(changed, '0xPlayer')
      expect(messagesOfType(sent, 'reveal')).toEqual([])
      expect(messagesOfType(sent, 'error')).toEqual([
        { type: 'requestError', data: { code: 'invalid-guess', requestId: guess.requestId }, to: ['0xPlayer'] }
      ])
    }

    sent.length = 0
    await protocol.handleGuess({ ...guess, requestId: 'guess-2' }, '0xPlayer')
    expect(dataOf<ErrorMessage>(messagesOfType(sent, 'error').at(-1)!).code).toBe('charade-not-served')
    expect(state.getCharade(charade.id)?.guesses.total).toBe(1)
    expect(sent.every((message) => message.to?.[0] === '0xPlayer')).toBe(true)
  })

  it('records nothing on a first miss and replays the identical answerless retry after cache expiry', async () => {
    let timestamp = FIXED_NOW
    const { repository, state, sent, checkpoint, protocol } = await createHarness({ now: () => timestamp })
    const charade = makeCharade('first-miss-only', { author: { address: 'author', name: 'Author' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    await state.getOrCreateStats('author', 'Author')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const wrongIndex = wrongAnswerIndexes(state, served)[0]
    const before = {
      player: JSON.parse(JSON.stringify(state.playerStats.get('player'))),
      author: JSON.parse(JSON.stringify(state.playerStats.get('author'))),
      charade: JSON.parse(JSON.stringify(state.getCharade(charade.id))),
      boards: JSON.parse(JSON.stringify(state.boards)),
      dirty: repository.getDirtyKeys()
    }
    const request = {
      charadeId: served.id,
      answerIndex: wrongIndex,
      requestId: 'first-miss-request',
      spotlight: true
    }
    sent.length = 0
    checkpoint.mockClear()

    await protocol.handleGuess(request, 'player')

    const retry = dataOf<RetryMessage>(messagesOfType(sent, 'retry')[0])
    expect(Object.keys(retry).sort()).toEqual(['charadeId', 'removedAnswerIndex', 'replayBeatIndex', 'requestId'])
    expect(retry).toEqual({
      requestId: request.requestId,
      charadeId: served.id,
      removedAnswerIndex: wrongIndex,
      replayBeatIndex: expect.any(Number)
    })
    expect(retry.replayBeatIndex).toBeGreaterThanOrEqual(0)
    expect(retry.replayBeatIndex).toBeLessThan(charade.emotes.length)
    expect(JSON.stringify(retry)).not.toContain(charade.phraseId)
    expect(JSON.stringify(retry)).not.toContain(DECK.find((phrase) => phrase.id === charade.phraseId)!.text)
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(checkpoint).not.toHaveBeenCalled()
    expect({
      player: state.playerStats.get('player'),
      author: state.playerStats.get('author'),
      charade: state.getCharade(charade.id),
      boards: state.boards,
      dirty: repository.getDirtyKeys()
    }).toEqual(before)
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 1, activeDecoders: 1 })

    await protocol.handleGuess(request, 'player')
    timestamp += 16_000
    await protocol.handleGuess(request, 'player')
    await protocol.handleGuess({ ...request, answerIndex: correctAnswerIndex(state, served) }, 'player')
    await protocol.handleGuess({ ...request, spotlight: false }, 'player')

    expect(messagesOfType(sent, 'retry').map((message) => message.data)).toEqual([retry, retry, retry])
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'requestError', data: { code: 'invalid-guess', requestId: request.requestId }, to: ['player'] },
      { type: 'requestError', data: { code: 'invalid-guess', requestId: request.requestId }, to: ['player'] }
    ])
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('rejects plain and live-round cross-shape replays that reuse a completed request id', async () => {
    const plain = await createHarness()
    const plainTarget = makeCharade('plain-cross-shape', { author: { address: 'outside' } })
    plain.state.upsertCharade(plainTarget)
    await negotiate(plain.protocol, 'player')
    await plain.protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const plainServed = dataOf<CharadeMessage>(messagesOfType(plain.sent, 'charade').at(-1)!)
    const plainGuess = {
      requestId: 'plain-cross-shape-request',
      charadeId: plainServed.id,
      answerIndex: correctAnswerIndex(plain.state, plainServed)
    }
    await plain.protocol.handleGuess(plainGuess, 'player')
    plain.sent.length = 0

    await plain.protocol.handleRoundGuess({ ...plainGuess, roundId: '1' }, 'player')

    expect(messagesOfType(plain.sent, 'reveal')).toEqual([])
    expect(messagesOfType(plain.sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-guess', requestId: plainGuess.requestId },
        to: ['player']
      }
    ])

    const live = await createHarness()
    const liveTarget = makeCharade('round-cross-shape', { author: { address: 'outside' } })
    live.state.upsertCharade(liveTarget)
    await negotiate(live.protocol, 'alice')
    await negotiate(live.protocol, 'bob')
    await live.protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await live.protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const liveServed = dataOf<CharadeMessage>(messagesOfType(live.sent, 'charade').at(-1)!)
    const roundId = live.protocol.rounds.current!.roundId
    const liveGuess = {
      requestId: 'round-cross-shape-request',
      charadeId: liveServed.id,
      answerIndex: correctAnswerIndex(live.state, liveServed)
    }
    await live.protocol.handleRoundGuess({ ...liveGuess, roundId }, 'alice')
    live.sent.length = 0

    await live.protocol.handleGuess(liveGuess, 'alice')

    expect(messagesOfType(live.sent, 'reveal')).toEqual([])
    expect(messagesOfType(live.sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-guess', requestId: liveGuess.requestId },
        to: ['alice']
      }
    ])
  })

  it('records a recovery exactly once, holds streak and understood, and rejects a third request', async () => {
    const { state, sent, checkpoint, protocol } = await createHarness()
    const charade = makeCharade('recovery-final', { author: { address: 'author', name: 'Author' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    const stats = state.playerStats.get('player')!
    stats.daily = { day: '2026-08-23', decoded: 2, authored: 1, stamped: false }
    stats.showSet = {
      showKey: 'daily:2026-08-23',
      round: 4,
      score: 600,
      streak: 2,
      bestStreak: 3,
      understood: 1
    }
    state.saveStats('player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const wrongIndex = wrongAnswerIndexes(state, served)[0]
    const first = {
      charadeId: served.id,
      answerIndex: wrongIndex,
      requestId: 'recovery-first',
      spotlight: true
    }
    const final = {
      charadeId: served.id,
      answerIndex: correctAnswerIndex(state, served),
      requestId: 'recovery-final',
      spotlight: false
    }
    sent.length = 0
    checkpoint.mockClear()

    await protocol.handleGuess(first, 'player')
    expect(checkpoint).not.toHaveBeenCalled()
    await protocol.handleGuess(final, 'player')
    const reveal = messagesOfType(sent, 'reveal').at(-1)!.data

    expect(reveal).toMatchObject({
      requestId: final.requestId,
      correct: true,
      attempt: 2,
      spotlight: true,
      scoreDelta: 50,
      stampAwarded: true,
      setRound: 5,
      setScore: 650,
      setStreak: 2,
      setBestStreak: 3,
      setUnderstood: 1,
      setComplete: true
    })
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 1,
      correct: 0,
      revision: 1,
      seen: [charade.id],
      daily: { decoded: 3, authored: 1, stamped: true },
      showSet: { round: 5, score: 650, streak: 2, bestStreak: 3, understood: 1 }
    })
    expect(state.playerStats.get('author')?.pending).toEqual({ triedYou: 1, gotYou: 0, replies: 0, mail: 0 })
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 0 })
    expect(state.boards.decoders).toEqual([{ address: 'player', name: 'PLAYER', correct: 0, total: 1 }])
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 0, retryStates: 0, activeDecoders: 0 })

    await protocol.handleGuess(final, 'player')
    expect(messagesOfType(sent, 'reveal').at(-1)!.data).toEqual(reveal)
    expect(checkpoint).toHaveBeenCalledOnce()
    await protocol.handleGuess({ ...final, requestId: 'third-request' }, 'player')
    expect(dataOf<ErrorMessage>(messagesOfType(sent, 'error').at(-1)!).code).toBe('charade-not-served')
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 0 })
  })

  it('commits a registered 257th decoder without exceeding the capped daily aggregate', async () => {
    const storage = new FakeStorage()
    const day = dayKey(FIXED_NOW)
    const aggregate = Array.from({ length: MAX_DAILY_DECODERS }, (_, index) => ({
      address: `0x${index.toString(16).padStart(40, '0')}`,
      name: `Decoder ${index}`,
      correct: index % 2,
      total: 1
    }))
    storage.putJSON(decoderAggregateKey(day), aggregate)
    const { state, sent, repository, protocol } = await createHarness({}, storage)
    const charade = makeCharade('decoder-cap-target', { author: { address: 'author', name: 'Author' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'new-decoder')
    await protocol.handleNextCharade(nextCharadeRequest(), 'new-decoder')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    sent.length = 0

    await protocol.handleGuess(
      {
        requestId: 'decoder-cap-guess',
        charadeId: served.id,
        answerIndex: correctAnswerIndex(state, served)
      },
      'new-decoder'
    )

    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
    expect(state.playerStats.get('new-decoder')).toMatchObject({ decoded: 1, correct: 1, seen: [charade.id] })
    expect(state.boards.decoders.some((row) => row.address === 'new-decoder')).toBe(false)
    await repository.flushNow()
    expect(storage.readJSON<unknown[]>(decoderAggregateKey(day))).toHaveLength(MAX_DAILY_DECODERS)
    expect(
      storage
        .readJSON<Array<{ address: string }>>(decoderAggregateKey(day))
        ?.some((row) => row.address === 'new-decoder')
    ).toBe(false)
  })

  it('records a Spotlight second miss exactly once across every public statistic surface', async () => {
    const { state, sent, checkpoint, protocol } = await createHarness()
    const charade = makeCharade('second-miss-final', { author: { address: 'author', name: 'Author' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'player')
    const stats = state.playerStats.get('player')!
    stats.showSet = {
      showKey: 'daily:2026-08-23',
      round: 0,
      score: 50,
      streak: 2,
      bestStreak: 2,
      understood: 1
    }
    state.saveStats('player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const wrong = wrongAnswerIndexes(state, served)
    sent.length = 0
    checkpoint.mockClear()

    await protocol.handleGuess(
      { charadeId: served.id, answerIndex: wrong[0], requestId: 'miss-first', spotlight: true },
      'player'
    )
    await protocol.handleGuess(
      { charadeId: served.id, answerIndex: wrong[1], requestId: 'miss-final', spotlight: false },
      'player'
    )
    const reveal = messagesOfType(sent, 'reveal').at(-1)!.data

    expect(reveal).toMatchObject({ correct: false, attempt: 2, spotlight: true, scoreDelta: -100, setScore: 0 })
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 1,
      correct: 0,
      revision: 1,
      seen: [charade.id],
      daily: { decoded: 1 },
      showSet: { round: 1, score: 0, streak: 0, bestStreak: 2, understood: 1 }
    })
    expect(state.playerStats.get('author')?.pending).toEqual({ triedYou: 1, gotYou: 0, replies: 0, mail: 0 })
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 0 })
    expect(state.boards.decoders).toEqual([{ address: 'player', name: 'PLAYER', correct: 0, total: 1 }])
    expect(checkpoint).toHaveBeenCalledOnce()

    await protocol.handleGuess(
      { charadeId: served.id, answerIndex: wrong[1], requestId: 'miss-final', spotlight: true },
      'player'
    )
    expect(messagesOfType(sent, 'reveal').at(-1)!.data).toEqual(reveal)
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 0 })
    expect(checkpoint).toHaveBeenCalledOnce()
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

  it('replays a committed final reveal after restart when the original reveal send was dropped', async () => {
    const storage = new FakeStorage()
    const decoder = `0x${'1'.repeat(40)}`
    const author = `0x${'2'.repeat(40)}`
    let flushFirst = async () => undefined
    const first = await createHarness(
      {
        snapshotLook: async (address) => makeLook(address, address === decoder ? 'Decoder' : 'Author'),
        flush: () => flushFirst(),
        send: async (type) => {
          if (type === 'reveal') throw new Error('dropped reveal')
        }
      },
      storage
    )
    flushFirst = () => first.repository.flushNow().then(() => undefined)
    const charade = makeCharade('restart-reveal', { author: makeLook(author, 'Author') })
    first.state.upsertCharade(charade)
    await first.repository.flushNow()
    await negotiate(first.protocol, decoder)
    await first.protocol.handleNextCharade(nextCharadeRequest(), decoder)
    const served = dataOf<CharadeMessage>(messagesOfType(first.sent, 'charade').at(-1)!)
    const guess = {
      charadeId: served.id,
      answerIndex: correctAnswerIndex(first.state, served),
      requestId: 'restart-final-reveal'
    }
    first.sent.length = 0

    await expect(first.protocol.handleGuess(guess, decoder)).rejects.toThrow('dropped reveal')
    const committedReveal = dataOf<Record<string, unknown>>(messagesOfType(first.sent, 'reveal')[0])

    let flushSecond = async () => undefined
    const second = await createHarness(
      {
        snapshotLook: async (address) => makeLook(address, 'Decoder'),
        flush: () => flushSecond()
      },
      storage
    )
    flushSecond = () => second.repository.flushNow().then(() => undefined)
    await negotiate(second.protocol, decoder)
    second.sent.length = 0
    await second.protocol.handleGuess(guess, decoder)

    expect(messagesOfType(second.sent, 'reveal').map((message) => message.data)).toEqual([committedReveal])
    expect(second.state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
    expect(second.state.playerStats.get(decoder)).toMatchObject({ decoded: 1, correct: 1, revision: 1 })
    expect((await second.state.getOrCreateStats(author, 'Author')).pending).toEqual({
      triedYou: 1,
      gotYou: 1,
      replies: 0,
      mail: 0
    })
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
    const reentering = negotiate(protocol, 'player')
    await vi.waitFor(() => expect(messagesOfType(sent, 'ready').length).toBeGreaterThan(0))
    sent.length = 0
    checkpointGate.resolve()
    await Promise.all([guessing, reentering])

    expect(
      messagesOfType(sent, 'error').filter(
        (message) => dataOf<ErrorMessage>(message).requestId === 'stale-checkpoint-guess'
      )
    ).toEqual([])
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
    await protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: wrongAnswerIndexes(state, served)[0],
        requestId: 'corrupt-author-first'
      },
      decoder
    )
    const guess = {
      charadeId: served.id,
      answerIndex: served.answers.indexOf(phrase.text),
      requestId: 'corrupt-author-final'
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
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 1, activeDecoders: 1 })

    storage.putPlayerJSON(author, PLAYER_STATS_KEY, makeStats({ name: 'Author' }))
    sent.length = 0
    await protocol.handleGuess(guess, decoder)
    errorSpy.mockRestore()

    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(messagesOfType(sent, 'reveal')[0].data).toMatchObject({ correct: true, attempt: 2, scoreDelta: 50 })
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 0 })
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

  it('advances signed-in first-try House progression without changing global ranking surfaces', async () => {
    const { state, sent, protocol } = await createHarness()
    await negotiate(protocol, 'player')
    sent.length = 0
    const houseGuessesBefore = HOUSE_CHARADES.map((charade) => ({ ...charade.guesses }))

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await protocol.handleNextCharade(nextCharadeRequest(), 'player')
      const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
      expect(served.id).toMatch(/^house-[a-f0-9]{16}$/u)
      expect(HOUSE_CHARADES.map((charade) => charade.id)).not.toContain(served.id)
      expect(state.getCharade(served.id)).toBeNull()
      await protocol.handleGuess(
        {
          charadeId: served.id,
          answerIndex: correctAnswerIndex(state, served),
          requestId: `house-${attempt}`
        },
        'player'
      )
    }

    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(messagesOfType(sent, 'roundWinner')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 2,
      correct: 2,
      revision: 2,
      seen: [],
      daily: { decoded: 2 }
    })
    expect(HOUSE_CHARADES.map((charade) => charade.guesses)).toEqual(houseGuessesBefore)
    expect(state.boards).toEqual({ decoders: [], hardest: [] })
    expect(state.playerStats.size).toBe(1)
  })

  it.each([
    { label: 'recovery', finalAnswer: 'correct' as const, finalCorrect: true },
    { label: 'final miss', finalAnswer: 'wrong' as const, finalCorrect: false }
  ])('counts a House $label as one decode and zero first-try correct solves', async ({ finalAnswer, finalCorrect }) => {
    const { state, sent, protocol } = await createHarness()
    await negotiate(protocol, 'player')
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const wrong = wrongAnswerIndexes(state, served)

    await protocol.handleGuess(
      { charadeId: served.id, answerIndex: wrong[0], requestId: 'house-outcome-first' },
      'player'
    )
    await protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: finalAnswer === 'correct' ? correctAnswerIndex(state, served) : wrong[1],
        requestId: 'house-outcome-final'
      },
      'player'
    )

    expect(messagesOfType(sent, 'reveal').at(-1)!.data).toMatchObject({
      correct: finalCorrect,
      attempt: 2
    })
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 1,
      correct: 0,
      revision: 1,
      seen: [],
      daily: { decoded: 1 }
    })
    expect(state.boards).toEqual({ decoders: [], hardest: [] })
  })

  it('awards one saved daily stamp after three House decodes and one ordinary post without board entries', async () => {
    const { storage, repository, state, sent, protocol } = await createHarness()
    await negotiate(protocol, 'player')
    sent.length = 0

    for (let index = 0; index < 3; index += 1) {
      await protocol.handleNextCharade(nextCharadeRequest(), 'player')
      const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
      await protocol.handleGuess(
        {
          charadeId: served.id,
          answerIndex: correctAnswerIndex(state, served),
          requestId: `daily-house-${index}`
        },
        'player'
      )
      expect(messagesOfType(sent, 'reveal').at(-1)!.data).toMatchObject({ stampAwarded: false })
    }

    await protocol.handlePost(
      { requestId: 'daily-house-post', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE },
      'player'
    )
    const posted = messagesOfType(sent, 'posted').at(-1)!.data

    expect(posted).toMatchObject({ stampAwarded: true })
    expect(state.playerStats.get('player')).toMatchObject({
      decoded: 3,
      correct: 3,
      revision: 4,
      daily: { decoded: 3, authored: 1, stamped: true },
      stampedDays: ['2026-08-23']
    })
    expect(state.boards).toEqual({ decoders: [], hardest: [] })
    await repository.flushNow()
    expect(storage.readPlayerJSON<ReturnType<typeof makeStats>>('player', PLAYER_STATS_KEY)).toMatchObject({
      decoded: 3,
      correct: 3,
      revision: 4,
      daily: { decoded: 3, authored: 1, stamped: true },
      stampedDays: ['2026-08-23']
    })
  })

  it('keeps a guest House completion out of durable personal and global progression', async () => {
    const snapshotLook = async (address: string) => ({ ...makeLook(address, 'Guest'), isGuest: true })
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    await negotiate(protocol, 'guest-session')
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest(), 'guest-session')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)

    await protocol.handleGuess(
      {
        requestId: 'guest-house-completion',
        charadeId: served.id,
        answerIndex: correctAnswerIndex(state, served)
      },
      'guest-session'
    )

    expect(state.playerStats.get('guest-session')).toMatchObject({
      decoded: 0,
      correct: 0,
      revision: 0,
      seen: [],
      daily: { decoded: 0, stamped: false }
    })
    expect(state.boards).toEqual({ decoders: [], hardest: [] })
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
      const wrongIndexes = wrongAnswerIndexes(state, served)
      const guess = {
        charadeId: served.id,
        answerIndex: correct ? correctIndex : wrongIndexes[1],
        requestId,
        spotlight
      }
      if (!correct) {
        await protocol.handleGuess(
          {
            charadeId: served.id,
            answerIndex: wrongIndexes[0],
            requestId: `${requestId}-first`,
            spotlight
          },
          'player'
        )
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
      showKey: 'daily:2026-08-23',
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
      decoded: 5,
      correct: 3,
      revision: 5,
      daily: { decoded: 5 },
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

  it.each([
    { label: 'first hit', outcome: 'first', spotlight: false, delta: 100, score: 300, streak: 3, understood: 2 },
    {
      label: 'Spotlight first hit',
      outcome: 'first',
      spotlight: true,
      delta: 200,
      score: 400,
      streak: 3,
      understood: 2
    },
    { label: 'recovery', outcome: 'recovery', spotlight: false, delta: 50, score: 250, streak: 2, understood: 1 },
    {
      label: 'Spotlight recovery',
      outcome: 'recovery',
      spotlight: true,
      delta: 50,
      score: 250,
      streak: 2,
      understood: 1
    },
    { label: 'second miss', outcome: 'miss', spotlight: false, delta: 0, score: 200, streak: 0, understood: 1 },
    {
      label: 'Spotlight second miss',
      outcome: 'miss',
      spotlight: true,
      delta: -100,
      score: 100,
      streak: 0,
      understood: 1
    }
  ])('prices $label exactly', async ({ outcome, spotlight, delta, score, streak, understood }) => {
    const { state, sent, protocol } = await createHarness()
    await negotiate(protocol, 'player')
    const stats = state.playerStats.get('player')!
    stats.showSet = {
      showKey: 'daily:2026-08-23',
      round: 0,
      score: 200,
      streak: 2,
      bestStreak: 2,
      understood: 1
    }
    state.saveStats('player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const correctIndex = correctAnswerIndex(state, served)
    const wrong = wrongAnswerIndexes(state, served)
    sent.length = 0

    if (outcome !== 'first') {
      await protocol.handleGuess(
        { charadeId: served.id, answerIndex: wrong[0], requestId: 'matrix-first', spotlight },
        'player'
      )
    }
    await protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: outcome === 'miss' ? wrong[1] : correctIndex,
        requestId: 'matrix-final',
        spotlight: outcome === 'first' ? spotlight : !spotlight
      },
      'player'
    )

    expect(messagesOfType(sent, 'reveal').at(-1)!.data).toMatchObject({
      correct: outcome !== 'miss',
      attempt: outcome === 'first' ? 1 : 2,
      spotlight,
      scoreDelta: delta,
      setScore: score,
      setStreak: streak,
      setUnderstood: understood
    })
  })

  it('floors a Spotlight miss at zero and resumes an interrupted set after server sleep', async () => {
    const storage = new FakeStorage()
    const first = await createHarness({}, storage)
    await negotiate(first.protocol, 'player')
    first.sent.length = 0
    await first.protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(first.sent, 'charade').at(-1)!)
    const wrongIndexes = wrongAnswerIndexes(first.state, served)
    await first.protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: wrongIndexes[0],
        requestId: 'spotlight-floor-first',
        spotlight: true
      },
      'player'
    )
    await first.protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: wrongIndexes[1],
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

  it('forgets an unresolved retry on server restart without recording it and serves a replacement', async () => {
    const storage = new FakeStorage()
    const first = await createHarness({}, storage)
    await negotiate(first.protocol, 'player')
    first.sent.length = 0
    first.checkpoint.mockClear()
    await first.protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(first.sent, 'charade').at(-1)!)
    const before = structuredClone(first.state.playerStats.get('player'))

    await first.protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: wrongAnswerIndexes(first.state, served)[0],
        requestId: 'sleep-first-miss',
        spotlight: true
      },
      'player'
    )

    expect(first.checkpoint).not.toHaveBeenCalled()
    expect(first.state.playerStats.get('player')).toEqual(before)
    expect(first.protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 1 })

    const second = await createHarness({}, storage)
    await negotiate(second.protocol, 'player')
    expect(second.state.playerStats.get('player')).toMatchObject({
      decoded: before!.decoded,
      correct: before!.correct,
      seen: before!.seen
    })
    expect(
      second.state.playerStats.get('player')?.showSet ?? {
        round: 0,
        score: 0,
        streak: 0,
        bestStreak: 0,
        understood: 0
      }
    ).toEqual(before!.showSet)
    second.sent.length = 0
    await second.protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: correctAnswerIndex(first.state, served),
        requestId: 'stale-second-attempt'
      },
      'player'
    )
    expect(messagesOfType(second.sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'charade-not-served', requestId: 'stale-second-attempt' },
        to: ['player']
      }
    ])

    const replacementRequest = nextCharadeRequest([served.id])
    await second.protocol.handleNextCharade(replacementRequest, 'player')
    const replacement = dataOf<CharadeMessage>(messagesOfType(second.sent, 'charade').at(-1)!)
    expect(replacement.requestId).toBe(replacementRequest.requestId)
    expect(second.protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 0 })
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

  it('fails closed to House for unclear legacy ordinary, mail, and reply performances', async () => {
    const phrase = PLAYABLE_DECK[0]
    const canonical = canonicalPerformance(phrase)!

    const ordinary = await createHarness()
    ordinary.state.upsertCharade(
      makeCharade('unclear-ordinary', {
        phraseId: phrase.id,
        emotes: [canonical[0], canonical[0], canonical[2]]
      })
    )
    await negotiate(ordinary.protocol, 'ordinary-player')
    ordinary.sent.length = 0
    await ordinary.protocol.handleNextCharade(nextCharadeRequest(), 'ordinary-player')

    const recipient = `0x${'2'.repeat(40)}`
    const mail = await createHarness({ snapshotLook: async (address) => makeLook(address) })
    mail.state.upsertCharade(
      makeCharade('unclear-mail', {
        phraseId: phrase.id,
        emotes: [canonical[0], canonical[0], canonical[2]],
        recipient
      })
    )
    await negotiate(mail.protocol, recipient)
    mail.sent.length = 0
    await mail.protocol.handleNextCharade(nextCharadeRequest(), recipient)

    const answerBack = await createHarness()
    answerBack.state.upsertCharade(
      makeCharade('unclear-reply', {
        phraseId: phrase.id,
        emotes: canonical,
        reply: makeReply('replier', 'Replier', {
          emotes: [canonical[0], canonical[0], canonical[2]]
        })
      })
    )
    await negotiate(answerBack.protocol, 'reply-player')
    answerBack.sent.length = 0
    await answerBack.protocol.handleNextCharade(nextCharadeRequest(), 'reply-player')

    for (const harness of [ordinary, mail, answerBack]) {
      expect(dataOf<CharadeMessage>(messagesOfType(harness.sent, 'charade').at(-1)!)).toMatchObject({
        isHouse: true
      })
      expect(messagesOfType(harness.sent, 'charadeReply')).toEqual([])
      expect(messagesOfType(harness.sent, 'error')).toEqual([])
    }
  })

  it('forgets served answers but durably replays a completed request when a player leaves', async () => {
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
    const reveal = messagesOfType(sent, 'reveal').at(-1)!.data
    await protocol.handleLeave('player')
    await negotiate(protocol, 'player')
    sent.length = 0

    await protocol.handleGuess(guess, 'player')

    expect(messagesOfType(sent, 'reveal').map((message) => message.data)).toEqual([reveal])
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
  })

  it('rejects skipping an unresolved retry and cleans served state on leave and replacement', async () => {
    const { state, sent, protocol } = await createHarness()
    const first = makeCharade('retry-cleanup-first', { author: { address: 'author-a' }, createdAt: FIXED_NOW - 2 })
    const second = makeCharade('retry-cleanup-second', { author: { address: 'author-b' }, createdAt: FIXED_NOW - 1 })
    state.upsertCharade(first)
    state.upsertCharade(second)
    await negotiate(protocol, 'player')
    await protocol.handleNextCharade(nextCharadeRequest(), 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    await protocol.handleGuess(
      {
        charadeId: served.id,
        answerIndex: wrongAnswerIndexes(state, served)[0],
        requestId: 'cleanup-first-miss'
      },
      'player'
    )
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 1, activeDecoders: 1 })

    sent.length = 0
    const blockedNext = nextCharadeRequest([served.id])
    await protocol.handleNextCharade(blockedNext, 'player')
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-next-charade', requestId: blockedNext.requestId },
        to: ['player']
      }
    ])
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 1, activeDecoders: 1 })

    await protocol.handleLeave('player')
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 0, retryStates: 0, activeDecoders: 0 })
    await negotiate(protocol, 'player')
    sent.length = 0
    await protocol.handleNextCharade(nextCharadeRequest([served.id]), 'player')
    const replacement = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    expect(replacement.id).not.toBe(served.id)
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 0, activeDecoders: 1 })

    await protocol.handleNextCharade(nextCharadeRequest([replacement.id]), 'player')
    const afterReplacement = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    expect(afterReplacement.id).not.toBe(replacement.id)
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 0, activeDecoders: 1 })
    sent.length = 0
    await protocol.handleGuess(
      {
        charadeId: replacement.id,
        answerIndex: correctAnswerIndex(state, replacement),
        requestId: 'cleanup-old-final'
      },
      'player'
    )
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'charade-not-served', requestId: 'cleanup-old-final' },
        to: ['player']
      }
    ])

    await protocol.handleLeave('player')
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 0, retryStates: 0, activeDecoders: 0 })
    expect(state.getCharade(first.id)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(state.getCharade(second.id)?.guesses).toEqual({ total: 0, correct: 0 })
  })

  it('preserves retry state across cached serving replay and cannot reopen a resolved house charade', async () => {
    const { state, sent, protocol } = await createHarness()
    await negotiate(protocol, 'player')
    sent.length = 0
    const next = { requestId: 'cached-house-next', exclude: [] as string[] }
    await protocol.handleNextCharade(next, 'player')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const wrongIndex = wrongAnswerIndexes(state, served)[0]
    await protocol.handleGuess(
      { charadeId: served.id, answerIndex: wrongIndex, requestId: 'cached-house-first' },
      'player'
    )
    const retry = messagesOfType(sent, 'retry').at(-1)!.data

    sent.length = 0
    await protocol.handleNextCharade({ requestId: 'skip-retry', exclude: [served.id] }, 'player')
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'requestError', data: { code: 'invalid-next-charade', requestId: 'skip-retry' }, to: ['player'] }
    ])
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 1 })
    sent.length = 0

    await protocol.handleNextCharade(next, 'player')
    const replayed = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    expect(replayed).toMatchObject({ id: served.id, answers: served.answers, answerIds: served.answerIds })
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 1 })
    sent.length = 0
    await Promise.all([
      protocol.handleGuess(
        {
          charadeId: served.id,
          answerIndex: correctAnswerIndex(state, served),
          requestId: 'cached-house-final'
        },
        'player'
      ),
      protocol.handleNextCharade(next, 'player')
    ])
    expect(messagesOfType(sent, 'reveal').at(-1)!.data).toMatchObject({ correct: true, attempt: 2, scoreDelta: 50 })
    expect(retry).toMatchObject({ charadeId: served.id, removedAnswerIndex: wrongIndex })

    const fresh = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    expect(fresh.id).not.toBe(served.id)
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 0 })
    sent.length = 0
    await protocol.handleGuess(
      { charadeId: served.id, answerIndex: correctAnswerIndex(state, served), requestId: 'cached-house-third' },
      'player'
    )
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'charade-not-served', requestId: 'cached-house-third' },
        to: ['player']
      }
    ])
  })
})

describe('authoring protocol', () => {
  it('requires explicit consent and persists ordinary opt-in without changing local selection', async () => {
    const { state, sent, rawProtocol } = await createHarness()
    await negotiate(rawProtocol, 'player')
    sent.length = 0

    await rawProtocol.handlePost(
      { phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE, requestId: 'missing-consent' },
      'player'
    )
    await rawProtocol.handlePost(
      {
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
        requestId: 'invalid-consent',
        touringConsent: 'yes'
      },
      'player'
    )
    await rawProtocol.handlePost(
      {
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
        requestId: 'touring-opt-in',
        touringConsent: true
      },
      'player'
    )
    await negotiate(rawProtocol, 'player-two')
    await rawProtocol.handlePost(
      {
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
        requestId: 'touring-opt-out',
        touringConsent: false
      },
      'player-two'
    )

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-post',
      'invalid-post'
    ])
    expect(state.getPool().map((charade) => charade.touringConsent)).toEqual([false, true])
  })

  it.each([
    { originalConsent: true, conflictingConsent: false },
    { originalConsent: false, conflictingConsent: true }
  ])(
    'rejects an in-memory request-id replay that changes consent from $originalConsent to $conflictingConsent',
    async ({ originalConsent, conflictingConsent }) => {
      const { state, sent, rawProtocol } = await createHarness()
      await negotiate(rawProtocol, 'player')
      const post = {
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
        requestId: 'consent-cache-replay',
        touringConsent: originalConsent
      }
      await rawProtocol.handlePost(post, 'player')
      const stored = state.getPool()[0]
      sent.length = 0

      await rawProtocol.handlePost({ ...post, touringConsent: conflictingConsent }, 'player')

      expect(messagesOfType(sent, 'posted')).toEqual([])
      expect(messagesOfType(sent, 'error')).toEqual([
        {
          type: 'requestError',
          data: { code: 'invalid-post', requestId: post.requestId },
          to: ['player']
        }
      ])
      expect(state.getCharade(stored.id)?.touringConsent).toBe(originalConsent)
      sent.length = 0

      await rawProtocol.handlePost(post, 'player')

      expect(messagesOfType(sent, 'posted')).toHaveLength(1)
      expect(messagesOfType(sent, 'error')).toEqual([])
      expect(state.getCharade(stored.id)?.touringConsent).toBe(originalConsent)
    }
  )

  it.each([
    { originalConsent: true, conflictingConsent: false },
    { originalConsent: false, conflictingConsent: true }
  ])(
    'rejects a durable request-id replay that changes consent from $originalConsent to $conflictingConsent',
    async ({ originalConsent, conflictingConsent }) => {
      const storage = new FakeStorage()
      const first = await createHarness({}, storage)
      await negotiate(first.rawProtocol, 'player')
      const post = {
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
        requestId: 'consent-durable-replay',
        touringConsent: originalConsent
      }
      await first.rawProtocol.handlePost(post, 'player')
      const storedId = first.state.getPool()[0].id
      await first.repository.flushNow()

      const second = await createHarness({}, storage)
      await negotiate(second.rawProtocol, 'player')
      second.sent.length = 0

      await second.rawProtocol.handlePost({ ...post, touringConsent: conflictingConsent }, 'player')

      expect(messagesOfType(second.sent, 'posted')).toEqual([])
      expect(messagesOfType(second.sent, 'error')).toEqual([
        {
          type: 'requestError',
          data: { code: 'invalid-post', requestId: post.requestId },
          to: ['player']
        }
      ])
      expect(second.state.getCharade(storedId)?.touringConsent).toBe(originalConsent)
      second.sent.length = 0

      await second.rawProtocol.handlePost(post, 'player')

      expect(messagesOfType(second.sent, 'posted')).toHaveLength(1)
      expect(messagesOfType(second.sent, 'error')).toEqual([])
      expect(second.state.getCharade(storedId)?.touringConsent).toBe(originalConsent)
    }
  )

  it('rejects mail and reply opt-in while storing accepted mail as non-touring', async () => {
    const sender = `0x${'1'.repeat(40)}`
    const recipient = `0x${'2'.repeat(40)}`
    const author = `0x${'3'.repeat(40)}`
    const { state, sent, rawProtocol } = await createHarness({
      snapshotLook: async (address) => makeLook(address, address)
    })
    state.recentVisitors = [{ ...makeLook(recipient, 'Recipient'), lastSeenAt: FIXED_NOW }]
    const target = makeCharade('reply-consent-target', { author: { address: author, name: 'Author' } })
    state.upsertCharade(target)
    await negotiate(rawProtocol, sender)
    state.playerStats.get(sender)!.seen.push(target.id)
    sent.length = 0

    await rawProtocol.handlePost(
      {
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
        requestId: 'touring-mail',
        touringConsent: true,
        recipient
      },
      sender
    )
    await rawProtocol.handlePost(
      {
        phraseId: target.phraseId,
        emotes: TEST_PERFORMANCE,
        requestId: 'touring-reply',
        touringConsent: true,
        replyTo: target.id
      },
      sender
    )
    await rawProtocol.handlePost(
      {
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
        requestId: 'private-mail',
        touringConsent: false,
        recipient
      },
      sender
    )

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-post',
      'invalid-reply'
    ])
    expect(state.getPlayerCharades()).toContainEqual(expect.objectContaining({ recipient, touringConsent: false }))
    expect(state.getCharade(target.id)?.reply).toBeUndefined()
  })

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
        requestId: 'guest-first-miss',
        charadeId: served.id,
        answerIndex: wrongAnswerIndexes(state, served)[0]
      },
      'guest-session'
    )
    await protocol.handleGuess(
      {
        requestId: 'guest-recovery',
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
    expect(state.playerStats.get('guest-session')?.showSet).toMatchObject({ round: 1, score: 50 })
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
    const post = { phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE, requestId: 'durable-post' }
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

  it('reconciles an active journal after apply exhausts the dirty queue and replays the exact request after re-entry', async () => {
    let timestamp = FIXED_NOW
    const { storage, repository, state, sent, protocol } = await createHarness({ now: () => timestamp })
    await negotiate(protocol, 'player')
    await repository.flushNow()
    for (let index = 0; index < MAX_DIRTY_ENTRIES; index += 1) {
      repository.markDirty(`journal-pressure-${index}`, { index })
    }
    const post = { requestId: 'recover-active-apply', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    sent.length = 0

    await protocol.handlePost(post, 'player')

    expect(messagesOfType(sent, 'posted')).toEqual([])
    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual(['server-busy'])
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toMatchObject({
      id: 'player:post:recover-active-apply'
    })

    sent.length = 0
    await protocol.handleLeave('player')
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toBeNull()
    timestamp += 1_000
    await negotiate(protocol, 'player')
    expect(messagesOfType(sent, 'error')).toEqual([])
    sent.length = 0
    await protocol.handlePost(post, 'player')
    logSpy.mockRestore()

    expect(messagesOfType(sent, 'posted')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.getPool()).toHaveLength(1)
    expect(state.playerStats.get('player')).toMatchObject({ authoredCount: 1, revision: 1 })
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toBeNull()
  })

  it('lets an unrelated player mutation reconcile a stranded active journal without a lifecycle transition', async () => {
    const { storage, repository, state, sent, protocol } = await createHarness()
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await repository.flushNow()
    for (let index = 0; index < MAX_DIRTY_ENTRIES; index += 1) {
      repository.markDirty(`cross-player-pressure-${index}`, { index })
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await protocol.handlePost(
      { requestId: 'stranded-alice', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE },
      'alice'
    )
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toMatchObject({
      id: 'alice:post:stranded-alice'
    })
    sent.length = 0

    await protocol.handlePost(
      { requestId: 'reconciling-bob', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE },
      'bob'
    )
    logSpy.mockRestore()

    expect(messagesOfType(sent, 'posted')).toEqual([
      expect.objectContaining({ to: ['bob'], data: expect.objectContaining({ requestId: 'reconciling-bob' }) })
    ])
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.getPool()).toHaveLength(2)
    expect(state.playerStats.get('alice')).toMatchObject({ authoredCount: 1, revision: 1 })
    expect(state.playerStats.get('bob')).toMatchObject({ authoredCount: 1, revision: 1 })
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toBeNull()
  })

  it('settles a recovered House guess before an unrelated mutation can leave it guessable twice', async () => {
    const { storage, repository, state, sent, protocol } = await createHarness()
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    expect(served.isHouse).toBe(true)
    await repository.flushNow()
    for (let index = 0; index < MAX_DIRTY_ENTRIES; index += 1) {
      repository.markDirty(`house-recovery-pressure-${index}`, { index })
    }
    const firstGuess = {
      requestId: 'stranded-house-guess',
      charadeId: served.id,
      answerIndex: correctAnswerIndex(state, served)
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    sent.length = 0

    await protocol.handleGuess(firstGuess, 'alice')

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'server-busy', requestId: firstGuess.requestId },
        to: ['alice']
      }
    ])
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toMatchObject({
      id: 'alice:guess:stranded-house-guess'
    })
    sent.length = 0

    await protocol.handlePost(
      { requestId: 'bob-after-house-recovery', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE },
      'bob'
    )

    expect(messagesOfType(sent, 'posted')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.playerStats.get('alice')).toMatchObject({
      decoded: 1,
      correct: 1,
      revision: 1,
      daily: { decoded: 1 },
      showSet: { round: 1, score: 100, understood: 1 }
    })
    expect(state.boards).toEqual({ decoders: [], hardest: [] })
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toBeNull()
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 0, activeDecoders: 0 })
    sent.length = 0

    await protocol.handleGuess(firstGuess, 'alice')

    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.playerStats.get('alice')).toMatchObject({ decoded: 1, correct: 1, revision: 1 })
    expect(state.boards).toEqual({ decoders: [], hardest: [] })
    sent.length = 0

    await protocol.handleGuess({ ...firstGuess, requestId: 'second-house-guess' }, 'alice')
    logSpy.mockRestore()

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'charade-not-served', requestId: 'second-house-guess' },
        to: ['alice']
      }
    ])
    expect(state.playerStats.get('alice')).toMatchObject({
      decoded: 1,
      correct: 1,
      revision: 1,
      showSet: { round: 1, score: 100, understood: 1 }
    })
    expect(state.boards).toEqual({ decoders: [], hardest: [] })
  })

  it('settles a recovered live-round winner exactly once during an unrelated mutation', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    const { storage, repository, state, sent, protocol } = await createHarness({ snapshotLook })
    const target = makeCharade('recovered-live-winner', {
      author: { ...makeLook('outside', 'Outside'), isGuest: false }
    })
    state.upsertCharade(target)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const roundId = protocol.rounds.current!.roundId
    await repository.flushNow()
    for (let index = 0; index < MAX_DIRTY_ENTRIES; index += 1) {
      repository.markDirty(`live-recovery-pressure-${index}`, { index })
    }
    const guess = {
      roundId,
      requestId: 'stranded-live-guess',
      charadeId: served.id,
      answerIndex: correctAnswerIndex(state, served)
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    sent.length = 0

    await protocol.handleRoundGuess(guess, 'alice')

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'server-busy', requestId: guess.requestId },
        to: ['alice']
      }
    ])
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toMatchObject({
      id: 'alice:guess:stranded-live-guess'
    })
    sent.length = 0

    await protocol.handlePost(
      { requestId: 'bob-after-live-recovery', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE },
      'bob'
    )

    expect(messagesOfType(sent, 'posted')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(protocol.rounds.current).toMatchObject({
      roundId,
      guessed: ['alice'],
      winner: { address: 'alice', name: 'Alice' }
    })
    sent.length = 0
    await protocol.handlePing({ seq: 1 }, 'alice')
    expect(messagesOfType(sent, 'roundWinner')).toHaveLength(1)
    sent.length = 0

    await protocol.handleRoundGuess({ ...guess, requestId: 'second-live-guess' }, 'alice')
    logSpy.mockRestore()

    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'charade-not-served', requestId: 'second-live-guess' },
        to: ['alice']
      }
    ])
    expect(protocol.rounds.current?.winner).toEqual({ address: 'alice', name: 'Alice' })
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
      { requestId: 'over-capacity', phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE },
      'player'
    )

    expect(messagesOfType(sent, 'posted')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      { type: 'requestError', data: { code: 'server-busy', requestId: 'over-capacity' }, to: ['player'] }
    ])
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

  it('rejects repeated, off-plan, and retired ambiguous performances before persistence or accounting', async () => {
    const snapshotLook = vi.fn(async (address: string) => makeLook(address))
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    await negotiate(protocol, 'player')
    snapshotLook.mockClear()
    checkpoint.mockClear()
    sent.length = 0
    const phrase = PLAYABLE_DECK[0]
    const canonical = canonicalPerformance(phrase)!
    const offPlanFirst = EMOTE_VOCABULARY.find(
      (emote) => !authorBeatChoices(phrase, 0).includes(emote) && emote !== canonical[1] && emote !== canonical[2]
    )!
    const retiredAmbiguous = ['food-share-the-popcorn', 'food-toast-a-marshmallow', 'food-serve-breakfast']
      .map((id) => DECK.find((candidate) => candidate.id === id)!)
      .find((candidate) => playablePhrase(candidate) === null)!

    await protocol.handlePost(
      {
        phraseId: phrase.id,
        emotes: [canonical[0], canonical[0], canonical[2]],
        requestId: 'repeated-performance'
      },
      'player'
    )
    await protocol.handlePost(
      {
        phraseId: phrase.id,
        emotes: [offPlanFirst, canonical[1], canonical[2]],
        requestId: 'off-plan-performance'
      },
      'player'
    )
    await protocol.handlePost(
      {
        phraseId: retiredAmbiguous.id,
        emotes: [...retiredAmbiguous.suggested],
        requestId: 'ambiguous-performance'
      },
      'player'
    )

    expect(messagesOfType(sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-post',
      'invalid-post',
      'invalid-post'
    ])
    expect(messagesOfType(sent, 'posted')).toEqual([])
    expect(snapshotLook).not.toHaveBeenCalled()
    expect(checkpoint).not.toHaveBeenCalled()
    expect(state.getPool()).toEqual([])
    expect(state.playerStats.get('player')).toMatchObject({ authored: [], authoredCount: 0, revision: 0 })
  })

  it('binds durable replay to the original performance after persisted semantics are rewritten', async () => {
    const storage = new FakeStorage()
    const phrase = PLAYABLE_DECK[0]
    const canonical = canonicalPerformance(phrase)!
    const legacyEmotes: [string, string, string] = [canonical[0], canonical[0], canonical[2]]
    const post = { phraseId: phrase.id, emotes: canonical, requestId: 'legacy-durable-post' }
    const first = await createHarness({}, storage)
    await negotiate(first.protocol, 'player')
    await first.protocol.handlePost(post, 'player')
    const posted = dataOf<PostedMessage>(messagesOfType(first.sent, 'posted').at(-1)!)
    const stored = first.state.getCharade(posted.charadeId)!
    first.state.upsertCharade({ ...stored, emotes: legacyEmotes })
    await first.repository.flushNow()

    const snapshotLook = vi.fn(async (address: string) => makeLook(address))
    const second = await createHarness({ snapshotLook }, storage)
    await negotiate(second.protocol, 'player')
    snapshotLook.mockClear()
    second.sent.length = 0

    await second.protocol.handlePost({ ...post, emotes: legacyEmotes }, 'player')

    expect(messagesOfType(second.sent, 'posted')).toEqual([])
    expect(messagesOfType(second.sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-post', requestId: post.requestId },
        to: ['player']
      }
    ])
    second.sent.length = 0

    await second.protocol.handlePost(post, 'player')

    expect(messagesOfType(second.sent, 'posted')).toHaveLength(1)
    expect(messagesOfType(second.sent, 'error')).toEqual([])
    expect(snapshotLook).not.toHaveBeenCalled()
    expect(second.state.getPlayerCharades()).toHaveLength(1)
    expect(second.state.playerStats.get('player')).toMatchObject({ authoredCount: 1, revision: 1 })
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
    const phrase = PLAYABLE_DECK[0]
    const post = { phraseId: phrase.id, emotes: canonicalPerformance(phrase)!, requestId: 'post-1' }

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
      { phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE, requestId: 'first-performance' },
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

  it('replays the exact one-time stamp and title response after cache expiry and restart', async () => {
    const storage = new FakeStorage()
    const player = `0x${'3'.repeat(40)}`
    let timestamp = FIXED_NOW
    let flushFirst = async () => undefined
    const first = await createHarness(
      {
        now: () => timestamp,
        snapshotLook: async (address) => makeLook(address, 'Performer'),
        flush: () => flushFirst()
      },
      storage
    )
    flushFirst = () => first.repository.flushNow().then(() => undefined)
    await negotiate(first.protocol, player)
    const stats = first.state.playerStats.get(player)!
    stats.daily = { day: dayKey(FIXED_NOW), decoded: 3, authored: 0, stamped: false }
    first.state.saveStats(player)
    await first.repository.flushNow()
    const post = {
      phraseId: TEST_PHRASE.id,
      emotes: TEST_PERFORMANCE,
      requestId: 'exact-restart-post'
    }
    first.sent.length = 0
    await first.protocol.handlePost(post, player)
    const posted = dataOf<Record<string, unknown>>(messagesOfType(first.sent, 'posted')[0])
    expect(posted).toMatchObject({ stampAwarded: true, title: 'Understudy', titleUnlocked: true })

    timestamp += 16_000
    first.sent.length = 0
    await first.protocol.handlePost(post, player)
    expect(messagesOfType(first.sent, 'posted').map((message) => message.data)).toEqual([posted])

    let flushSecond = async () => undefined
    const second = await createHarness(
      {
        now: () => timestamp,
        snapshotLook: async (address) => makeLook(address, 'Performer'),
        flush: () => flushSecond()
      },
      storage
    )
    flushSecond = () => second.repository.flushNow().then(() => undefined)
    await negotiate(second.protocol, player)
    second.sent.length = 0
    await second.protocol.handlePost(post, player)

    expect(messagesOfType(second.sent, 'posted').map((message) => message.data)).toEqual([posted])
    expect(second.state.getPlayerCharades()).toHaveLength(1)
    expect(second.state.playerStats.get(player)).toMatchObject({ authoredCount: 1, revision: 1 })
  })

  it('rejects a trailing emote on completed ordinary, mail, and reply requests after restart', async () => {
    const trailingEmotes = [...TEST_PERFORMANCE, TEST_PERFORMANCE[0]]

    const ordinaryStorage = new FakeStorage()
    const ordinary = { phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE, requestId: 'ordinary-three-emotes' }
    const ordinaryFirst = await createHarness({}, ordinaryStorage)
    await negotiate(ordinaryFirst.protocol, 'ordinary-player')
    await ordinaryFirst.protocol.handlePost(ordinary, 'ordinary-player')
    await ordinaryFirst.repository.flushNow()
    const ordinaryRestart = await createHarness({}, ordinaryStorage)
    await negotiate(ordinaryRestart.protocol, 'ordinary-player')
    ordinaryRestart.sent.length = 0

    await ordinaryRestart.protocol.handlePost({ ...ordinary, emotes: trailingEmotes }, 'ordinary-player')

    expect(messagesOfType(ordinaryRestart.sent, 'posted')).toEqual([])
    expect(messagesOfType(ordinaryRestart.sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-post', requestId: ordinary.requestId },
        to: ['ordinary-player']
      }
    ])

    const mailStorage = new FakeStorage()
    const mailSender = `0x${'1'.repeat(40)}`
    const mailRecipient = `0x${'2'.repeat(40)}`
    const mail = {
      phraseId: TEST_PHRASE.id,
      emotes: TEST_PERFORMANCE,
      requestId: 'mail-three-emotes',
      recipient: mailRecipient
    }
    const mailFirst = await createHarness({}, mailStorage)
    mailFirst.state.recentVisitors = [{ ...makeLook(mailRecipient, 'Recipient'), lastSeenAt: FIXED_NOW }]
    await negotiate(mailFirst.protocol, mailSender)
    await mailFirst.protocol.handlePost(mail, mailSender)
    await mailFirst.repository.flushNow()
    const mailRestart = await createHarness({}, mailStorage)
    await negotiate(mailRestart.protocol, mailSender)
    mailRestart.sent.length = 0

    await mailRestart.protocol.handlePost({ ...mail, emotes: trailingEmotes }, mailSender)

    expect(messagesOfType(mailRestart.sent, 'posted')).toEqual([])
    expect(messagesOfType(mailRestart.sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-post', requestId: mail.requestId },
        to: [mailSender]
      }
    ])

    const replyStorage = new FakeStorage()
    const replyTarget = makeCharade('reply-three-emotes-target', {
      author: { address: 'reply-author', name: 'Author' }
    })
    const reply = {
      phraseId: replyTarget.phraseId,
      emotes: TEST_PERFORMANCE,
      requestId: 'reply-three-emotes',
      replyTo: replyTarget.id
    }
    const replyFirst = await createHarness({}, replyStorage)
    replyFirst.state.upsertCharade(replyTarget)
    await negotiate(replyFirst.protocol, 'replier')
    replyFirst.state.playerStats.get('replier')!.seen.push(replyTarget.id)
    await replyFirst.protocol.handlePost(reply, 'replier')
    await replyFirst.repository.flushNow()
    const replyRestart = await createHarness({}, replyStorage)
    await negotiate(replyRestart.protocol, 'replier')
    replyRestart.sent.length = 0

    await replyRestart.protocol.handlePost({ ...reply, emotes: trailingEmotes }, 'replier')

    expect(messagesOfType(replyRestart.sent, 'posted')).toEqual([])
    expect(messagesOfType(replyRestart.sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-reply', requestId: reply.requestId },
        to: ['replier']
      }
    ])
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
    const post = { phraseId: TEST_PHRASE.id, emotes: TEST_PERFORMANCE, requestId: 'same-request' }

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
      { phraseId: PLAYABLE_DECK[0].id, emotes: canonicalPerformance(PLAYABLE_DECK[0])!, requestId: 'different-1' },
      'player'
    )
    const second = protocol.handlePost(
      { phraseId: PLAYABLE_DECK[1].id, emotes: canonicalPerformance(PLAYABLE_DECK[1])!, requestId: 'different-2' },
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
      phraseId: TEST_PHRASE.id,
      emotes: TEST_PERFORMANCE,
      recipient: recipientAddress
    }

    await harness.protocol.handlePost(post, senderAddress)

    expect(harness.state.getPlayerCharades()).toEqual([])
    expect(harness.state.playerStats.get(senderAddress)).toMatchObject({ authoredCount: 0, revision: 0 })
    expect(messagesOfType(harness.sent, 'posted')).toEqual([])
    expect(messagesOfType(harness.sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'storage-unavailable', requestId: 'staged-mail' },
        to: [senderAddress]
      }
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
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
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
        emotes: canonicalPerformance(mailedPhrase)!,
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
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
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
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
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
    const base = { phraseId: target.phraseId, emotes: TEST_PERFORMANCE, replyTo: target.id }

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
      emotes: TEST_PERFORMANCE,
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
    const payload = { phraseId: target.phraseId, emotes: TEST_PERFORMANCE, replyTo: target.id }

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

  it('rejects a second different reply request from the same canonical replier', async () => {
    const snapshotLook = vi.fn(async (address: string) => makeLook(address, 'Alice'))
    const { state, sent, checkpoint, protocol } = await createHarness({ snapshotLook })
    const target = makeCharade('idempotent-target', { author: { address: 'author', name: 'Author' } })
    state.upsertCharade(target)
    await negotiate(protocol, 'alice')
    state.playerStats.get('alice')!.seen.push(target.id)
    snapshotLook.mockClear()
    checkpoint.mockClear()
    sent.length = 0
    const firstEmotes = TEST_PERFORMANCE

    await protocol.handlePost(
      { phraseId: target.phraseId, emotes: firstEmotes, requestId: 'first-reply', replyTo: target.id },
      'alice'
    )
    await protocol.handlePost(
      { phraseId: target.phraseId, emotes: [...DECK[1].suggested], requestId: 'retry-reply', replyTo: target.id },
      'ALICE'
    )

    expect(messagesOfType(sent, 'posted').map((message) => dataOf<PostedMessage>(message).replyTo)).toEqual([target.id])
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-reply', requestId: 'retry-reply' },
        to: ['ALICE']
      }
    ])
    expect(state.getCharade(target.id)?.reply?.emotes).toEqual(firstEmotes)
    expect(state.playerStats.get('author')?.pending.replies).toBe(1)
    expect(snapshotLook).toHaveBeenCalledOnce()
    expect(checkpoint).toHaveBeenCalledOnce()
  })

  it('binds an attached reply to its exact request after the completed cache expires', async () => {
    let timestamp = FIXED_NOW
    const { state, sent, protocol } = await createHarness({ now: () => timestamp })
    const target = makeCharade('expired-reply-request', {
      author: { address: 'author', name: 'Author' },
      touringConsent: true
    })
    state.upsertCharade(target)
    await negotiate(protocol, 'alice')
    state.playerStats.get('alice')!.seen.push(target.id)
    const reply = {
      phraseId: target.phraseId,
      emotes: TEST_PERFORMANCE,
      requestId: 'expired-reply-id',
      replyTo: target.id
    }
    await protocol.handlePost(reply, 'alice')
    timestamp += 16_000
    sent.length = 0

    await protocol.handlePost({ ...reply, emotes: [...DECK[1].suggested] }, 'alice')

    expect(messagesOfType(sent, 'posted')).toEqual([])
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-reply', requestId: reply.requestId },
        to: ['alice']
      }
    ])
    expect(state.getCharade(target.id)?.reply?.emotes).toEqual(reply.emotes)
    expect(state.getCharade(target.id)?.touringConsent).toBe(true)
    sent.length = 0

    await protocol.handlePost(reply, 'alice')

    expect(messagesOfType(sent, 'posted')).toHaveLength(1)
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(state.getCharade(target.id)?.touringConsent).toBe(true)
  })

  it('binds an attached reply to its original durable request across restart', async () => {
    const storage = new FakeStorage()
    const first = await createHarness({}, storage)
    const target = makeCharade('durable-reply-request', {
      author: { address: 'author', name: 'Author' },
      touringConsent: true
    })
    first.state.upsertCharade(target)
    await negotiate(first.protocol, 'alice')
    first.state.playerStats.get('alice')!.seen.push(target.id)
    first.state.saveStats('alice')
    const canonical = canonicalPerformance(target.phraseId)!
    const reply = {
      phraseId: target.phraseId,
      emotes: canonical,
      requestId: 'durable-reply-id',
      replyTo: target.id
    }
    await first.protocol.handlePost(reply, 'alice')
    const attached = first.state.getCharade(target.id)!
    const retiredEmotes: [string, string, string] = [canonical[0], canonical[0], canonical[2]]
    const retiredReply = {
      ...reply,
      emotes: retiredEmotes
    }
    first.state.upsertCharade({
      ...attached,
      reply: { ...attached.reply!, emotes: retiredReply.emotes }
    })
    await first.repository.flushNow()

    const second = await createHarness({}, storage)
    await negotiate(second.protocol, 'alice')
    second.sent.length = 0

    await second.protocol.handlePost(reply, 'alice')

    expect(messagesOfType(second.sent, 'posted')).toHaveLength(1)
    expect(messagesOfType(second.sent, 'error')).toEqual([])
    expect(second.state.getCharade(target.id)?.reply?.emotes).toEqual(retiredReply.emotes)
    expect(second.state.getCharade(target.id)?.touringConsent).toBe(true)
    second.sent.length = 0

    await second.protocol.handlePost(retiredReply, 'alice')

    expect(messagesOfType(second.sent, 'posted')).toEqual([])
    expect(messagesOfType(second.sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-reply', requestId: reply.requestId },
        to: ['alice']
      }
    ])
    expect(second.state.getCharade(target.id)?.touringConsent).toBe(true)
  })

  it.each([
    { label: 'ordinary', mailed: false },
    { label: 'mail', mailed: true }
  ])('rejects durable $label-to-reply and reply-to-$label request-id reuse', async ({ mailed }) => {
    const storage = new FakeStorage()
    const sender = `0x${'1'.repeat(40)}`
    const recipient = `0x${'2'.repeat(40)}`
    const author = `0x${'3'.repeat(40)}`
    const first = await createHarness({ snapshotLook: async (address) => makeLook(address, address) }, storage)
    const repliedTarget = makeCharade('cross-shape-replied', {
      author: { address: author, name: 'Author' },
      touringConsent: true,
      createdAt: FIXED_NOW - 3
    })
    const emptyTarget = makeCharade('cross-shape-empty', {
      author: { address: author, name: 'Author' },
      createdAt: FIXED_NOW - 2
    })
    const recipientPerformance = makeCharade('cross-shape-recipient', {
      author: { address: recipient, name: 'Recipient' },
      createdAt: FIXED_NOW - 1
    })
    first.state.upsertCharade(repliedTarget)
    first.state.upsertCharade(emptyTarget)
    first.state.upsertCharade(recipientPerformance)
    await negotiate(first.protocol, sender)
    first.state.playerStats.get(sender)!.seen.push(repliedTarget.id, emptyTarget.id)
    first.state.saveStats(sender)
    const shapedRequest = {
      phraseId: TEST_PHRASE.id,
      emotes: TEST_PERFORMANCE,
      requestId: 'cross-shaped-post',
      ...(mailed ? { recipient } : {})
    }
    await first.protocol.handlePost(shapedRequest, sender)
    await first.protocol.handlePost(
      {
        phraseId: repliedTarget.phraseId,
        emotes: [authorBeatChoices(TEST_PHRASE, 0)[1], TEST_PERFORMANCE[1], TEST_PERFORMANCE[2]],
        requestId: 'cross-shaped-reply',
        replyTo: repliedTarget.id
      },
      sender
    )
    await first.repository.flushNow()

    const second = await createHarness(
      { now: () => FIXED_NOW + 61_000, snapshotLook: async (address) => makeLook(address, address) },
      storage
    )
    await negotiate(second.protocol, sender)
    second.sent.length = 0

    await second.protocol.handlePost(
      {
        phraseId: emptyTarget.phraseId,
        emotes: TEST_PERFORMANCE,
        requestId: shapedRequest.requestId,
        replyTo: emptyTarget.id
      },
      sender
    )
    await second.protocol.handlePost(
      {
        phraseId: TEST_PHRASE.id,
        emotes: TEST_PERFORMANCE,
        requestId: 'cross-shaped-reply',
        ...(mailed ? { recipient } : {})
      },
      sender
    )

    expect(messagesOfType(second.sent, 'posted')).toEqual([])
    expect(messagesOfType(second.sent, 'error').map((message) => dataOf<ErrorMessage>(message).code)).toEqual([
      'invalid-reply',
      'invalid-post'
    ])
    expect(second.state.getCharade(emptyTarget.id)?.reply).toBeUndefined()
    expect(second.state.getCharade(repliedTarget.id)?.touringConsent).toBe(true)
    expect(
      second.state.getPlayerCharades().filter((charade) => charade.author.address.toLowerCase() === sender)
    ).toHaveLength(1)
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
        emotes: TEST_PERFORMANCE,
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

describe('durable mutation journal capacity', () => {
  it('fits every real mutation shape with a max-count look and 64 worst-case replays', async () => {
    const sender = `0x${'1'.repeat(40)}`
    const recipient = `0x${'A'.repeat(40)}`
    const replier = `0x${'3'.repeat(40)}`
    const decoder = `0x${'4'.repeat(40)}`
    const policy = showPolicyForTimestamp(FIXED_NOW)!
    const phrase = PLAYABLE_DECK.filter((candidate) => policy.primaryPhraseIds.includes(candidate.id)).sort(
      (left, right) => JSON.stringify(right).length - JSON.stringify(left).length
    )[0]
    const performance = canonicalPerformance(phrase)!
    const maximalLook = (address: string) => ({
      ...makeLook(address, 'N'.repeat(128)),
      bodyShape: 'urn:'.padEnd(512, 'b'),
      wearables: Array.from({ length: 20 }, (_, index) =>
        `urn:decentraland:matic:collections-v2:max-${index}`.padEnd(80, String(index % 10))
      )
    })
    const captured: Array<{ label: string; mutation: DurableMutation; bytes: number }> = []

    async function capture(
      label: string,
      run: (harness: ProtocolHarness, failCheckpoint: () => void) => Promise<void>
    ) {
      let checkpointMustFail = false
      const harness = await createHarness({
        snapshotLook: async (address) => maximalLook(address),
        flush: async () => {
          if (checkpointMustFail) throw new StorageUnavailableError(['intentional-journal-cut'])
        }
      })
      await run(harness, () => {
        checkpointMustFail = true
      })
      const raw = harness.storage.readJSON<{ v: 1; active: DurableMutation | null; completed: unknown[] }>(
        DURABLE_MUTATION_JOURNAL_KEY
      )
      expect(raw?.active, label).not.toBeNull()
      const bytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength
      expect(bytes, label).toBeLessThanOrEqual(MAX_DURABLE_JOURNAL_BYTES)
      expect(bytes, label).toBeLessThanOrEqual(MAX_STORAGE_VALUE_BYTES)
      captured.push({ label, mutation: raw!.active!, bytes })
      return raw!.active!
    }

    const ordinary = await capture('ordinary post', async ({ protocol }, failCheckpoint) => {
      await negotiate(protocol, sender)
      failCheckpoint()
      await protocol.handlePost(
        {
          requestId: 'p'.repeat(64),
          phraseId: phrase.id,
          emotes: performance,
          touringConsent: true
        },
        sender
      )
    })
    expect(ordinary.charade?.author.bodyShape).toHaveLength(512)
    expect(ordinary.charade?.author.wearables).toHaveLength(20)
    expect(new TextEncoder().encode(JSON.stringify(ordinary.charade?.author)).byteLength).toBeLessThanOrEqual(2_800)

    await capture('mail post', async ({ state, protocol }, failCheckpoint) => {
      state.recentVisitors = [{ ...maximalLook(recipient), lastSeenAt: FIXED_NOW }]
      await negotiate(protocol, sender)
      failCheckpoint()
      await protocol.handlePost(
        {
          requestId: 'm'.repeat(64),
          phraseId: phrase.id,
          emotes: performance,
          recipient
        },
        sender
      )
    })

    await capture('reply post', async ({ state, protocol }, failCheckpoint) => {
      const target = structuredClone(ordinary.charade!)
      state.upsertCharade(target)
      await negotiate(protocol, replier)
      state.playerStats.get(replier)!.seen.push(target.id)
      failCheckpoint()
      await protocol.handlePost(
        {
          requestId: 'r'.repeat(64),
          phraseId: target.phraseId,
          emotes: performance,
          replyTo: target.id
        },
        replier
      )
    })

    await capture('final guess', async ({ state, sent, protocol }, failCheckpoint) => {
      const target = structuredClone(ordinary.charade!)
      state.upsertCharade(target)
      await negotiate(protocol, decoder)
      await protocol.handleNextCharade(nextCharadeRequest(), decoder)
      const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
      failCheckpoint()
      await protocol.handleGuess(
        {
          requestId: 'g'.repeat(64),
          charadeId: served.id,
          answerIndex: correctAnswerIndex(state, served),
          spotlight: true
        },
        decoder
      )
    })

    expect(captured.map(({ label }) => label)).toEqual(['ordinary post', 'mail post', 'reply post', 'final guess'])
    const completionSource = captured
      .map(({ mutation }) => ({
        mutation,
        bytes: new TextEncoder().encode(
          JSON.stringify({
            v: mutation.v,
            id: mutation.id,
            owner: mutation.owner,
            requestId: mutation.requestId,
            createdAt: mutation.createdAt,
            fingerprint: mutation.fingerprint,
            response: mutation.response,
            completedAt: FIXED_NOW
          })
        ).byteLength
      }))
      .sort((left, right) => right.bytes - left.bytes)[0].mutation
    const largestActive = captured.slice().sort((left, right) => right.bytes - left.bytes)[0].mutation
    const completed = Array.from({ length: MAX_DURABLE_COMPLETIONS }, (_, index) => {
      const requestId = `retained-${index}`.padEnd(64, String(index % 10))
      const response = structuredClone(completionSource.response)
      response.data.requestId = requestId
      return {
        v: 1 as const,
        id: `${completionSource.owner}:${completionSource.fingerprint.kind}:${requestId}`,
        owner: completionSource.owner,
        requestId,
        createdAt: completionSource.createdAt,
        fingerprint: completionSource.fingerprint,
        response,
        completedAt: FIXED_NOW + index
      }
    })
    const worstCaseJournal = { v: 1 as const, active: largestActive, completed }
    const worstCaseBytes = new TextEncoder().encode(JSON.stringify(worstCaseJournal)).byteLength

    expect(completed).toHaveLength(64)
    expect(worstCaseBytes).toBeLessThanOrEqual(MAX_DURABLE_JOURNAL_BYTES)
    expect(worstCaseBytes).toBeLessThanOrEqual(MAX_STORAGE_VALUE_BYTES)
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
    const bobWrong = wrongAnswerIndexes(state, bobCharade)
    await handleCurrentRoundGuess(
      protocol,
      {
        charadeId: bobCharade.id,
        answerIndex: bobWrong[0],
        requestId: 'bob-spectates-first'
      },
      'bob'
    )
    await handleCurrentRoundGuess(
      protocol,
      {
        charadeId: bobCharade.id,
        answerIndex: bobWrong[1],
        requestId: 'bob-spectates-final'
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
    const aliceWrong = wrongAnswerIndexes(state, aliceCharade)
    await handleCurrentRoundGuess(
      protocol,
      {
        charadeId: aliceCharade.id,
        answerIndex: aliceWrong[0],
        requestId: 'alice-spectates-first'
      },
      'alice'
    )
    await handleCurrentRoundGuess(
      protocol,
      {
        charadeId: aliceCharade.id,
        answerIndex: aliceWrong[1],
        requestId: 'alice-spectates-final'
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

    await handleCurrentRoundGuess(
      protocol,
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
        data: {
          instanceId: 'test-instance',
          roundId: '1',
          charadeId: charade.id,
          showKey: 'daily:2026-08-23',
          address: 'alice',
          name: 'Alice'
        },
        to: undefined
      }
    ])
    expect(messagesOfType(sent, 'reveal')).toHaveLength(1)
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
  })

  it('isolates per-player retry state on one shared live charade and preserves it across cached serving replay', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const charade = makeCharade('isolated-live-retry', { author: { address: 'outside', name: 'Outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    sent.length = 0
    const aliceNext = { requestId: 'alice-shared-next', exclude: [] as string[] }
    const bobNext = { requestId: 'bob-shared-next', exclude: [] as string[] }
    await protocol.handleNextCharade(aliceNext, 'alice')
    await protocol.handleNextCharade(bobNext, 'bob')
    const aliceServed = dataOf<CharadeMessage>(
      messagesOfType(sent, 'charade').find((message) => message.to?.[0] === 'alice')!
    )
    const bobServed = dataOf<CharadeMessage>(
      messagesOfType(sent, 'charade').find((message) => message.to?.[0] === 'bob')!
    )
    expect(aliceServed.answers).toEqual(bobServed.answers)
    const aliceWrong = wrongAnswerIndexes(state, aliceServed)[0]
    sent.length = 0

    await handleCurrentRoundGuess(
      protocol,
      { charadeId: charade.id, answerIndex: aliceWrong, requestId: 'alice-shared-first', spotlight: true },
      'alice'
    )
    expect(protocol.rounds.current?.guessed).toEqual([])
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 2, retryStates: 1, activeDecoders: 2 })
    await protocol.handleNextCharade(aliceNext, 'alice')
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 2, retryStates: 1, activeDecoders: 2 })

    await handleCurrentRoundGuess(
      protocol,
      {
        charadeId: charade.id,
        answerIndex: correctAnswerIndex(state, aliceServed),
        requestId: 'alice-shared-final',
        spotlight: false
      },
      'alice'
    )
    const aliceReveal = dataOf<Record<string, unknown>>(
      messagesOfType(sent, 'reveal').find((message) => message.to?.[0] === 'alice')!
    )
    expect(aliceReveal).toMatchObject({ correct: true, attempt: 2, spotlight: true, scoreDelta: 50 })
    expect(messagesOfType(sent, 'roundWinner')).toEqual([])
    expect(protocol.rounds.current).toMatchObject({ guessed: ['alice'], winner: null })
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 0, activeDecoders: 1 })

    await handleCurrentRoundGuess(
      protocol,
      {
        charadeId: charade.id,
        answerIndex: correctAnswerIndex(state, bobServed),
        requestId: 'bob-shared-first'
      },
      'bob'
    )
    const bobReveal = dataOf<Record<string, unknown>>(
      messagesOfType(sent, 'reveal').find((message) => message.to?.[0] === 'bob')!
    )
    expect(bobReveal).toMatchObject({ correct: true, attempt: 1, scoreDelta: 100 })
    expect(protocol.rounds.current?.winner).toEqual({ address: 'bob', name: 'Bob' })
    expect(messagesOfType(sent, 'roundWinner')).toEqual([
      {
        type: 'roundWinner',
        data: {
          instanceId: 'test-instance',
          roundId: '1',
          charadeId: charade.id,
          showKey: 'daily:2026-08-23',
          address: 'bob',
          name: 'Bob'
        },
        to: undefined
      }
    ])
    expect(state.playerStats.get('alice')).toMatchObject({ decoded: 1, correct: 0 })
    expect(state.playerStats.get('bob')).toMatchObject({ decoded: 1, correct: 1 })
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 2, correct: 1 })
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 0, retryStates: 0, activeDecoders: 0 })
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
      {
        type: 'roundStart',
        data: {
          instanceId: 'test-instance',
          roundId: '1',
          charadeId: charade.id,
          showKey: 'daily:2026-08-23'
        },
        to: undefined
      }
    ])
    const served = messagesOfType(sent, 'charade').map((message) => dataOf<CharadeMessage>(message))
    expect(served.map((message) => message.id)).toEqual([charade.id, charade.id])
    expect(served[0].answers).toEqual(served[1].answers)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const correctIndex = served[0].answers.indexOf(phrase.text)
    sent.length = 0

    await handleCurrentRoundGuess(
      protocol,
      { charadeId: charade.id, answerIndex: correctIndex, requestId: 'alice-guess' },
      'alice'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: charade.id, answerIndex: correctIndex, requestId: 'bob-guess' },
      'bob'
    )

    expect(messagesOfType(sent, 'roundWinner')).toEqual([
      {
        type: 'roundWinner',
        data: {
          instanceId: 'test-instance',
          roundId: '1',
          charadeId: charade.id,
          showKey: 'daily:2026-08-23',
          address: 'alice',
          name: 'Alice'
        },
        to: undefined
      }
    ])
    expect(messagesOfType(sent, 'reveal')).toHaveLength(2)
    expect(protocol.rounds.current?.winner).toEqual({ address: 'alice', name: 'Alice' })
  })

  it('serializes concurrent decoder commits without losing shared charade totals', async () => {
    const checkpointStarted = deferred<void>()
    const checkpointGate = deferred<void>()
    let holdCheckpoint = false
    const snapshotLook = async (address: string) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    const { state, sent, protocol } = await createHarness({
      snapshotLook,
      flush: async () => {
        if (!holdCheckpoint) return
        checkpointStarted.resolve()
        await checkpointGate.promise
      }
    })
    const charade = makeCharade('concurrent-live-total', {
      author: { ...makeLook('outside', 'Outside'), isGuest: false }
    })
    state.upsertCharade(charade)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const answerIndex = correctAnswerIndex(state, served)
    const roundId = protocol.rounds.current!.roundId
    holdCheckpoint = true

    const aliceGuess = protocol.handleRoundGuess(
      { roundId, charadeId: served.id, answerIndex, requestId: 'concurrent-alice' },
      'alice'
    )
    await checkpointStarted.promise
    const bobGuess = protocol.handleRoundGuess(
      { roundId, charadeId: served.id, answerIndex, requestId: 'concurrent-bob' },
      'bob'
    )
    await vi.waitFor(() => expect(protocol.resourceCounts().outstandingRequests).toBeGreaterThanOrEqual(2))
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 1 })
    checkpointGate.resolve()
    await Promise.all([aliceGuess, bobGuess])

    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 2, correct: 2 })
    expect(messagesOfType(sent, 'roundWinner')).toHaveLength(1)
    expect(
      messagesOfType(sent, 'reveal').filter((message) => ['alice', 'bob'].includes(message.to?.[0] ?? ''))
    ).toHaveLength(2)
  })

  it('queues a completed Show Set reset behind a healthy durable commit instead of skipping it', async () => {
    const checkpointStarted = deferred<void>()
    const checkpointGate = deferred<void>()
    let holdCheckpoint = false
    const { state, sent, protocol } = await createHarness({
      snapshotLook: async (address) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob'),
      flush: async () => {
        if (!holdCheckpoint) return
        checkpointStarted.resolve()
        await checkpointGate.promise
      }
    })
    const charade = makeCharade('queued-show-set-reset', { author: { address: 'outside', name: 'Outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const roundId = protocol.rounds.current!.roundId
    const bobStats = state.playerStats.get('bob')!
    bobStats.showSet = {
      showKey: 'daily:2026-08-23',
      round: 5,
      score: 500,
      streak: 2,
      bestStreak: 3,
      understood: 3
    }
    state.saveStats('bob')
    holdCheckpoint = true

    const guessing = protocol.handleRoundGuess(
      {
        roundId,
        charadeId: served.id,
        answerIndex: correctAnswerIndex(state, served),
        requestId: 'queued-show-set-guess'
      },
      'alice'
    )
    await checkpointStarted.promise
    const serving = protocol.handleNextCharade(nextCharadeRequest([served.id]), 'bob')
    await Promise.resolve()

    expect(bobStats.showSet.round).toBe(5)
    checkpointGate.resolve()
    await Promise.all([guessing, serving])

    expect(bobStats.showSet).toMatchObject({ showKey: 'daily:2026-08-23', round: 0, score: 0 })
    expect(messagesOfType(sent, 'error')).toEqual([])
    expect(messagesOfType(sent, 'charade').filter((message) => message.to?.[0] === 'bob')).toHaveLength(2)
  })

  it('does not award a restarted same-charade round to a stale round guess', async () => {
    const snapshotLook = async (address: string) => makeLook(address, address === 'alice' ? 'Alice' : 'Bob')
    const { state, sent, protocol } = await createHarness({ snapshotLook })
    const charade = makeCharade('restarted-live-stage', { author: { address: 'outside', name: 'Outside' } })
    state.upsertCharade(charade)
    await negotiate(protocol, 'alice')
    await negotiate(protocol, 'bob')
    await protocol.handleNextCharade(nextCharadeRequest(), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade')[0])
    const correctIndex = correctAnswerIndex(state, served)
    const staleRoundId = protocol.rounds.current!.roundId

    expect(protocol.rounds.reset()).toBe(true)
    sent.length = 0

    await protocol.handleGuess(
      { charadeId: charade.id, answerIndex: correctIndex, requestId: 'plain-reset-gap-guess' },
      'alice'
    )
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-guess', requestId: 'plain-reset-gap-guess' },
        to: ['alice']
      }
    ])
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
    sent.length = 0

    expect(protocol.rounds.start(charade.id)).toBe(true)
    const currentRoundId = protocol.rounds.current!.roundId
    sent.length = 0

    await protocol.handleRoundGuess(
      { roundId: '01', charadeId: charade.id, answerIndex: correctIndex, requestId: 'malformed-round-guess' },
      'alice'
    )
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-guess', requestId: 'malformed-round-guess' },
        to: ['alice']
      }
    ])
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    sent.length = 0

    await protocol.handleGuess(
      { charadeId: charade.id, answerIndex: correctIndex, requestId: 'plain-round-guess' },
      'alice'
    )
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-guess', requestId: 'plain-round-guess' },
        to: ['alice']
      }
    ])
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
    sent.length = 0

    await protocol.handleRoundGuess(
      { roundId: staleRoundId, charadeId: charade.id, answerIndex: correctIndex, requestId: 'stale-round-guess' },
      'alice'
    )
    expect(messagesOfType(sent, 'error')).toEqual([
      {
        type: 'requestError',
        data: { code: 'invalid-guess', requestId: 'stale-round-guess' },
        to: ['alice']
      }
    ])
    expect(messagesOfType(sent, 'reveal')).toEqual([])
    expect(state.getCharade(charade.id)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(state.playerStats.get('alice')?.decoded).toBe(0)
    sent.length = 0

    await protocol.handleRoundGuess(
      { roundId: currentRoundId, charadeId: charade.id, answerIndex: correctIndex, requestId: 'current-round-guess' },
      'bob'
    )

    expect(messagesOfType(sent, 'roundWinner')).toEqual([
      {
        type: 'roundWinner',
        data: {
          instanceId: 'test-instance',
          roundId: currentRoundId,
          charadeId: charade.id,
          showKey: 'daily:2026-08-23',
          address: 'bob',
          name: 'Bob'
        },
        to: undefined
      }
    ])
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
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: served.id, answerIndex: firstCorrect, requestId: 'alice-first' },
      'alice'
    )
    const bobWrong = wrongAnswerIndexes(state, served)
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: served.id, answerIndex: bobWrong[0], requestId: 'bob-first-miss' },
      'bob'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: served.id, answerIndex: bobWrong[1], requestId: 'bob-second-miss' },
      'bob'
    )
    await protocol.handleNextCharade(nextCharadeRequest([served.id]), 'alice')
    await protocol.handleNextCharade(nextCharadeRequest([served.id]), 'bob')
    const nextServed = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    sent.length = 0

    const nextCorrect = correctAnswerIndex(state, nextServed)
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: nextServed.id, answerIndex: nextCorrect, requestId: 'bob-second' },
      'bob'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: nextServed.id, answerIndex: nextCorrect, requestId: 'alice-second' },
      'alice'
    )

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
    const wrongIndexes = wrongAnswerIndexes(state, firstRound)
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: firstRound.id, answerIndex: wrongIndexes[0], requestId: 'alice-first-wrong' },
      'alice'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: firstRound.id, answerIndex: wrongIndexes[0], requestId: 'bob-first-wrong' },
      'bob'
    )
    expect(protocol.rounds.isSettled).toBe(false)
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: firstRound.id, answerIndex: wrongIndexes[1], requestId: 'alice-second-wrong' },
      'alice'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: firstRound.id, answerIndex: wrongIndexes[1], requestId: 'bob-second-wrong' },
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
      {
        type: 'roundStart',
        data: {
          instanceId: 'test-instance',
          roundId: '1',
          charadeId: second.id,
          showKey: 'daily:2026-08-23'
        },
        to: undefined
      }
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
    const wrongIndexes = wrongAnswerIndexes(state, firstRound)
    await handleCurrentRoundGuess(
      protocol,
      {
        charadeId: firstRound.id,
        answerIndex: wrongIndexes[0],
        requestId: 'alice-first-wrong'
      },
      'alice'
    )
    await handleCurrentRoundGuess(
      protocol,
      {
        charadeId: firstRound.id,
        answerIndex: wrongIndexes[1],
        requestId: 'alice-second-wrong'
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

    const wrongIndexes = wrongAnswerIndexes(state, served)
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: live.id, answerIndex: wrongIndexes[0], requestId: 'alice-first-wrong' },
      'alice'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: live.id, answerIndex: wrongIndexes[0], requestId: 'bob-first-wrong' },
      'bob'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: live.id, answerIndex: wrongIndexes[1], requestId: 'alice-second-wrong' },
      'alice'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: live.id, answerIndex: wrongIndexes[1], requestId: 'bob-second-wrong' },
      'bob'
    )

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

    const wrongIndexes = wrongAnswerIndexes(state, liveMessage)
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: live.id, answerIndex: wrongIndexes[0], requestId: 'alice-first-wrong' },
      'alice'
    )
    expect(protocol.rounds.isSettled).toBe(false)
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: live.id, answerIndex: wrongIndexes[0], requestId: 'bob-first-wrong' },
      'bob'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: live.id, answerIndex: wrongIndexes[1], requestId: 'alice-second-wrong' },
      'alice'
    )
    await handleCurrentRoundGuess(
      protocol,
      { charadeId: live.id, answerIndex: wrongIndexes[1], requestId: 'bob-second-wrong' },
      'bob'
    )

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
    await protocol.handleNextCharade(nextCharadeRequest(), 'bob')
    const served = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)!
    const roundId = protocol.rounds.current!.roundId
    await protocol.handleLeave('bob')
    sent.length = 0

    await protocol.handleRoundGuess(
      {
        roundId,
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
    const phrase = PLAYABLE_DECK.find((candidate) => candidate.theme === themeForTimestamp(FIXED_NOW).id)!
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
        look: { ...makeLook(`0x${'b'.repeat(40)}`, 'B'.repeat(30)), wearables },
        emotes: canonicalPerformance(phrase)!
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
    await protocol.handleNextCharade({ requestId: 'maximal-wire-next', exclude: [] }, 'player')

    const charade = dataOf<CharadeMessage>(messagesOfType(sent, 'charade').at(-1)!)
    const reply = dataOf<CharadeReplyMessage>(messagesOfType(sent, 'charadeReply').at(-1)!)
    const since = messagesOfType(sent, 'since').at(-1)!.data
    const boards = messagesOfType(sent, 'boards').at(-1)!.data
    const ready = messagesOfType(sent, 'ready').at(-1)!.data
    const firstMiss = wrongAnswerIndexes(state, charade)[0]
    await protocol.handleGuess(
      { requestId: 'maximal-retry', charadeId: charade.id, answerIndex: firstMiss, spotlight: false },
      'player'
    )
    const retry = dataOf<RetryMessage>(messagesOfType(sent, 'retry').at(-1)!)
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
    const wireMeasurements = {
      charade: bytes(charade),
      mailCharade: bytes({ ...charade, recipient: `0x${'c'.repeat(40)}` }),
      charadeReply: bytes(reply),
      since: bytes(since),
      boards: bytes(boards),
      ready: bytes(ready),
      retry: bytes(retry)
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
      charade: 2_566,
      mailCharade: 2_623,
      charadeReply: 2_269,
      since: 244,
      boards: 3_049,
      ready: 110,
      retry: 109,
      inlineCharade: 4_807
    })
  })

  it('trims unusually long wearable URNs until every emitted payload stays below 4,000 bytes', async () => {
    const wearables = Array.from({ length: 20 }, (_, index) =>
      `urn:decentraland:matic:collections-v2:oversized-${index.toString().padStart(2, '0')}`.padEnd(200, 'x')
    )
    const { state, sent, protocol } = await createHarness()
    const phrase = PLAYABLE_DECK.find((candidate) => candidate.theme === themeForTimestamp(FIXED_NOW).id)!
    const longAddress = `0x${'a'.repeat(198)}`
    const longName = 'Performer'.repeat(25)
    const target = makeCharade('oversized-wire-look', {
      phraseId: phrase.id,
      author: { address: longAddress, name: longName, wearables },
      guesses: { total: 1, correct: 0 },
      reply: makeReply(`0x${'b'.repeat(198)}`, longName, {
        look: { ...makeLook(`0x${'b'.repeat(198)}`, longName), wearables },
        emotes: canonicalPerformance(phrase)!
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
