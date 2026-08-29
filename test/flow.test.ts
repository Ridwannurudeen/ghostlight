import { describe, expect, it, vi } from 'vitest'
import { DECK, EMOTE_VOCABULARY, type Emote } from '../src/shared/deck'
import { showPolicyForTimestamp } from '../src/shared/show-policy'
import { SEASON_ZERO_WEEKS } from '../src/shared/seasons'
import {
  AUTHOR_EMOTE_PAGE_COUNT,
  authorEmotePage,
  canSpectatorReact,
  createFlowRuntime,
  createInitialFlowState,
  flowReducer,
  type DecodeCharade,
  type OutboundMessage,
  type ServerMessage
} from '../src/client/flow'
import { FIXED_NOW, makeLook } from './test-helpers'

vi.mock('@dcl/sdk/ecs', () => ({
  engine: { addSystem: vi.fn() },
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
    isReady: () => false
  })
}))

vi.mock('@dcl/sdk/src/players', () => ({
  getPlayer: () => null
}))

function makeDecodeCharade(id = 'charade-1'): DecodeCharade {
  return {
    id,
    authorName: 'Author',
    authorAddress: '0xAuthor',
    look: makeLook('0xAuthor', 'Author'),
    emotes: ['wave', 'clap', 'dab'],
    answers: ['Answer one', 'Answer two', 'Answer three'],
    createdAt: FIXED_NOW,
    isHouse: false,
    authorTitle: '',
    reply: null
  }
}

function createFlowHarness(
  overrides: {
    address?: string
    transportReady?: boolean
    look?: ReturnType<typeof makeLook> | null
    getProfile?: () => { address: string; name: string; isGuest: boolean } | null
    canDecode?: () => boolean
    now?: number
  } = {}
) {
  let currentTime = overrides.now ?? FIXED_NOW
  let requestSequence = 0
  let transportReady = overrides.transportReady ?? true
  const address = overrides.address ?? '0xPlayer'
  const sent: OutboundMessage[] = []
  const effects = {
    showPerformer: vi.fn(),
    showDuet: vi.fn(),
    replayPerformer: vi.fn(),
    showRetryBeat: vi.fn(),
    showPreview: vi.fn(),
    clearPreview: vi.fn(),
    clearPerformer: vi.fn(),
    showReward: vi.fn(),
    showStageReward: vi.fn(),
    clearStageReward: vi.fn(),
    showGhostOfNight: vi.fn(),
    beginReveal: vi.fn(),
    resolveReveal: vi.fn(),
    canAdvanceReveal: vi.fn(() => true),
    skipReveal: vi.fn(() => true),
    cancelReveal: vi.fn(),
    cancelOpening: vi.fn()
  }
  const runtime = createFlowRuntime({
    send: (message) => {
      sent.push(message)
    },
    now: () => currentTime,
    createRequestId: () => `request-${++requestSequence}`,
    getProfile: overrides.getProfile ?? (() => ({ address, name: 'Player', isGuest: false })),
    getLook: () => (overrides.look === undefined ? makeLook(address, 'Player') : overrides.look),
    isTransportReady: () => transportReady,
    canDecode: overrides.canDecode,
    effects
  })

  return {
    runtime,
    sent,
    effects,
    advance(milliseconds: number, deltaSeconds = 0) {
      currentTime += milliseconds
      runtime.tick(deltaSeconds)
    },
    setNow(timestamp: number) {
      currentTime = timestamp
    },
    setTransportReady(ready: boolean) {
      transportReady = ready
    }
  }
}

function receiveShowSchedule(
  runtime: ReturnType<typeof createFlowRuntime>,
  timestamp: number,
  instanceId = 'server'
) {
  const policy = showPolicyForTimestamp(timestamp)
  expect(policy).not.toBeNull()
  runtime.receive({
    type: 'showSchedule',
    data: {
      instanceId,
      serverTime: timestamp,
      showKey: policy!.showKey,
      ...(policy!.kind === 'season-zero' ? { season: policy!.season } : {})
    }
  })
  return policy!
}

function serveCharade(
  runtime: ReturnType<typeof createFlowRuntime>,
  charade: Omit<Extract<ServerMessage, { type: 'charade' }>['data'], 'requestId'>
) {
  const state = runtime.getState()
  if (state.instanceId && !state.showKey) {
    receiveShowSchedule(runtime, state.acceptedServerTime, state.instanceId)
  }
  let request = runtime.getState().pending.find((candidate) => candidate.kind === 'nextCharade')
  if (!request) {
    expect(runtime.requestNextCharade()).toBe(true)
    request = runtime.getState().pending.find((candidate) => candidate.kind === 'nextCharade')
  }
  runtime.receive({ type: 'charade', data: { ...charade, requestId: request!.requestId } })
}

function receiveReveal(
  runtime: ReturnType<typeof createFlowRuntime>,
  data: Omit<Extract<ServerMessage, { type: 'reveal' }>['data'], 'requestId' | 'revision'>,
  revision = 0
) {
  const request = runtime
    .getState()
    .pending.find((candidate) => candidate.kind === 'guess' || candidate.kind === 'roundGuess')
  expect(request).toBeDefined()
  runtime.receive({ type: 'reveal', data: { ...data, requestId: request!.requestId, revision } })
}

function receivePosted(
  runtime: ReturnType<typeof createFlowRuntime>,
  data: Omit<Extract<ServerMessage, { type: 'posted' }>['data'], 'requestId' | 'revision'>,
  revision = 0
) {
  const request = runtime.getState().pending.find((candidate) => candidate.kind === 'post')
  expect(request).toBeDefined()
  runtime.receive({ type: 'posted', data: { ...data, requestId: request!.requestId, revision } })
}

function receiveSince(
  runtime: ReturnType<typeof createFlowRuntime>,
  data: Omit<Extract<ServerMessage, { type: 'since' }>['data'], 'revision'>,
  revision = 0
) {
  runtime.receive({ type: 'since', data: { ...data, revision } })
}

function announceRound(runtime: ReturnType<typeof createFlowRuntime>, charadeId: string, roundId = '1') {
  const state = runtime.getState()
  runtime.receive({
    type: 'roundStart',
    data: { instanceId: state.instanceId, roundId, charadeId, showKey: state.showKey }
  })
}

function announceWinner(
  runtime: ReturnType<typeof createFlowRuntime>,
  data: { address: string; name: string; charadeId: string; roundId?: string }
) {
  const state = runtime.getState()
  runtime.receive({
    type: 'roundWinner',
    data: { ...data, instanceId: state.instanceId, roundId: data.roundId ?? '1', showKey: state.showKey }
  })
}

function messagesOfType<T extends OutboundMessage['type']>(sent: OutboundMessage[], type: T) {
  return sent.filter((message): message is Extract<OutboundMessage, { type: T }> => message.type === type)
}

describe('flow reducer', () => {
  it('keeps spectator reactions cosmetic and outside decode state transitions', () => {
    const charade = makeDecodeCharade()
    let state = {
      ...createInitialFlowState(),
      ready: true,
      screen: 'decode' as const,
      charade,
      roundCharadeId: charade.id
    }

    state = flowReducer(state, { type: 'reaction', kind: 'applause', from: '0xSpectator', now: FIXED_NOW })

    expect(state).toMatchObject({
      screen: 'decode',
      charade,
      reveal: null,
      roundCharadeId: charade.id,
      pending: [],
      reactionEvent: { kind: 'applause', from: '0xSpectator', shownAt: FIXED_NOW }
    })
    expect(flowReducer(state, { type: 'toggleReactionMenu' }).reactionMenuOpen).toBe(false)
  })

  it('preserves the active screen through heartbeat loss and recovery', () => {
    const charade = makeDecodeCharade()
    let state = flowReducer(createInitialFlowState(), {
      type: 'ready',
      instanceId: 'one',
      serverTime: FIXED_NOW,
      now: FIXED_NOW
    })
    state = flowReducer(state, { type: 'charade', charade })
    state = flowReducer(state, { type: 'heartbeatTimeout' })

    expect(state).toMatchObject({ ready: false, screen: 'waking', resumeScreen: 'decode' })

    state = flowReducer(state, { type: 'pong', now: FIXED_NOW + 1 })
    expect(state).toMatchObject({ ready: true, screen: 'decode', resumeScreen: null })
  })

  it('shows a since summary only once per session', () => {
    let state = flowReducer(createInitialFlowState(), {
      type: 'ready',
      instanceId: 'one',
      serverTime: FIXED_NOW,
      now: FIXED_NOW
    })
    state = flowReducer(state, { type: 'since', summary: { triedYou: 2, gotYou: 1, rank: 4, revision: 0 } })
    expect(state.screen).toBe('since')

    state = flowReducer(state, { type: 'dismissSince' })
    state = flowReducer(state, { type: 'since', summary: { triedYou: 3, gotYou: 2, rank: 3, revision: 0 } })
    expect(state).toMatchObject({ screen: 'foyer', sinceShown: true })
  })

  it('keeps a prefetched charade behind the returning-player report until it is dismissed', () => {
    let state = flowReducer(createInitialFlowState(), {
      type: 'ready',
      instanceId: 'one',
      serverTime: FIXED_NOW,
      now: FIXED_NOW,
      theme: 'everyday',
      themeLabel: 'Everyday Escapades',
      playerAddress: '0xPlayer',
      playerName: 'Player'
    })
    state = flowReducer(state, {
      type: 'since',
      summary: {
        triedYou: 2,
        gotYou: 1,
        replies: 0,
        mail: 2,
        revision: 0,
        rank: 4,
        daily: state.progress.daily,
        title: '',
        nextUnlock: state.progress.nextUnlock
      }
    })
    state = flowReducer(state, { type: 'charade', charade: makeDecodeCharade() })

    expect(state).toMatchObject({ screen: 'since', charade: { id: 'charade-1' } })
    expect(flowReducer(state, { type: 'dismissSince' }).screen).toBe('decode')
  })

  it('returns from authoring to reveal or foyer without discarding the draft', () => {
    const phrase = DECK[0]
    const draft = {
      phrase,
      offeredEmotes: [...phrase.suggested],
      emotePage: 0,
      selectedEmotes: [phrase.suggested[0]],
      shufflesRemaining: 2,
      phase: 'emotes' as const
    }
    const authorState = flowReducer(createInitialFlowState(), { type: 'author', draft, returnScreen: 'foyer' })

    const foyerState = flowReducer(authorState, { type: 'authorBack' })
    expect(foyerState.screen).toBe('foyer')
    expect(foyerState.author).toBe(draft)

    const revealedState = flowReducer(
      { ...authorState, authorReturnScreen: 'reveal' },
      {
        type: 'reveal',
        reveal: {
          revision: 0,
          charadeId: 'revealed',
          correct: true,
          phrase: 'A revealed phrase',
          stats: { total: 1, correct: 1 },
          yourScore: 1
        }
      }
    )
    const revealState = flowReducer(revealedState, { type: 'authorBack' })
    expect(revealState.screen).toBe('reveal')
    expect(revealState.author).toBe(draft)
  })

  it('shows the how-to-play screen through the shared navigation action', () => {
    const state = flowReducer(createInitialFlowState(), { type: 'show', screen: 'howToPlay' })

    expect(state.screen).toBe('howToPlay')
  })
})

describe('flow lifecycle', () => {
  it('authors Ghost Mail only to selectable real playbill performers', () => {
    const sender = `0x${'1'.repeat(40)}`
    const recipient = `0x${'2'.repeat(40)}`
    const guest = `0x${'3'.repeat(40)}`
    const { runtime, sent } = createFlowHarness({ address: sender })
    runtime.receive({ type: 'ready', data: { instanceId: 'server-1', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW, 'server-1')
    runtime.receive({
      type: 'boards',
      data: {
        topDecoders: [],
        hardestGhosts: [],
        ghostOfNightId: '',
        playbill: [
          { address: recipient, name: 'Recipient', isGuest: false, title: '', performedAt: FIXED_NOW },
          { address: guest, name: 'Guest', isGuest: true, title: '', performedAt: FIXED_NOW },
          { address: sender, name: 'Self', isGuest: false, title: '', performedAt: FIXED_NOW }
        ]
      }
    })

    expect(runtime.canSendMail()).toBe(true)
    expect(runtime.showMail()).toBe(true)
    expect(runtime.getState().screen).toBe('mail')
    expect(runtime.selectGhostMailRecipient(`0x${'4'.repeat(40)}`)).toBe(false)
    expect(runtime.selectGhostMailRecipient(guest)).toBe(false)
    expect(runtime.beginGhostMail()).toBe(false)
    expect(runtime.selectGhostMailRecipient(recipient)).toBe(true)
    expect(runtime.getState().mailRecipient).toEqual({ address: recipient, name: 'Recipient' })
    expect(runtime.beginGhostMail()).toBe(true)
    expect(runtime.getState()).toMatchObject({
      screen: 'author',
      authorReturnScreen: 'mail',
      author: {
        recipient: { address: recipient, name: 'Recipient' },
        offeredEmotes: expect.arrayContaining(EMOTE_VOCABULARY),
        emotePage: 0
      }
    })
    const firstPhrase = runtime.getState().author!.phrase.id
    expect(runtime.shuffleAuthorPhrase()).toBe(true)
    expect(runtime.getState().author).toMatchObject({ recipient: { address: recipient, name: 'Recipient' } })
    expect(runtime.getState().author!.phrase.id).not.toBe(firstPhrase)
    runtime
      .getState()
      .author!.offeredEmotes.slice(0, 3)
      .forEach((emote) => runtime.selectAuthorEmote(emote))
    expect(runtime.postAuthor()).toBe(true)
    expect(messagesOfType(sent, 'post').at(-1)?.data).toMatchObject({ recipient })
    expect(messagesOfType(sent, 'post').at(-1)?.data).not.toHaveProperty('replyTo')

    receivePosted(runtime, { charadeId: 'mailed', recipient })
    expect(runtime.getState()).toMatchObject({
      screen: 'posted',
      postedCharadeId: 'mailed',
      postedRecipient: recipient
    })
  })

  it('blocks Ghost Mail for guests even when a real performer is in the playbill', () => {
    const guestSender = `0x${'5'.repeat(40)}`
    const recipient = `0x${'6'.repeat(40)}`
    const { runtime } = createFlowHarness({
      address: guestSender,
      getProfile: () => ({ address: guestSender, name: 'Guest', isGuest: true })
    })
    runtime.receive({ type: 'ready', data: { instanceId: 'server-1', serverTime: FIXED_NOW } })
    runtime.receive({
      type: 'boards',
      data: {
        topDecoders: [],
        hardestGhosts: [],
        ghostOfNightId: '',
        playbill: [{ address: recipient, name: 'Recipient', isGuest: false, title: '', performedAt: FIXED_NOW }]
      }
    })

    expect(runtime.canSendMail()).toBe(false)
    expect(runtime.showMail()).toBe(false)
    expect(runtime.selectGhostMailRecipient(recipient)).toBe(false)
    expect(runtime.beginGhostMail()).toBe(false)
    expect(runtime.getState().screen).toBe('foyer')
  })

  it('keeps guests out of every authoring path after the server rejects persistent guest posts', () => {
    const guestAddress = 'guest-session'
    const { runtime } = createFlowHarness({
      address: guestAddress,
      getProfile: () => ({ address: guestAddress, name: 'Guest', isGuest: true })
    })
    runtime.receive({ type: 'ready', data: { instanceId: 'server-1', serverTime: FIXED_NOW } })

    expect(runtime.beginAuthoring()).toBe(false)
    expect(runtime.getState().screen).toBe('foyer')

    const charade = makeDecodeCharade('guest-decode')
    serveCharade(runtime, charade)
    runtime.guess(0)
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: true,
      phraseId: DECK[0].id,
      phrase: DECK[0].text,
      stats: { total: 1, correct: 1 },
      yourScore: 1
    })

    expect(runtime.canAnswerBack()).toBe(false)
    expect(runtime.beginAnswerBack()).toBe(false)
    expect(runtime.getState().screen).toBe('reveal')
  })

  it('pairs a separate reply message with its charade even when it arrives first', () => {
    const { runtime, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server-1', serverTime: FIXED_NOW } })
    const charade = makeDecodeCharade()
    const reply = {
      charadeId: charade.id,
      address: '0xReply',
      name: 'Reply',
      look: makeLook('0xReply', 'Reply'),
      emotes: ['dance', 'wave', 'clap'],
      createdAt: FIXED_NOW + 1
    }

    runtime.receive({ type: 'charadeReply', data: reply })
    serveCharade(runtime, charade)

    expect(runtime.getState().charade?.reply).toEqual({
      address: reply.address,
      name: reply.name,
      look: reply.look,
      emotes: reply.emotes,
      createdAt: reply.createdAt
    })
    expect(effects.showDuet).toHaveBeenCalledWith(
      { look: charade.look, emotes: charade.emotes },
      expect.objectContaining({ address: '0xReply', emotes: reply.emotes })
    )
    expect(effects.showPerformer).not.toHaveBeenCalled()
  })

  it('uses the revealed server phrase for an answer-back and posts it without shuffle or progression changes', () => {
    const { runtime, sent, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server-1', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW, 'server-1')
    const charade = makeDecodeCharade()
    serveCharade(runtime, charade)
    runtime.guess(0)
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: true,
      phraseId: DECK[0].id,
      phrase: DECK[0].text,
      stats: { total: 1, correct: 1 },
      yourScore: 1
    })

    expect(runtime.canAnswerBack()).toBe(true)
    effects.clearPreview.mockClear()
    expect(runtime.beginAnswerBack()).toBe(true)
    const draft = runtime.getState().author!
    expect(draft).toMatchObject({
      phrase: DECK[0],
      offeredEmotes: expect.arrayContaining(EMOTE_VOCABULARY),
      emotePage: 0,
      shufflesRemaining: 0,
      replyTo: charade.id
    })
    expect(runtime.shuffleAuthorPhrase()).toBe(false)
    draft.offeredEmotes.slice(0, 3).forEach((emote) => runtime.selectAuthorEmote(emote))
    expect(runtime.previewAuthor()).toBe(true)
    runtime.backFromAuthor()
    expect(effects.clearPreview).toHaveBeenCalledTimes(1)
    expect(effects.showPerformer).toHaveBeenCalledWith(charade.look, charade.emotes)
    expect(effects.showStageReward).toHaveBeenCalledWith(charade.authorAddress, charade.authorTitle)
    expect(runtime.beginAnswerBack()).toBe(true)
    runtime
      .getState()
      .author!.offeredEmotes.slice(0, 3)
      .forEach((emote) => runtime.selectAuthorEmote(emote))
    expect(runtime.postAuthor()).toBe(true)
    expect(messagesOfType(sent, 'post').at(-1)?.data).toMatchObject({
      phraseId: DECK[0].id,
      replyTo: charade.id
    })

    receivePosted(runtime, { charadeId: charade.id, replyTo: charade.id })
    expect(runtime.getState()).toMatchObject({ screen: 'posted', postedReplyTo: charade.id })
  })

  it('blocks answer-backs to house, self-authored, and already-paired charades', () => {
    const { runtime } = createFlowHarness({ address: '0xPlayer' })
    runtime.receive({ type: 'ready', data: { instanceId: 'server-1', serverTime: FIXED_NOW } })
    const scenarios = [
      { ...makeDecodeCharade('house'), isHouse: true },
      { ...makeDecodeCharade('self'), authorAddress: '0xPLAYER' }
    ]
    for (const charade of scenarios) {
      serveCharade(runtime, charade)
      runtime.guess(0)
      receiveReveal(runtime, {
        charadeId: charade.id,
        correct: true,
        phraseId: DECK[0].id,
        phrase: DECK[0].text,
        stats: { total: 1, correct: 1 },
        yourScore: 1
      })
      expect(runtime.canAnswerBack()).toBe(false)
      expect(runtime.beginAnswerBack()).toBe(false)
    }

    const paired = makeDecodeCharade('paired')
    serveCharade(runtime, paired)
    runtime.receive({
      type: 'charadeReply',
      data: {
        charadeId: paired.id,
        address: '0xReply',
        name: 'Reply',
        look: makeLook('0xReply', 'Reply'),
        emotes: ['wave', 'clap', 'dab'],
        createdAt: FIXED_NOW
      }
    })
    runtime.guess(0)
    receiveReveal(runtime, {
      charadeId: paired.id,
      correct: true,
      phraseId: DECK[0].id,
      phrase: DECK[0].text,
      stats: { total: 1, correct: 1 },
      yourScore: 1
    })
    expect(runtime.canAnswerBack()).toBe(false)
    expect(runtime.beginAnswerBack()).toBe(false)
  })

  it('derives the show theme locally and stores authoritative progression, playbill, and Ghost of the Night', () => {
    const authorAddress = `0x${'a'.repeat(40)}`
    const { runtime, effects } = createFlowHarness()
    runtime.receive({
      type: 'ready',
      data: {
        instanceId: 'server-1',
        serverTime: FIXED_NOW + 5_000,
        theme: 'food',
        themeLabel: 'Kitchen Capers'
      }
    })
    runtime.receive({
      type: 'progress',
      data: {
        revision: 1,
        daily: { day: '2026-08-23', decoded: 2, authored: 1, stamped: false },
        title: 'Understudy',
        nextUnlock: { nextTitle: 'Scene Stealer', requirement: '10 correct decodes or 5 posts', progress: 0.4 }
      }
    })
    runtime.receive({ type: 'playerTitle', data: { address: authorAddress, title: 'Scene Stealer' } })
    runtime.receive({
      type: 'boards',
      data: {
        topDecoders: [],
        hardestGhosts: [],
        playbill: [
          {
            address: authorAddress,
            name: 'Author',
            isGuest: false,
            title: 'Scene Stealer',
            performedAt: FIXED_NOW - 3_600_000
          }
        ],
        ghostOfNightId: 'hardest'
      }
    })
    const ghost = {
      charadeId: 'hardest',
      address: authorAddress,
      name: 'Author',
      title: 'Scene Stealer',
      look: makeLook(authorAddress, 'Author'),
      total: 5,
      correct: 1
    }
    runtime.receive({ type: 'ghostOfNight', data: ghost })
    const expectedPolicy = showPolicyForTimestamp(FIXED_NOW + 5_000)!

    expect(runtime.getState()).toMatchObject({
      theme: expectedPolicy.legacyTheme.id,
      themeLabel: expectedPolicy.legacyTheme.label,
      serverClockOffset: 5_000,
      playerName: 'PLAYER',
      progress: { title: 'Understudy', nextUnlock: { progress: 0.4 } },
      boards: { playbill: [{ name: 'Author' }], ghostOfNightId: 'hardest' },
      ghostOfNight: ghost
    })
    expect(effects.showReward).toHaveBeenCalledWith('0xPlayer', 'Understudy')
    expect(effects.showReward).toHaveBeenCalledWith(authorAddress, 'Scene Stealer')
    expect(effects.showGhostOfNight).toHaveBeenCalledWith(ghost)
  })

  it('queues simultaneous stamp and title notices once from an idempotent reveal', () => {
    const { runtime, effects } = createFlowHarness()
    runtime.receive({
      type: 'ready',
      data: {
        instanceId: 'server',
        serverTime: FIXED_NOW,
        theme: 'everyday',
        themeLabel: 'Everyday Escapades'
      }
    })
    const charade = makeDecodeCharade()
    serveCharade(runtime, { ...charade, authorTitle: '' })
    const reveal = {
      charadeId: charade.id,
      correct: true,
      phrase: 'Answer one',
      stats: { total: 10, correct: 4 },
      yourScore: 10,
      daily: { day: '2026-08-23', decoded: 3, authored: 1, stamped: true },
      stampAwarded: true,
      title: 'Scene Stealer',
      nextUnlock: {
        nextTitle: 'Ghostlight Legend',
        requirement: '3 daily stamps and 25 correct decodes',
        progress: 0.4
      },
      titleUnlocked: true
    } as const

    runtime.guess(0)
    const requestId = runtime.getState().pending.find((request) => request.kind === 'guess')!.requestId
    runtime.receive({ type: 'reveal', data: { ...reveal, requestId, revision: 1 } })
    runtime.receive({ type: 'reveal', data: { ...reveal, requestId, revision: 1 } })

    expect(runtime.getState().progress).toMatchObject({ title: 'Scene Stealer', daily: { stamped: true } })
    expect(runtime.getState().notices).toEqual([
      { id: `${charade.id}:stamp`, kind: 'stamp' },
      { id: `${charade.id}:title:Scene Stealer`, kind: 'title', title: 'Scene Stealer' }
    ])
  })

  it('ignores delayed reveal and posted replies after their exact requests have completed', () => {
    const { runtime, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)

    const first = makeDecodeCharade('first')
    serveCharade(runtime, first)
    runtime.guess(0)
    const guessRequestId = runtime.getState().pending.find(({ kind }) => kind === 'guess')!.requestId
    const firstReveal = {
      requestId: guessRequestId,
      revision: 1,
      charadeId: first.id,
      correct: true,
      phrase: first.answers[0],
      stats: { total: 1, correct: 1 },
      yourScore: 1
    }
    runtime.receive({ type: 'reveal', data: firstReveal })

    const second = makeDecodeCharade('second')
    serveCharade(runtime, second)
    runtime.receive({ type: 'reveal', data: firstReveal })
    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: second.id } })
    expect(effects.resolveReveal).toHaveBeenCalledTimes(1)

    runtime.beginAuthoring()
    runtime
      .getState()
      .author!.offeredEmotes.slice(0, 3)
      .forEach((emote) => runtime.selectAuthorEmote(emote))
    runtime.postAuthor()
    const postRequestId = runtime.getState().pending.find(({ kind }) => kind === 'post')!.requestId
    const posted = { requestId: postRequestId, revision: 2, charadeId: 'posted-first' }
    runtime.receive({ type: 'posted', data: posted })
    serveCharade(runtime, makeDecodeCharade('third'))
    runtime.receive({ type: 'posted', data: posted })
    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: 'third' } })
  })

  it('keeps the newest progression revision when messages arrive out of order', () => {
    const { runtime, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const daily = { day: '2026-08-24', decoded: 3, authored: 1, stamped: true }
    const nextUnlock = {
      nextTitle: 'Scene Stealer',
      requirement: '10 correct decodes or 5 posts',
      progress: 0.4
    }

    runtime.receive({
      type: 'progress',
      data: { revision: 2, daily, title: 'Understudy', nextUnlock }
    })
    runtime.receive({
      type: 'progress',
      data: {
        revision: 1,
        daily: { ...daily, decoded: 0, stamped: false },
        title: '',
        nextUnlock: { ...nextUnlock, progress: 0 }
      }
    })

    expect(runtime.getState()).toMatchObject({
      progressRevision: 2,
      progress: { daily, title: 'Understudy', nextUnlock }
    })
    expect(effects.showReward).not.toHaveBeenCalledWith('0xPlayer', '')
  })

  it('caps and sanitizes authoritative board entries before rendering', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const playbill = Array.from({ length: 7 }, (_, index) => ({
      address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      name: index === 0 ? 'HOUSE\u202e GHOST' : ` Player ${index} `,
      isGuest: false,
      title: index === 0 ? 'HOUSE GHOST' : '',
      performedAt: FIXED_NOW
    }))

    runtime.receive({
      type: 'boards',
      data: { topDecoders: [], hardestGhosts: [], playbill, ghostOfNightId: '' }
    })

    expect(runtime.getState().boards.playbill).toHaveLength(6)
    expect(runtime.getState().boards.playbill[0]).toMatchObject({ name: 'PLAYER', title: '' })
    expect(runtime.getState().boards.playbill[1].name).toBe('Player 1')
  })

  it('closes waking to ready to decode to reveal to author to posted', () => {
    const { runtime, sent, effects } = createFlowHarness()
    expect(runtime.getState().screen).toBe('waking')

    runtime.tick(0)
    expect(messagesOfType(sent, 'hello')).toHaveLength(1)
    expect(messagesOfType(sent, 'ping')).toHaveLength(1)
    runtime.receive({ type: 'ready', data: { instanceId: 'server-1', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW, 'server-1')
    expect(runtime.getState()).toMatchObject({ ready: true, screen: 'foyer' })
    sent.length = 0

    expect(runtime.requestNextCharade()).toBe(true)
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
    const charade = makeDecodeCharade()
    serveCharade(runtime, charade)
    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade })
    expect(effects.showPerformer).toHaveBeenCalledWith(charade.look, charade.emotes)
    expect(effects.showStageReward).toHaveBeenCalledWith(charade.authorAddress, charade.authorTitle)

    expect(runtime.guess(1)).toBe(true)
    expect(runtime.guess(1)).toBe(false)
    expect(messagesOfType(sent, 'guess')).toHaveLength(1)
    expect(effects.beginReveal).toHaveBeenCalledWith(charade, 1)
    const reveal = {
      charadeId: charade.id,
      correct: true,
      phrase: 'Answer two',
      stats: { total: 4, correct: 3 },
      yourScore: 2
    }
    receiveReveal(runtime, reveal)
    expect(runtime.getState()).toMatchObject({ screen: 'reveal', reveal })
    expect(effects.resolveReveal).toHaveBeenCalledWith(expect.objectContaining(reveal), charade)

    expect(runtime.beginAuthoring()).toBe(true)
    expect(effects.clearStageReward).toHaveBeenCalled()
    const draft = runtime.getState().author!
    expect(runtime.getState().screen).toBe('author')
    for (const emote of draft.offeredEmotes.slice(0, 3)) expect(runtime.selectAuthorEmote(emote)).toBe(true)
    expect(runtime.previewAuthor()).toBe(true)
    expect(effects.showPreview).toHaveBeenCalledWith(makeLook('0xPlayer', 'Player'), draft.offeredEmotes.slice(0, 3))
    expect(runtime.postAuthor()).toBe(true)
    expect(runtime.postAuthor()).toBe(false)
    expect(messagesOfType(sent, 'post')).toHaveLength(1)

    receivePosted(runtime, { charadeId: 'posted-1' })
    expect(runtime.getState()).toMatchObject({ screen: 'posted', postedCharadeId: 'posted-1', pending: [] })
  })

  it('locks Spotlight into an idempotent finale guess and accepts only the authoritative set result', () => {
    const { runtime, sent, effects, advance } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server-1', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW, 'server-1')
    const finale = {
      ...makeDecodeCharade('finale'),
      setRound: 5,
      setSize: 5,
      setScore: 300,
      setStreak: 2,
      isFinale: true
    }
    serveCharade(runtime, finale)

    expect(runtime.getState()).toMatchObject({ spotlightEnabled: false, charade: finale })
    expect(runtime.toggleSpotlight()).toBe(true)
    expect(runtime.getState().spotlightEnabled).toBe(true)
    expect(runtime.guess(2)).toBe(true)
    expect(runtime.toggleSpotlight()).toBe(false)
    expect(effects.beginReveal).toHaveBeenCalledWith(expect.objectContaining({ id: finale.id }), 2, {
      isFinale: true
    })
    expect(messagesOfType(sent, 'guess').at(-1)?.data).toEqual({
      charadeId: finale.id,
      answerIndex: 2,
      requestId: 'request-2',
      spotlight: true
    })

    advance(5_000)
    const guesses = messagesOfType(sent, 'guess')
    expect(guesses.slice(-2)).toEqual([guesses.at(-1), guesses.at(-1)])

    receiveReveal(runtime, {
      charadeId: finale.id,
      correct: false,
      phrase: finale.answers[0],
      stats: { total: 1, correct: 0 },
      yourScore: 0,
      spotlight: true,
      scoreDelta: -100,
      setRound: 5,
      setSize: 5,
      setScore: 200,
      setStreak: 0,
      setBestStreak: 2,
      setUnderstood: 3,
      setComplete: true,
      isFinale: true
    })

    expect(runtime.getState().reveal).toMatchObject({
      spotlight: true,
      scoreDelta: -100,
      setScore: 200,
      setStreak: 0,
      setBestStreak: 2,
      setUnderstood: 3,
      setComplete: true
    })

    effects.cancelReveal.mockClear()
    expect(runtime.beginAuthoring('reveal', false, true)).toBe(true)
    expect(effects.cancelReveal).not.toHaveBeenCalled()
    runtime.backFromAuthor()
    expect(runtime.getState()).toMatchObject({ screen: 'reveal', reveal: { setComplete: true } })

    expect(runtime.requestNextCharade()).toBe(true)
    serveCharade(runtime, { ...makeDecodeCharade('new-set'), setRound: 1, setSize: 5, setScore: 0, setStreak: 0 })
    expect(runtime.getState()).toMatchObject({
      screen: 'decode',
      spotlightEnabled: false,
      charade: { id: 'new-set', setRound: 1, setScore: 0 }
    })
  })

  it('skips an active reveal cleanly before requesting the next charade', () => {
    const { runtime, sent, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const charade = makeDecodeCharade()
    serveCharade(runtime, charade)
    runtime.guess(0)
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: false,
      phrase: 'Answer two',
      stats: { total: 4, correct: 1 },
      yourScore: 0
    })
    sent.length = 0

    expect(runtime.requestNextCharade()).toBe(true)
    expect(effects.skipReveal).toHaveBeenCalledTimes(1)
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
  })

  it('blocks before the verdict but advances after normal completion even when there is no tail to skip', () => {
    const { runtime, sent, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const charade = makeDecodeCharade()
    serveCharade(runtime, charade)
    runtime.guess(0)
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: true,
      phrase: 'Answer one',
      stats: { total: 1, correct: 1 },
      yourScore: 1
    })
    sent.length = 0
    effects.canAdvanceReveal.mockReturnValueOnce(false)

    expect(runtime.requestNextCharade()).toBe(false)
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(0)
    expect(runtime.getState().pending).toEqual([])
    expect(effects.skipReveal).not.toHaveBeenCalled()

    effects.canAdvanceReveal.mockReturnValueOnce(true)
    effects.skipReveal.mockReturnValueOnce(false)
    expect(runtime.requestNextCharade()).toBe(true)
    expect(effects.skipReveal).toHaveBeenCalledTimes(1)
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
  })

  it('blocks every player-driven reveal action until the phrase has been disclosed', () => {
    const { runtime, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const charade = makeDecodeCharade()
    serveCharade(runtime, charade)
    runtime.dispatch({ type: 'roundStart', roundId: '1', charadeId: charade.id, sequence: 1 })
    runtime.guess(0)
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: false,
      phraseId: DECK[0].id,
      phrase: DECK[0].text,
      stats: { total: 1, correct: 0 },
      yourScore: 0,
      attempt: 2
    })
    effects.canAdvanceReveal.mockReturnValue(false)

    expect(runtime.requestNextCharade()).toBe(false)
    expect(runtime.beginAuthoring()).toBe(false)
    expect(runtime.beginAnswerBack()).toBe(false)
    runtime.toggleReactionMenu()
    expect(runtime.getState().reactionMenuOpen).toBe(false)
  })

  it('cancels reveal choreography before opening Boards', () => {
    const { runtime, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const charade = makeDecodeCharade()
    serveCharade(runtime, charade)
    runtime.guess(0)
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: true,
      phrase: charade.answers[0],
      stats: { total: 1, correct: 1 },
      yourScore: 1
    })
    effects.cancelReveal.mockClear()

    runtime.showBoards()

    expect(runtime.getState().screen).toBe('boards')
    expect(effects.cancelReveal).toHaveBeenCalledTimes(1)
  })

  it('opens how to play from both the foyer and Settings navigation paths', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })

    runtime.showHowToPlay()
    expect(runtime.getState().screen).toBe('howToPlay')

    runtime.showSettings()
    expect(runtime.getState().screen).toBe('settings')

    runtime.showHowToPlay()
    expect(runtime.getState().screen).toBe('howToPlay')

    runtime.showFoyer()
    expect(runtime.getState().screen).toBe('foyer')
  })

  it('rejects an invalid server emote array and resolves the pending fetch', () => {
    const { runtime, sent, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    sent.length = 0
    runtime.requestNextCharade()
    const valid = makeDecodeCharade()

    serveCharade(runtime, { ...valid, emotes: ['wave', 'clap'] })

    expect(runtime.getState()).toMatchObject({ charade: null, errorCode: 'invalid_charade', pending: [] })
    expect(effects.showPerformer).not.toHaveBeenCalled()
  })

  it('retains validated phrase ids in server answer order and rejects malformed ids', () => {
    const { runtime, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const charade = makeDecodeCharade()
    const answerIds = [DECK[0].id, DECK[1].id, DECK[2].id]

    serveCharade(runtime, { ...charade, answerIds })
    expect(runtime.getState().charade?.answerIds).toEqual(answerIds)

    runtime.requestNextCharade()
    serveCharade(runtime, { ...makeDecodeCharade('invalid-ids'), answerIds: [DECK[0].id, 'missing', DECK[2].id] })
    expect(runtime.getState()).toMatchObject({ errorCode: 'invalid_charade', pending: [] })
    expect(effects.showPerformer).toHaveBeenCalledTimes(1)
  })

  it('falls back to a plain guess after any server error on the decode screen', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('live'))
    announceRound(runtime, 'live')
    sent.length = 0

    expect(runtime.guess(0)).toBe(true)
    const requestId = runtime.getState().pending.find((request) => request.kind === 'roundGuess')!.requestId
    runtime.receive({ type: 'requestError', data: { code: 'temporary-failure', requestId } })

    expect(runtime.getState()).toMatchObject({ screen: 'decode', roundCharadeId: '', pending: [] })
    expect(runtime.guess(1)).toBe(true)
    expect(messagesOfType(sent, 'roundGuess')).toHaveLength(1)
    expect(messagesOfType(sent, 'guess')).toHaveLength(1)
  })

  it('fetches a fresh charade after same-instance re-entry drops the served answers', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('stale'))
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: 'stale' } })
    sent.length = 0

    expect(runtime.guess(0)).toBe(true)
    const requestId = runtime.getState().pending.find((request) => request.kind === 'guess')!.requestId
    runtime.receive({ type: 'requestError', data: { code: 'charade-not-served', requestId } })

    expect(messagesOfType(sent, 'nextCharade')).toEqual([
      { type: 'nextCharade', data: { requestId: 'request-3', exclude: ['stale'] } }
    ])
    expect(runtime.getState()).toMatchObject({ screen: 'decode', pending: [{ kind: 'nextCharade' }] })

    serveCharade(runtime, makeDecodeCharade('fresh'))
    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: 'fresh' }, pending: [] })
  })
})

describe('heartbeats and request retries', () => {
  it('cancels an unresolved reveal when the guess retry times out', () => {
    const { runtime, effects, advance } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade())
    effects.cancelReveal.mockClear()
    expect(runtime.guess(0)).toBe(true)

    advance(5_000)
    advance(5_000)

    expect(effects.cancelReveal).toHaveBeenCalledTimes(1)
    expect(runtime.getState()).toMatchObject({ pending: [], errorCode: 'request_timeout' })
  })

  it('ignores a stale next-charade response after a timed-out request is replaced', () => {
    const { runtime, advance } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    expect(runtime.requestNextCharade()).toBe(true)
    const staleRequestId = runtime.getState().pending[0].requestId
    advance(5_000)
    advance(5_000)
    expect(runtime.requestNextCharade()).toBe(true)
    const activeRequestId = runtime.getState().pending[0].requestId

    runtime.receive({
      type: 'charade',
      data: { ...makeDecodeCharade('stale'), requestId: staleRequestId }
    })
    expect(runtime.getState()).toMatchObject({ charade: null, pending: [{ requestId: activeRequestId }] })

    runtime.receive({
      type: 'charade',
      data: { ...makeDecodeCharade('fresh'), requestId: activeRequestId }
    })
    expect(runtime.getState()).toMatchObject({ charade: { id: 'fresh' }, pending: [] })
  })

  it('ignores a delayed request error after a newer request has replaced it', () => {
    const { runtime, advance } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    expect(runtime.requestNextCharade()).toBe(true)
    const staleRequestId = runtime.getState().pending[0].requestId
    advance(5_000)
    advance(5_000)
    expect(runtime.requestNextCharade()).toBe(true)
    const activeRequest = runtime.getState().pending[0]

    runtime.receive({
      type: 'requestError',
      data: { code: 'charade-not-served', requestId: staleRequestId }
    })

    expect(runtime.getState()).toMatchObject({ pending: [activeRequest], errorCode: '' })
  })

  it('surfaces an untagged delayed error without cancelling current work', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('live'))
    announceRound(runtime, 'live')
    expect(runtime.guess(0)).toBe(true)
    const activeRequest = runtime.getState().pending[0]

    runtime.receive({ type: 'error', data: { code: 'reaction-rate-limited' } })

    expect(runtime.getState()).toMatchObject({
      roundId: '1',
      roundCharadeId: 'live',
      pending: [activeRequest],
      errorCode: 'reaction-rate-limited'
    })
  })

  it('waits for a complete profile before hello and identity commitment', () => {
    let profile = { address: '', name: '', isGuest: false }
    const { runtime, sent } = createFlowHarness({ getProfile: () => profile })

    runtime.tick(0)
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    expect(messagesOfType(sent, 'hello')).toHaveLength(0)
    expect(runtime.getState()).toMatchObject({ playerAddress: '', playerName: '' })

    profile = { address: '0xPlayer', name: 'Player', isGuest: false }
    runtime.tick(0)
    expect(messagesOfType(sent, 'hello')).toHaveLength(1)
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    expect(runtime.getState()).toMatchObject({ playerAddress: '0xPlayer', playerName: 'PLAYER' })
  })

  it('bounds profile names in hello and retries negotiation after protocol-required', () => {
    let profile = { address: '0xPlayer', name: '👻'.repeat(10_000), isGuest: false }
    const { runtime, sent } = createFlowHarness({ getProfile: () => profile })

    runtime.tick(0)
    const firstHello = messagesOfType(sent, 'hello')[0]
    expect(new TextEncoder().encode(firstHello.data.displayName).length).toBeLessThanOrEqual(32)

    runtime.receive({ type: 'error', data: { code: 'protocol-required' } })
    expect(messagesOfType(sent, 'hello')).toHaveLength(2)

    profile = { ...profile, name: ' \u202e\u2066  ' }
    runtime.receive({ type: 'error', data: { code: 'protocol-required' } })
    expect(messagesOfType(sent, 'hello').at(-1)?.data.displayName).toBe('PLAYER')
  })
  it('moves to waking after a heartbeat timeout and recovers the previous screen on pong', () => {
    const { runtime, sent, advance } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade())
    sent.length = 0

    advance(20_000)
    expect(runtime.getState()).toMatchObject({ ready: false, screen: 'waking', resumeScreen: 'decode' })
    expect(messagesOfType(sent, 'ping')).toHaveLength(1)

    runtime.receive({ type: 'pong', data: { seq: 1 } })
    expect(runtime.getState()).toMatchObject({ ready: true, screen: 'decode', resumeScreen: null })
    expect(messagesOfType(sent, 'hello')).toHaveLength(1)

    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    expect(runtime.getState()).toMatchObject({ ready: true, screen: 'decode', charade: { id: 'charade-1' } })
  })

  it('fetches a round announced during heartbeat recovery after decode resumes', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('old'))
    runtime.dispatch({ type: 'heartbeatTimeout' })
    sent.length = 0

    announceRound(runtime, 'live')
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(0)
    runtime.receive({ type: 'pong', data: { seq: 1 } })

    expect(runtime.getState()).toMatchObject({ screen: 'decode', roundCharadeId: 'live' })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
  })

  it('sends one identical retry after five seconds and times out after the next five', () => {
    const { runtime, sent, advance } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    sent.length = 0
    expect(runtime.requestNextCharade()).toBe(true)
    expect(runtime.requestNextCharade()).toBe(false)
    const first = messagesOfType(sent, 'nextCharade')[0]

    advance(5_000)
    expect(messagesOfType(sent, 'nextCharade')).toEqual([first, first])
    expect(runtime.getState().pending[0]).toMatchObject({ retries: 1, sentAt: FIXED_NOW + 5_000 })

    advance(5_000)
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(2)
    expect(runtime.getState()).toMatchObject({ pending: [], errorCode: 'request_timeout' })
  })

  it('stops sending while transport is down and sends hello plus ping when it returns', () => {
    const { runtime, sent, setTransportReady } = createFlowHarness({ transportReady: false })
    runtime.tick(0)
    expect(sent).toEqual([])

    setTransportReady(true)
    runtime.tick(0)
    expect(messagesOfType(sent, 'hello')).toHaveLength(1)
    expect(messagesOfType(sent, 'ping')).toHaveLength(1)
  })

  it('resends hello on the pre-ready heartbeat when the cold server drops the first attempt', () => {
    const { runtime, sent, advance } = createFlowHarness()
    runtime.tick(0)
    expect(messagesOfType(sent, 'hello')).toHaveLength(1)

    advance(2_000, 2)

    expect(messagesOfType(sent, 'hello')).toHaveLength(2)
    expect(messagesOfType(sent, 'ping')).toHaveLength(2)
  })
})

describe('audience and rounds', () => {
  it('ignores delayed round starts and winners from an older round', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })

    announceRound(runtime, 'round-a', '1')
    announceRound(runtime, 'round-b', '2')
    announceWinner(runtime, {
      roundId: '1',
      charadeId: 'round-a',
      address: 'remote-a',
      name: 'Remote A'
    })
    announceRound(runtime, 'round-a', '1')

    expect(runtime.getState()).toMatchObject({
      roundId: '2',
      roundCharadeId: 'round-b',
      latestRoundSequence: 2,
      roundWinner: null
    })

    announceWinner(runtime, {
      roundId: '2',
      charadeId: 'round-b',
      address: 'remote-b',
      name: 'Remote B'
    })
    expect(runtime.getState()).toMatchObject({
      roundId: '2',
      roundCharadeId: 'round-b',
      roundWinner: { address: 'remote-b', name: 'Remote B' }
    })
  })

  it('rejects malformed or unsafe round identifiers', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })

    announceRound(runtime, 'bad-leading-zero', '01')
    announceRound(runtime, 'bad-zero', '0')
    announceRound(runtime, 'bad-overflow', '9007199254740992')

    expect(runtime.getState()).toMatchObject({ roundId: '', roundCharadeId: '', latestRoundSequence: 0 })
  })
  it('merges audience chunks case-insensitively, caps six, and resets only for a new server instance', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'one', serverTime: FIXED_NOW } })
    for (const look of [
      makeLook('A', 'A'),
      makeLook('B', 'Old B'),
      makeLook('b', 'New B'),
      makeLook('C'),
      makeLook('D'),
      makeLook('E'),
      makeLook('F'),
      makeLook('G')
    ]) {
      runtime.receive({ type: 'audience', data: { looks: [look] } })
    }

    expect(runtime.getState().audience.map((look) => look.name)).toEqual(['New B', 'C', 'D', 'E', 'F', 'G'])
    runtime.receive({ type: 'ready', data: { instanceId: 'one', serverTime: FIXED_NOW } })
    expect(runtime.getState().audience).toHaveLength(6)
    runtime.receive({ type: 'ready', data: { instanceId: 'two', serverTime: FIXED_NOW } })
    expect(runtime.getState().audience).toEqual([])
  })

  it('fetches a mismatched round charade once and uses roundGuess after it arrives', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('old'))
    sent.length = 0

    announceRound(runtime, 'live')
    announceRound(runtime, 'live')
    expect(runtime.getState().roundCharadeId).toBe('live')
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)

    serveCharade(runtime, makeDecodeCharade('live'))
    expect(runtime.guess(0)).toBe(true)
    expect(messagesOfType(sent, 'roundGuess')).toEqual([
      {
        type: 'roundGuess',
        data: { roundId: '1', charadeId: 'live', answerIndex: 0, requestId: 'request-3' }
      }
    ])
    expect(messagesOfType(sent, 'guess')).toHaveLength(0)
  })

  it('retains round identity so a participant can guess after another player wins', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('live'))
    announceRound(runtime, 'live')
    announceWinner(runtime, { address: 'remote', name: 'Remote', charadeId: 'live' })
    sent.length = 0

    expect(runtime.guess(0)).toBe(true)
    expect(messagesOfType(sent, 'roundGuess')).toEqual([
      {
        type: 'roundGuess',
        data: { roundId: '1', charadeId: 'live', answerIndex: 0, requestId: 'request-2' }
      }
    ])
    expect(messagesOfType(sent, 'guess')).toEqual([])
  })

  it('accepts the next charade after one round mismatch refetch', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('old'))
    sent.length = 0

    announceRound(runtime, 'departed-round')
    serveCharade(runtime, makeDecodeCharade('plain-1'))
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(2)
    expect(runtime.getState().charade?.id).toBe('old')

    serveCharade(runtime, makeDecodeCharade('plain-2'))
    runtime.receive({ type: 'pong', data: { seq: 1 } })
    runtime.receive({ type: 'pong', data: { seq: 2 } })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(2)
    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: 'plain-2' } })
    expect(runtime.guess(0)).toBe(true)
    expect(messagesOfType(sent, 'guess')).toHaveLength(1)
  })

  it('waits for a pending guess before fetching a newly announced round', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('old'))
    runtime.guess(0)
    sent.length = 0

    announceRound(runtime, 'live')

    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: 'old' }, roundCharadeId: 'live' })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(0)

    receiveReveal(runtime, {
      charadeId: 'old',
      correct: false,
      phrase: 'Answer one',
      stats: { total: 1, correct: 0 },
      yourScore: 0
    })
    expect(runtime.getState()).toMatchObject({ screen: 'reveal', charade: { id: 'old' } })
    expect(runtime.requestNextCharade()).toBe(true)
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
  })

  it('fetches a newly announced round after the pending guess returns an error', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('old'))
    runtime.guess(0)
    sent.length = 0

    announceRound(runtime, 'live')
    const requestId = runtime.getState().pending.find((request) => request.kind === 'guess')!.requestId
    runtime.receive({ type: 'requestError', data: { code: 'temporary-failure', requestId } })

    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: 'old' }, roundCharadeId: 'live' })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
  })

  it('keeps an incorrect round reveal eligible for reactions until a winner settles the round', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('live'))
    announceRound(runtime, 'live')

    runtime.guess(0)
    receiveReveal(runtime, {
      charadeId: 'live',
      correct: false,
      phrase: 'Answer one',
      stats: { total: 1, correct: 0 },
      yourScore: 0
    })

    expect(runtime.getState()).toMatchObject({ screen: 'reveal', roundCharadeId: 'live' })
    expect(canSpectatorReact(runtime.getState())).toBe(true)

    announceWinner(runtime, { address: 'remote', name: 'Remote', charadeId: 'live' })

    expect(runtime.getState().roundCharadeId).toBe('live')
    expect(canSpectatorReact(runtime.getState())).toBe(false)
  })

  it.each(['foyer', 'since', 'reveal', 'author', 'posted', 'boards', 'invite', 'howToPlay'] as const)(
    'keeps the %s screen when a round starts',
    (screen) => {
      const { runtime, sent } = createFlowHarness()
      runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
      receiveShowSchedule(runtime, FIXED_NOW)
      if (screen === 'since') {
        receiveSince(runtime, { triedYou: 2, gotYou: 1, rank: 4 })
      } else if (screen === 'reveal') {
        serveCharade(runtime, makeDecodeCharade('old'))
        runtime.guess(0)
        receiveReveal(runtime, {
          charadeId: 'old',
          correct: false,
          phrase: 'Answer one',
          stats: { total: 1, correct: 0 },
          yourScore: 0
        })
      } else if (screen === 'author' || screen === 'posted') {
        runtime.beginAuthoring()
        if (screen === 'posted') {
          runtime.dispatch({
            type: 'posted',
            result: {
              charadeId: 'authored',
              revision: 0,
              ...runtime.getState().progress,
              stampAwarded: false,
              titleUnlocked: false
            }
          })
        }
      } else if (screen === 'boards') {
        runtime.showBoards()
      } else if (screen === 'invite') {
        runtime.showInvite()
      } else if (screen === 'howToPlay') {
        runtime.showHowToPlay()
      }
      sent.length = 0

      announceRound(runtime, 'live')

      expect(runtime.getState()).toMatchObject({ screen, roundCharadeId: 'live' })
      if (screen === 'since') {
        expect(runtime.getState()).toMatchObject({ since: { triedYou: 2, gotYou: 1, rank: 4 }, sinceShown: false })
      }
      expect(messagesOfType(sent, 'nextCharade')).toHaveLength(0)
    }
  )

  it.each(['foyer', 'since', 'decode', 'author'] as const)(
    'clears an abandoned round on %s without changing screens or fetching',
    (screen) => {
      const { runtime, sent } = createFlowHarness()
      runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
      receiveShowSchedule(runtime, FIXED_NOW)
      if (screen === 'since') {
        receiveSince(runtime, { triedYou: 2, gotYou: 1, rank: 4 })
      } else if (screen === 'decode') {
        serveCharade(runtime, makeDecodeCharade('mismatched'))
      } else if (screen === 'author') {
        runtime.beginAuthoring()
      }
      runtime.dispatch({ type: 'roundStart', roundId: '1', charadeId: 'live', sequence: 1 })
      sent.length = 0

      announceRound(runtime, '', '2')

      expect(runtime.getState()).toMatchObject({ screen, roundCharadeId: '' })
      if (screen === 'decode') expect(runtime.getState().charade?.id).toBe('mismatched')
      expect(messagesOfType(sent, 'nextCharade')).toHaveLength(0)
    }
  )

  it('drops stale decode and round state when a new server instance is ready', () => {
    const { runtime, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'one', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade('live'))
    announceRound(runtime, 'live')
    runtime.dispatch({ type: 'heartbeatTimeout' })
    expect(runtime.getState().resumeScreen).toBe('decode')
    effects.cancelReveal.mockClear()
    effects.clearPerformer.mockClear()
    effects.clearStageReward.mockClear()

    runtime.receive({ type: 'ready', data: { instanceId: 'two', serverTime: FIXED_NOW } })

    expect(runtime.getState()).toMatchObject({
      screen: 'foyer',
      resumeScreen: null,
      charade: null,
      reveal: null,
      author: null,
      pending: [],
      roundCharadeId: ''
    })
    expect(effects.cancelOpening).toHaveBeenCalled()
    expect(effects.cancelReveal).toHaveBeenCalled()
    expect(effects.clearPerformer).toHaveBeenCalled()
    expect(effects.clearStageReward).toHaveBeenCalled()
  })

  it('moves the local winner directly to authoring and clears the winner toast after four seconds', () => {
    const { runtime, advance } = createFlowHarness({ address: '0xPlayer' })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    announceRound(runtime, 'live')

    announceWinner(runtime, { address: '0xPLAYER', name: 'Player', charadeId: 'live' })

    expect(runtime.getState()).toMatchObject({
      screen: 'author',
      roundCharadeId: 'live',
      roundWinner: { address: '0xPLAYER', name: 'PLAYER' },
      toast: { winnerName: 'PLAYER', shownAt: FIXED_NOW }
    })
    expect(runtime.getState().author).not.toBeNull()
    advance(4_000)
    expect(runtime.getState().toast).toBeNull()
  })

  it('returns a round winner to the late authoritative reveal and restores the stage', () => {
    const { runtime, effects } = createFlowHarness({ address: '0xPlayer' })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    const charade = makeDecodeCharade('live')
    serveCharade(runtime, charade)
    announceRound(runtime, charade.id)
    runtime.guess(0)
    announceWinner(runtime, { address: '0xPLAYER', name: 'Player', charadeId: charade.id })
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: true,
      phrase: charade.answers[0],
      stats: { total: 1, correct: 1 },
      yourScore: 1
    })

    runtime.backFromAuthor()

    expect(runtime.getState().screen).toBe('reveal')
    expect(effects.showPerformer).toHaveBeenLastCalledWith(charade.look, charade.emotes)
    expect(effects.showStageReward).toHaveBeenLastCalledWith(charade.authorAddress, charade.authorTitle)
  })

  it('accepts the matching round winner when the reveal arrives first', () => {
    const { runtime } = createFlowHarness({ address: '0xPlayer' })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    const charade = makeDecodeCharade('live')
    serveCharade(runtime, charade)
    announceRound(runtime, charade.id)
    runtime.guess(0)
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: true,
      phrase: charade.answers[0],
      stats: { total: 1, correct: 1 },
      yourScore: 1
    })

    announceWinner(runtime, { address: '0xPLAYER', name: 'Player', charadeId: charade.id })

    expect(runtime.getState()).toMatchObject({
      screen: 'author',
      roundId: '1',
      roundCharadeId: charade.id,
      roundWinner: { address: '0xPLAYER', name: 'PLAYER' }
    })
  })

  it('does not move a remote winner into authoring', () => {
    const { runtime } = createFlowHarness({ address: 'local' })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    announceWinner(runtime, { address: 'remote', name: 'Remote', charadeId: 'missing' })

    expect(runtime.getState().screen).toBe('foyer')
    expect(runtime.getState().author).toBeNull()
  })
})

describe('author controls and request guards', () => {
  it('enforces the physical decode gate at request and guess boundaries', () => {
    let inDecodeArea = false
    const { runtime } = createFlowHarness({ canDecode: () => inDecodeArea })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    expect(runtime.requestNextCharade()).toBe(false)

    inDecodeArea = true
    serveCharade(runtime, makeDecodeCharade())
    inDecodeArea = false
    expect(runtime.guess(0)).toBe(false)
  })

  it('auto-advances authoring after the third emote and blocks authoring during a pending guess', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    expect(runtime.beginAuthoring()).toBe(true)
    expect(runtime.getState().author?.phase).toBe('phrase')
    expect(runtime.continueAuthoring()).toBe(true)
    const offered = runtime.getState().author!.offeredEmotes
    offered.slice(0, 3).forEach((emote) => runtime.selectAuthorEmote(emote))
    expect(runtime.getState().author?.phase).toBe('confirm')

    runtime.backFromAuthor()
    serveCharade(runtime, makeDecodeCharade())
    expect(runtime.guess(0)).toBe(true)
    expect(runtime.beginAuthoring()).toBe(false)
  })
  it('allows two ordered phrase shuffles, never redeals an earlier phrase, and preserves emote selection order', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    expect(runtime.beginAuthoring()).toBe(true)
    const first = runtime.getState().author!
    const chosen = [first.offeredEmotes[2], first.offeredEmotes[0], first.offeredEmotes[1]]
    for (const emote of chosen) runtime.selectAuthorEmote(emote)
    expect(runtime.getState().author?.selectedEmotes).toEqual(chosen)

    expect(runtime.shuffleAuthorPhrase()).toBe(true)
    const second = runtime.getState().author!
    expect(second.selectedEmotes).toEqual([])
    expect(second.shufflesRemaining).toBe(1)
    expect(runtime.shuffleAuthorPhrase()).toBe(true)
    const third = runtime.getState().author!
    expect(third.shufflesRemaining).toBe(0)
    expect(runtime.shuffleAuthorPhrase()).toBe(false)
    expect(runtime.getState().dealtPhraseIds).toEqual([first.phrase.id, second.phrase.id, third.phrase.id])
    expect(new Set(runtime.getState().dealtPhraseIds).size).toBe(3)
  })

  it('blocks actions until ready, invalid answer indexes, incomplete previews/posts, and duplicate pending requests', () => {
    const { runtime, sent } = createFlowHarness({ look: null })
    expect(runtime.requestNextCharade()).toBe(false)
    expect(runtime.guess(0)).toBe(false)
    expect(runtime.beginAuthoring()).toBe(false)
    expect(runtime.postAuthor()).toBe(false)

    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    sent.length = 0
    expect(runtime.requestNextCharade()).toBe(true)
    expect(runtime.requestNextCharade()).toBe(false)
    serveCharade(runtime, makeDecodeCharade())
    expect(runtime.guess(-1)).toBe(false)
    expect(runtime.guess(3)).toBe(false)
    expect(runtime.guess(0)).toBe(true)
    expect(runtime.guess(1)).toBe(false)
    receiveReveal(runtime, {
      charadeId: 'charade-1',
      correct: false,
      phrase: 'Answer one',
      stats: { total: 1, correct: 0 },
      yourScore: 0
    })

    expect(runtime.beginAuthoring()).toBe(true)
    expect(runtime.previewAuthor()).toBe(false)
    expect(runtime.postAuthor()).toBe(false)
    const offered = runtime.getState().author!.offeredEmotes
    offered.slice(0, 3).forEach((emote) => runtime.selectAuthorEmote(emote))
    expect(runtime.previewAuthor()).toBe(false)
    expect(runtime.getState().errorCode).toBe('player_look_unavailable')
    expect(runtime.postAuthor()).toBe(true)
    expect(runtime.postAuthor()).toBe(false)
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
    expect(messagesOfType(sent, 'guess')).toHaveLength(1)
    expect(messagesOfType(sent, 'post')).toHaveLength(1)
  })

  it('pages through all 16 emotes for every beat and allows a repeated three-beat performance', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    runtime.beginAuthoring()
    runtime.continueAuthoring()
    for (let beat = 0; beat < 3; beat += 1) {
      const paged = new Set<Emote>()
      for (let page = 0; page < AUTHOR_EMOTE_PAGE_COUNT; page += 1) {
        authorEmotePage(beat, page).forEach((emote) => paged.add(emote))
      }
      expect([...paged].sort()).toEqual([...EMOTE_VOCABULARY].sort())
    }
    for (let page = 0; page < AUTHOR_EMOTE_PAGE_COUNT; page += 1) {
      expect(runtime.moreAuthorEmotes()).toBe(true)
      const nextPage = (page + 1) % AUTHOR_EMOTE_PAGE_COUNT
      expect(runtime.getState().author?.emotePage).toBe(nextPage)
      expect(runtime.getState().author?.offeredEmotes.slice(nextPage * 4, nextPage * 4 + 4)).toEqual(
        authorEmotePage(0, nextPage)
      )
    }

    runtime.selectAuthorEmote('wave')
    runtime.selectAuthorEmote('wave')
    runtime.selectAuthorEmote('wave')

    expect(runtime.getState().author?.selectedEmotes).toEqual(['wave', 'wave', 'wave'])
    expect(runtime.getState().author?.phase).toBe('confirm')
    expect(runtime.reviseAuthorEmotes()).toBe(true)
    expect(runtime.getState().author).toMatchObject({ selectedEmotes: [], emotePage: 0, phase: 'emotes' })
  })
})

describe('show schedule author policy', () => {
  it('closes a stale spectator reaction menu when the accepted show changes', () => {
    const state = {
      ...createInitialFlowState(),
      instanceId: 'server',
      acceptedServerTime: FIXED_NOW,
      showKey: 'daily:2026-08-23',
      reactionMenuOpen: true
    }

    const next = flowReducer(state, {
      type: 'showSchedule',
      instanceId: 'server',
      serverTime: FIXED_NOW + 24 * 60 * 60 * 1000,
      now: FIXED_NOW + 24 * 60 * 60 * 1000,
      showKey: 'daily:2026-08-24',
      season: null,
      theme: 'everyday',
      themeLabel: 'Everyday Escapades'
    })

    expect(next.reactionMenuOpen).toBe(false)
  })

  it('requires an accepted canonical schedule before authoring or sending across a rollover', () => {
    const firstTimestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt + 60 * 60 * 1000
    const nextTimestamp = SEASON_ZERO_WEEKS[1].eligibility.startsAt + 60 * 60 * 1000
    const { runtime, sent, setNow } = createFlowHarness({ now: firstTimestamp })

    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: firstTimestamp } })
    expect(runtime.requestNextCharade()).toBe(false)
    expect(runtime.beginAuthoring()).toBe(false)

    receiveShowSchedule(runtime, firstTimestamp)
    expect(runtime.beginAuthoring()).toBe(true)
    runtime
      .getState()
      .author!.offeredEmotes.slice(0, 3)
      .forEach((emote) => runtime.selectAuthorEmote(emote))

    setNow(nextTimestamp)
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: nextTimestamp } })
    expect(runtime.getState()).toMatchObject({ showKey: '', season: null, author: null, pending: [] })
    expect(runtime.shuffleAuthorPhrase()).toBe(false)
    expect(runtime.postAuthor()).toBe(false)
    expect(runtime.beginAuthoring()).toBe(false)
    expect(messagesOfType(sent, 'post')).toEqual([])

    receiveShowSchedule(runtime, nextTimestamp)
    expect(runtime.getState().author).toBeNull()
    expect(runtime.beginAuthoring()).toBe(true)
  })

  it.each(SEASON_ZERO_WEEKS.map((week) => [week.id, week.eligibility.startsAt + 60 * 60 * 1000] as const))(
    'deals normal, shuffled, and Ghost Mail drafts only from the %s primary deck',
    (_weekId, timestamp) => {
      const sender = `0x${'1'.repeat(40)}`
      const recipient = `0x${'2'.repeat(40)}`
      const { runtime } = createFlowHarness({ address: sender, now: timestamp })
      runtime.receive({
        type: 'ready',
        data: { instanceId: 'server', serverTime: timestamp, theme: 'food', themeLabel: 'FORGED THEME' }
      })
      const policy = receiveShowSchedule(runtime, timestamp)
      expect(policy.kind).toBe('season-zero')
      const allowed = new Set(policy.primaryPhraseIds)

      expect(runtime.beginAuthoring()).toBe(true)
      expect(allowed.has(runtime.getState().author!.phrase.id as (typeof policy.primaryPhraseIds)[number])).toBe(true)
      expect(runtime.shuffleAuthorPhrase()).toBe(true)
      expect(allowed.has(runtime.getState().author!.phrase.id as (typeof policy.primaryPhraseIds)[number])).toBe(true)

      runtime.receive({
        type: 'boards',
        data: {
          topDecoders: [],
          hardestGhosts: [],
          ghostOfNightId: '',
          playbill: [
            { address: recipient, name: 'Recipient', isGuest: false, title: '', performedAt: timestamp }
          ]
        }
      })
      expect(runtime.selectGhostMailRecipient(recipient)).toBe(true)
      expect(runtime.beginGhostMail()).toBe(true)
      expect(allowed.has(runtime.getState().author!.phrase.id as (typeof policy.primaryPhraseIds)[number])).toBe(true)
      expect(runtime.getState()).toMatchObject({
        showKey: policy.showKey,
        season: policy.kind === 'season-zero' ? policy.season : null,
        acceptedServerTime: timestamp,
        theme: policy.legacyTheme.id,
        themeLabel: policy.legacyTheme.label
      })
    }
  )

  it('keeps the complete 120-phrase deck available outside Season Zero', () => {
    const { runtime } = createFlowHarness({ now: FIXED_NOW })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const policy = receiveShowSchedule(runtime, FIXED_NOW)
    expect(policy.kind).toBe('daily')
    expect(policy.primaryPhraseIds).toHaveLength(DECK.length)

    const target = DECK.at(-1)!
    for (const phrase of DECK) {
      if (phrase.id === target.id) continue
      runtime.dispatch({
        type: 'author',
        returnScreen: 'foyer',
        draft: {
          phrase,
          offeredEmotes: [...EMOTE_VOCABULARY],
          emotePage: 0,
          selectedEmotes: [],
          shufflesRemaining: 2,
          phase: 'phrase'
        }
      })
    }

    expect(runtime.beginAuthoring()).toBe(true)
    expect(runtime.getState().author?.phrase.id).toBe(target.id)
  })

  it('fails every author deal or send closed when aligned time has no valid policy', () => {
    const sender = `0x${'3'.repeat(40)}`
    const recipient = `0x${'4'.repeat(40)}`
    const { runtime, sent, setNow } = createFlowHarness({ address: sender, now: FIXED_NOW })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    runtime.receive({
      type: 'boards',
      data: {
        topDecoders: [],
        hardestGhosts: [],
        ghostOfNightId: '',
        playbill: [{ address: recipient, name: 'Recipient', isGuest: false, title: '', performedAt: FIXED_NOW }]
      }
    })
    expect(runtime.selectGhostMailRecipient(recipient)).toBe(true)
    expect(runtime.beginAuthoring()).toBe(true)
    runtime
      .getState()
      .author!.offeredEmotes.slice(0, 3)
      .forEach((emote) => runtime.selectAuthorEmote(emote))
    setNow(8_640_000_000_000_001)

    expect(runtime.beginAuthoring()).toBe(false)
    expect(runtime.beginGhostMail()).toBe(false)
    expect(runtime.shuffleAuthorPhrase()).toBe(false)
    expect(runtime.postAuthor()).toBe(false)
    expect(messagesOfType(sent, 'post')).toEqual([])
  })

  it('clears old-show author, decode, retry, round, and request state without retrying it on rollover', () => {
    const { runtime, sent, advance } = createFlowHarness({ now: FIXED_NOW })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    const firstPolicy = receiveShowSchedule(runtime, FIXED_NOW)
    expect(runtime.beginAuthoring()).toBe(true)
    runtime
      .getState()
      .author!.offeredEmotes.slice(0, 3)
      .forEach((emote) => runtime.selectAuthorEmote(emote))
    expect(runtime.postAuthor()).toBe(true)
    const pendingPost = messagesOfType(sent, 'post').at(-1)!
    const charade = makeDecodeCharade('old-show-decode')
    serveCharade(runtime, charade)
    announceRound(runtime, charade.id)
    expect(runtime.guess(1)).toBe(true)
    const firstGuessRequest = runtime.getState().pending.find((request) => request.kind === 'roundGuess')!
    runtime.receive({
      type: 'retry',
      data: {
        requestId: firstGuessRequest.requestId,
        charadeId: charade.id,
        removedAnswerIndex: 1,
        replayBeatIndex: 2
      }
    })
    expect(runtime.guess(0)).toBe(true)
    const pendingGuess = runtime.getState().pending.find((request) => request.kind === 'roundGuess')!
    const sentBeforeRollover = [...sent]

    const nextDay = FIXED_NOW + 24 * 60 * 60 * 1000
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: nextDay } })
    const nextPolicy = receiveShowSchedule(runtime, nextDay)
    expect(nextPolicy.showKey).not.toBe(firstPolicy.showKey)
    expect(runtime.getState()).toMatchObject({
      screen: 'foyer',
      showKey: nextPolicy.showKey,
      author: null,
      charade: null,
      retry: null,
      reveal: null,
      dealtPhraseIds: [],
      pending: [],
      roundId: '',
      latestRoundSequence: 1,
      roundCharadeId: '',
      roundWinner: null
    })

    advance(5_000)
    expect(sent).toEqual(sentBeforeRollover)
    runtime.receive({
      type: 'posted',
      data: { requestId: pendingPost.data.requestId, charadeId: 'old-show-post', revision: 0 }
    })
    runtime.receive({
      type: 'reveal',
      data: {
        requestId: pendingGuess.requestId,
        revision: 0,
        charadeId: charade.id,
        correct: true,
        phrase: charade.answers[0],
        stats: { total: 1, correct: 1 },
        yourScore: 1
      }
    })
    expect(runtime.getState()).toMatchObject({ screen: 'foyer', postedCharadeId: '' })
  })

  it('clears a completed old-show reveal while preserving the live-round sequence watermark', () => {
    const { runtime } = createFlowHarness({ now: FIXED_NOW })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    const charade = makeDecodeCharade('completed-old-show')
    serveCharade(runtime, charade)
    announceRound(runtime, charade.id, '8')
    expect(runtime.guess(0)).toBe(true)
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: true,
      phrase: charade.answers[0],
      stats: { total: 1, correct: 1 },
      yourScore: 1
    })
    expect(runtime.getState()).toMatchObject({ screen: 'reveal', latestRoundSequence: 8 })

    const nextDay = FIXED_NOW + 24 * 60 * 60 * 1000
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: nextDay } })
    receiveShowSchedule(runtime, nextDay)

    expect(runtime.getState()).toMatchObject({
      screen: 'foyer',
      charade: null,
      retry: null,
      reveal: null,
      roundId: '',
      latestRoundSequence: 8,
      roundCharadeId: '',
      roundWinner: null
    })

    announceRound(runtime, 'delayed-old-show-round', '7')
    expect(runtime.getState()).toMatchObject({
      roundId: '',
      latestRoundSequence: 8,
      roundCharadeId: ''
    })

    announceRound(runtime, 'new-show-round', '9')
    expect(runtime.getState()).toMatchObject({
      roundId: '9',
      latestRoundSequence: 9,
      roundCharadeId: 'new-show-round'
    })
  })

  it('rejects an unseen higher-sequence round that belongs to the previous show', () => {
    const firstTimestamp = SEASON_ZERO_WEEKS[0].eligibility.endsAt - 1
    const nextTimestamp = SEASON_ZERO_WEEKS[1].eligibility.startsAt
    const { runtime, setNow } = createFlowHarness({ now: firstTimestamp })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: firstTimestamp } })
    const firstPolicy = receiveShowSchedule(runtime, firstTimestamp)
    runtime.receive({
      type: 'roundStart',
      data: { instanceId: 'server', roundId: '3', charadeId: 'seen-old-round', showKey: firstPolicy.showKey }
    })

    setNow(nextTimestamp)
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: nextTimestamp } })
    const nextPolicy = receiveShowSchedule(runtime, nextTimestamp)
    runtime.receive({
      type: 'roundStart',
      data: { instanceId: 'server', roundId: '5', charadeId: 'unseen-old-round', showKey: firstPolicy.showKey }
    })

    expect(runtime.getState()).toMatchObject({ roundId: '', latestRoundSequence: 3, roundCharadeId: '' })

    runtime.receive({
      type: 'roundStart',
      data: { instanceId: 'server', roundId: '7', charadeId: 'new-show-round', showKey: nextPolicy.showKey }
    })
    expect(runtime.getState()).toMatchObject({
      roundId: '7',
      latestRoundSequence: 7,
      roundCharadeId: 'new-show-round'
    })
  })

  it('rejects a delayed higher-sequence round from a previous server instance', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'old-server', serverTime: FIXED_NOW } })
    const policy = receiveShowSchedule(runtime, FIXED_NOW, 'old-server')
    runtime.receive({
      type: 'roundStart',
      data: { instanceId: 'old-server', roundId: '3', charadeId: 'old-round', showKey: policy.showKey }
    })

    runtime.receive({ type: 'ready', data: { instanceId: 'new-server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW, 'new-server')
    runtime.receive({
      type: 'roundStart',
      data: { instanceId: 'old-server', roundId: '99', charadeId: 'delayed-old-round', showKey: policy.showKey }
    })

    expect(runtime.getState()).toMatchObject({ roundId: '', latestRoundSequence: 0, roundCharadeId: '' })

    runtime.receive({
      type: 'roundStart',
      data: { instanceId: 'new-server', roundId: '1', charadeId: 'new-round', showKey: policy.showKey }
    })
    expect(runtime.getState()).toMatchObject({ roundId: '1', latestRoundSequence: 1, roundCharadeId: 'new-round' })
  })

  it('ignores stale ready and schedule messages for the same instance', () => {
    const newer = SEASON_ZERO_WEEKS[1].eligibility.startsAt + 60 * 60 * 1000
    const older = SEASON_ZERO_WEEKS[0].eligibility.startsAt + 60 * 60 * 1000
    const { runtime } = createFlowHarness({ now: newer })
    runtime.receive({
      type: 'ready',
      data: { instanceId: 'server', serverTime: newer, theme: 'food', themeLabel: 'FORGED THEME' }
    })
    const currentPolicy = receiveShowSchedule(runtime, newer)
    const currentState = runtime.getState()

    runtime.receive({
      type: 'ready',
      data: { instanceId: 'server', serverTime: older, theme: 'awkward', themeLabel: 'STALE THEME' }
    })
    receiveShowSchedule(runtime, older)

    expect(runtime.getState()).toMatchObject({
      showKey: currentPolicy.showKey,
      season: currentPolicy.kind === 'season-zero' ? currentPolicy.season : null,
      acceptedServerTime: newer,
      serverClockOffset: currentState.serverClockOffset,
      theme: currentPolicy.legacyTheme.id,
      themeLabel: currentPolicy.legacyTheme.label
    })
  })

  it('does not return to an older server instance after accepting a newer ready', () => {
    const older = SEASON_ZERO_WEEKS[0].eligibility.startsAt + 60 * 60 * 1000
    const newer = SEASON_ZERO_WEEKS[1].eligibility.startsAt + 60 * 60 * 1000
    const { runtime } = createFlowHarness({ now: newer })
    runtime.receive({ type: 'ready', data: { instanceId: 'old-server', serverTime: older } })
    receiveShowSchedule(runtime, older, 'old-server')
    runtime.receive({ type: 'ready', data: { instanceId: 'new-server', serverTime: newer } })
    const currentPolicy = receiveShowSchedule(runtime, newer, 'new-server')

    runtime.receive({ type: 'ready', data: { instanceId: 'old-server', serverTime: older } })
    receiveShowSchedule(runtime, older, 'old-server')

    expect(runtime.getState()).toMatchObject({
      instanceId: 'new-server',
      showKey: currentPolicy.showKey,
      season: currentPolicy.kind === 'season-zero' ? currentPolicy.season : null,
      acceptedServerTime: newer
    })
  })

  it('rejects same-revision progress and since envelopes from an older UTC day', () => {
    const { runtime } = createFlowHarness({ now: FIXED_NOW })
    const nextDay = FIXED_NOW + 24 * 60 * 60 * 1000
    const nextUnlock = { nextTitle: 'Understudy' as const, requirement: 'Post your first charade', progress: 0 }
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    receiveShowSchedule(runtime, FIXED_NOW)
    runtime.receive({
      type: 'progress',
      data: {
        revision: 5,
        daily: { day: '2026-08-23', decoded: 3, authored: 1, stamped: true },
        title: '',
        nextUnlock
      }
    })

    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: nextDay } })
    receiveShowSchedule(runtime, nextDay)
    runtime.receive({
      type: 'progress',
      data: {
        revision: 5,
        daily: { day: '2026-08-24', decoded: 0, authored: 0, stamped: false },
        title: '',
        nextUnlock
      }
    })
    runtime.receive({
      type: 'progress',
      data: {
        revision: 5,
        daily: { day: '2026-08-23', decoded: 99, authored: 99, stamped: true },
        title: '',
        nextUnlock
      }
    })
    runtime.receive({
      type: 'since',
      data: {
        revision: 5,
        triedYou: 99,
        gotYou: 99,
        rank: 1,
        daily: { day: '2026-08-23', decoded: 99, authored: 99, stamped: true },
        title: '',
        nextUnlock
      }
    })

    expect(runtime.getState()).toMatchObject({
      progressRevision: 5,
      progress: { daily: { day: '2026-08-24', decoded: 0, authored: 0, stamped: false } },
      since: null
    })
  })

  it('advances daily progress from a replayed same-show schedule when the rollover progress was dropped', () => {
    const firstTimestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt + 60 * 60 * 1000
    const nextTimestamp = firstTimestamp + 24 * 60 * 60 * 1000
    const firstDay = new Date(firstTimestamp).toISOString().slice(0, 10)
    const nextDay = new Date(nextTimestamp).toISOString().slice(0, 10)
    const nextUnlock = { nextTitle: 'Understudy' as const, requirement: 'Post your first charade', progress: 0 }
    const { runtime, setNow } = createFlowHarness({ now: firstTimestamp })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: firstTimestamp } })
    receiveShowSchedule(runtime, firstTimestamp)
    runtime.receive({
      type: 'progress',
      data: {
        revision: 5,
        daily: { day: firstDay, decoded: 3, authored: 1, stamped: true },
        title: 'Understudy',
        nextUnlock
      }
    })

    setNow(nextTimestamp)
    receiveShowSchedule(runtime, nextTimestamp)

    expect(runtime.getState()).toMatchObject({
      progressRevision: 5,
      progress: { daily: { day: nextDay, decoded: 0, authored: 0, stamped: false }, title: 'Understudy' }
    })

    runtime.receive({
      type: 'progress',
      data: {
        revision: 5,
        daily: { day: firstDay, decoded: 99, authored: 99, stamped: true },
        title: 'Understudy',
        nextUnlock
      }
    })
    expect(runtime.getState().progress.daily).toEqual({ day: nextDay, decoded: 0, authored: 0, stamped: false })
  })

  it('accepts delayed reveal and posted outcomes without rolling progress back to the prior UTC day', () => {
    const beforeMidnight = SEASON_ZERO_WEEKS[0].eligibility.startsAt + 24 * 60 * 60 * 1000 - 1
    const afterMidnight = beforeMidnight + 1
    const oldDay = new Date(beforeMidnight).toISOString().slice(0, 10)
    const newDay = new Date(afterMidnight).toISOString().slice(0, 10)
    const nextUnlock = { nextTitle: 'Understudy' as const, requirement: 'Post your first charade', progress: 0 }
    const newDaily = { day: newDay, decoded: 0, authored: 0, stamped: false }
    const oldDaily = { day: oldDay, decoded: 99, authored: 99, stamped: true }

    const revealHarness = createFlowHarness({ now: beforeMidnight })
    revealHarness.runtime.receive({
      type: 'ready',
      data: { instanceId: 'server', serverTime: beforeMidnight }
    })
    receiveShowSchedule(revealHarness.runtime, beforeMidnight)
    const charade = makeDecodeCharade('pre-midnight-reveal')
    serveCharade(revealHarness.runtime, charade)
    expect(revealHarness.runtime.guess(0)).toBe(true)
    revealHarness.setNow(afterMidnight)
    revealHarness.runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: afterMidnight } })
    receiveShowSchedule(revealHarness.runtime, afterMidnight)
    revealHarness.runtime.receive({
      type: 'progress',
      data: { revision: 5, daily: newDaily, title: '', nextUnlock }
    })
    receiveReveal(
      revealHarness.runtime,
      {
        charadeId: charade.id,
        correct: true,
        phrase: charade.answers[0],
        stats: { total: 1, correct: 1 },
        yourScore: 1,
        daily: oldDaily,
        title: '',
        nextUnlock
      },
      5
    )
    expect(revealHarness.runtime.getState()).toMatchObject({
      screen: 'reveal',
      reveal: { charadeId: charade.id, correct: true },
      progress: { daily: newDaily },
      progressRevision: 5
    })

    const postHarness = createFlowHarness({ now: beforeMidnight })
    postHarness.runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: beforeMidnight } })
    receiveShowSchedule(postHarness.runtime, beforeMidnight)
    expect(postHarness.runtime.beginAuthoring()).toBe(true)
    postHarness.runtime
      .getState()
      .author!.offeredEmotes.slice(0, 3)
      .forEach((emote) => postHarness.runtime.selectAuthorEmote(emote))
    expect(postHarness.runtime.postAuthor()).toBe(true)
    const postRequest = postHarness.runtime.getState().pending.find((request) => request.kind === 'post')!
    postHarness.setNow(afterMidnight)
    postHarness.runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: afterMidnight } })
    receiveShowSchedule(postHarness.runtime, afterMidnight)
    postHarness.runtime.receive({
      type: 'progress',
      data: { revision: 5, daily: newDaily, title: '', nextUnlock }
    })
    postHarness.runtime.receive({
      type: 'posted',
      data: {
        requestId: postRequest.requestId,
        charadeId: 'pre-midnight-post',
        revision: 5,
        daily: oldDaily,
        title: '',
        nextUnlock
      }
    })
    expect(postHarness.runtime.getState()).toMatchObject({
      screen: 'posted',
      postedCharadeId: 'pre-midnight-post',
      progress: { daily: newDaily },
      progressRevision: 5
    })
  })

  it('accepts only an instance-bound schedule matching the locally reconstructed policy', () => {
    const timestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt + 60 * 60 * 1000
    const { runtime } = createFlowHarness({ now: timestamp })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: timestamp } })
    const policy = showPolicyForTimestamp(timestamp)!
    expect(policy.kind).toBe('season-zero')
    if (policy.kind !== 'season-zero') throw new Error('Expected Season Zero policy')

    runtime.receive({
      type: 'showSchedule',
      data: { instanceId: 'server', serverTime: timestamp, showKey: 'forged', season: policy.season }
    })
    runtime.receive({
      type: 'showSchedule',
      data: {
        instanceId: 'server',
        serverTime: timestamp,
        showKey: policy.showKey,
        season: { ...policy.season, titleId: 'forged-title' }
      }
    })
    const malformedSchedule = {
      type: 'showSchedule',
      data: {
        instanceId: 'server',
        serverTime: timestamp,
        showKey: policy.showKey,
        season: { ...policy.season, finale: null }
      }
    } as unknown as Extract<ServerMessage, { type: 'showSchedule' }>
    expect(() => runtime.receive(malformedSchedule)).not.toThrow()
    runtime.receive({
      type: 'showSchedule',
      data: { instanceId: 'other-server', serverTime: timestamp, showKey: policy.showKey, season: policy.season }
    })
    expect(runtime.getState()).toMatchObject({ showKey: '', season: null, acceptedServerTime: timestamp })

    receiveShowSchedule(runtime, timestamp)
    expect(runtime.getState()).toMatchObject({ showKey: policy.showKey, season: policy.season })
  })

  it('blocks off-policy answer-backs and posts without sending them', () => {
    const timestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt + 60 * 60 * 1000
    const { runtime, sent } = createFlowHarness({ now: timestamp })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: timestamp } })
    const policy = receiveShowSchedule(runtime, timestamp)
    const allowed = new Set(policy.primaryPhraseIds)
    const offPolicy = DECK.find((phrase) => !allowed.has(phrase.id as (typeof policy.primaryPhraseIds)[number]))!
    const charade = makeDecodeCharade('off-policy-reply')
    serveCharade(runtime, charade)
    expect(runtime.guess(0)).toBe(true)
    receiveReveal(runtime, {
      charadeId: charade.id,
      correct: true,
      phraseId: offPolicy.id,
      phrase: offPolicy.text,
      stats: { total: 1, correct: 1 },
      yourScore: 1
    })

    expect(runtime.canAnswerBack()).toBe(false)
    expect(runtime.beginAnswerBack()).toBe(false)
    expect(runtime.getState().author).toBeNull()

    runtime.dispatch({
      type: 'author',
      returnScreen: 'foyer',
      draft: {
        phrase: offPolicy,
        offeredEmotes: [...EMOTE_VOCABULARY],
        emotePage: 0,
        selectedEmotes: [],
        shufflesRemaining: 2,
        phase: 'emotes'
      }
    })
    offPolicy.suggested.forEach((emote) => runtime.selectAuthorEmote(emote))
    expect(runtime.postAuthor()).toBe(false)
    expect(messagesOfType(sent, 'post')).toEqual([])
  })
})

describe('second-chance client flow', () => {
  function enterRetry(
    harness: ReturnType<typeof createFlowHarness>,
    removedAnswerIndex: 0 | 1 | 2 = 1,
    replayBeatIndex: 0 | 1 | 2 = 2
  ) {
    const { runtime } = harness
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade())
    expect(runtime.guess(removedAnswerIndex)).toBe(true)
    const requestId = runtime.getState().pending.find((request) => request.kind === 'guess')!.requestId
    const retryMessage = {
      type: 'retry' as const,
      data: { requestId, charadeId: 'charade-1', removedAnswerIndex, replayBeatIndex }
    }
    runtime.receive(retryMessage)
    return retryMessage
  }

  it('accepts one exact retry, locks the original spotlight stake, and never accepts the removed answer', () => {
    const harness = createFlowHarness()
    const { runtime, sent, effects } = harness
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade())
    expect(runtime.toggleSpotlight()).toBe(true)
    expect(runtime.guess(1)).toBe(true)
    const firstRequestId = runtime.getState().pending.find((request) => request.kind === 'guess')!.requestId
    const retryMessage = {
      type: 'retry' as const,
      data: {
        requestId: firstRequestId,
        charadeId: 'charade-1',
        removedAnswerIndex: 1,
        replayBeatIndex: 2
      }
    }

    runtime.receive(retryMessage)
    runtime.receive(retryMessage)

    expect(runtime.getState()).toMatchObject({
      screen: 'decode',
      retry: {
        charadeId: 'charade-1',
        removedAnswerIndex: 1,
        replayBeatIndex: 2,
        spotlight: true
      },
      reveal: null,
      spotlightEnabled: true,
      pending: []
    })
    expect(effects.showRetryBeat).toHaveBeenCalledTimes(1)
    expect(runtime.toggleSpotlight()).toBe(false)
    expect(runtime.guess(1)).toBe(false)
    expect(runtime.guess(0)).toBe(true)
    expect(messagesOfType(sent, 'guess').at(-1)?.data).toEqual({
      charadeId: 'charade-1',
      answerIndex: 0,
      requestId: 'request-3'
    })
  })

  it('validates retry fields before resolving the exact pending guess', () => {
    const { runtime, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    serveCharade(runtime, makeDecodeCharade())
    runtime.guess(1)
    const requestId = runtime.getState().pending.find((request) => request.kind === 'guess')!.requestId

    runtime.receive({
      type: 'retry',
      data: { requestId, charadeId: 'charade-1', removedAnswerIndex: 0, replayBeatIndex: 2 }
    })
    runtime.receive({
      type: 'retry',
      data: { requestId, charadeId: 'charade-1', removedAnswerIndex: 1, replayBeatIndex: 3 }
    })

    expect(runtime.getState().retry).toBeNull()
    expect(runtime.getState().pending).toHaveLength(1)
    expect(effects.showRetryBeat).not.toHaveBeenCalled()
  })

  it('clears retry on final reveal so a third guess cannot be constructed', () => {
    const harness = createFlowHarness()
    const { runtime } = harness
    enterRetry(harness)
    expect(runtime.guess(0)).toBe(true)
    receiveReveal(runtime, {
      charadeId: 'charade-1',
      correct: true,
      phrase: 'Answer one',
      stats: { total: 1, correct: 1 },
      yourScore: 50,
      attempt: 2
    })

    expect(runtime.getState()).toMatchObject({ screen: 'reveal', retry: null, reveal: { attempt: 2 } })
    expect(runtime.guess(2)).toBe(false)
  })

  it('abandons retry after a real same-instance transport drop and excludes that charade from the refetch', () => {
    const harness = createFlowHarness({ canDecode: () => true })
    const { runtime, sent, setTransportReady, advance } = harness
    enterRetry(harness)
    expect(runtime.guess(0)).toBe(true)

    setTransportReady(false)
    advance(0)
    setTransportReady(true)
    advance(0)
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })

    expect(runtime.getState()).toMatchObject({ screen: 'foyer', charade: null, retry: null })
    expect(runtime.getState().pending.some((request) => request.kind === 'guess')).toBe(false)
    expect(messagesOfType(sent, 'nextCharade').at(-1)?.data.exclude).toEqual(['charade-1'])
  })

  it('abandons volatile retry state when the server instance changes and fetches a different charade', () => {
    const harness = createFlowHarness({ canDecode: () => true })
    const { runtime, sent } = harness
    enterRetry(harness)

    runtime.receive({ type: 'ready', data: { instanceId: 'restarted-server', serverTime: FIXED_NOW } })

    expect(runtime.getState()).toMatchObject({ screen: 'foyer', charade: null, retry: null })
    expect(runtime.getState().pending.some((request) => request.kind === 'guess')).toBe(false)
    expect(messagesOfType(sent, 'nextCharade').at(-1)?.data.exclude).not.toEqual(['charade-1'])

    receiveShowSchedule(runtime, FIXED_NOW, 'restarted-server')

    expect(messagesOfType(sent, 'nextCharade').at(-1)?.data.exclude).toEqual(['charade-1'])
  })

  it('clears a disconnected retry outside the decode region without issuing a replacement request', () => {
    let canDecode = true
    const harness = createFlowHarness({ canDecode: () => canDecode })
    const { runtime, sent, setTransportReady, advance } = harness
    enterRetry(harness)
    const nextRequestsBefore = messagesOfType(sent, 'nextCharade').length
    canDecode = false

    setTransportReady(false)
    advance(0)
    setTransportReady(true)
    advance(0)
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })

    expect(runtime.getState()).toMatchObject({ screen: 'foyer', charade: null, retry: null })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(nextRequestsBefore)
  })

  it('abandons a retry the server no longer recognizes and excludes the stale charade', () => {
    const harness = createFlowHarness({ canDecode: () => true })
    const { runtime, sent } = harness
    enterRetry(harness)
    expect(runtime.guess(0)).toBe(true)
    const requestId = runtime
      .getState()
      .pending.find((request) => request.kind === 'guess' || request.kind === 'roundGuess')!.requestId

    runtime.receive({ type: 'requestError', data: { code: 'charade-not-served', requestId } })

    expect(runtime.getState()).toMatchObject({ screen: 'foyer', charade: null, retry: null })
    expect(runtime.getState().pending.some((request) => request.kind === 'guess')).toBe(false)
    expect(messagesOfType(sent, 'nextCharade').at(-1)?.data.exclude).toEqual(['charade-1'])
  })

  it('preserves retry across a heartbeat-only timeout and pong', () => {
    const harness = createFlowHarness()
    const { runtime } = harness
    enterRetry(harness, 0, 1)

    runtime.dispatch({ type: 'heartbeatTimeout' })
    runtime.receive({ type: 'pong', data: { seq: 1 } })

    expect(runtime.getState()).toMatchObject({
      screen: 'decode',
      ready: true,
      retry: { charadeId: 'charade-1', removedAnswerIndex: 0, replayBeatIndex: 1 }
    })
  })

  it('finishes the current retry before requesting a newly announced live round', () => {
    const harness = createFlowHarness()
    const { runtime, sent } = harness
    enterRetry(harness)
    const nextRequestsBefore = messagesOfType(sent, 'nextCharade').length

    runtime.receive({
      type: 'roundStart',
      data: {
        instanceId: runtime.getState().instanceId,
        roundId: '7',
        charadeId: 'new-live-charade',
        showKey: runtime.getState().showKey
      }
    })

    expect(runtime.getState()).toMatchObject({
      screen: 'decode',
      charade: { id: 'charade-1' },
      retry: { charadeId: 'charade-1' },
      roundCharadeId: 'new-live-charade'
    })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(nextRequestsBefore)
  })
})
