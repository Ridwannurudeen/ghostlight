import { describe, expect, it, vi } from 'vitest'
import { DECK, EMOTE_VOCABULARY, type Emote } from '../src/shared/deck'
import {
  createFlowRuntime,
  createInitialFlowState,
  flowReducer,
  type DecodeCharade,
  type FlowEffects,
  type OutboundMessage
} from '../src/client/flow'
import { FIXED_NOW, makeLook } from './test-helpers'

vi.mock('@dcl/sdk/ecs', () => ({
  engine: { addSystem: vi.fn() },
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
    isHouse: false
  }
}

function createFlowHarness(
  overrides: { address?: string; transportReady?: boolean; look?: ReturnType<typeof makeLook> | null } = {}
) {
  let currentTime = FIXED_NOW
  let requestSequence = 0
  let transportReady = overrides.transportReady ?? true
  const address = overrides.address ?? '0xPlayer'
  const sent: OutboundMessage[] = []
  const effects: Required<FlowEffects> = {
    showPerformer: vi.fn(),
    replayPerformer: vi.fn(),
    showPreview: vi.fn(),
    revealAudience: vi.fn()
  }
  const runtime = createFlowRuntime({
    send: (message) => {
      sent.push(message)
    },
    now: () => currentTime,
    createRequestId: () => `request-${++requestSequence}`,
    getProfile: () => ({ address, name: 'Player', isGuest: false }),
    getLook: () => (overrides.look === undefined ? makeLook(address, 'Player') : overrides.look),
    isTransportReady: () => transportReady,
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
    setTransportReady(ready: boolean) {
      transportReady = ready
    }
  }
}

function messagesOfType<T extends OutboundMessage['type']>(sent: OutboundMessage[], type: T) {
  return sent.filter((message): message is Extract<OutboundMessage, { type: T }> => message.type === type)
}

describe('flow reducer', () => {
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
    state = flowReducer(state, { type: 'since', summary: { triedYou: 2, gotYou: 1, rank: 4 } })
    expect(state.screen).toBe('since')

    state = flowReducer(state, { type: 'dismissSince' })
    state = flowReducer(state, { type: 'since', summary: { triedYou: 3, gotYou: 2, rank: 3 } })
    expect(state).toMatchObject({ screen: 'foyer', sinceShown: true })
  })
})

describe('flow lifecycle', () => {
  it('closes waking to ready to decode to reveal to author to posted', () => {
    const { runtime, sent, effects } = createFlowHarness()
    expect(runtime.getState().screen).toBe('waking')

    runtime.tick(0)
    expect(messagesOfType(sent, 'hello')).toHaveLength(1)
    expect(messagesOfType(sent, 'ping')).toHaveLength(1)
    runtime.receive({ type: 'ready', data: { instanceId: 'server-1', serverTime: FIXED_NOW } })
    expect(runtime.getState()).toMatchObject({ ready: true, screen: 'foyer' })
    sent.length = 0

    expect(runtime.requestNextCharade()).toBe(true)
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
    const charade = makeDecodeCharade()
    runtime.receive({ type: 'charade', data: charade })
    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade })
    expect(effects.showPerformer).toHaveBeenCalledWith(charade.look, charade.emotes)

    expect(runtime.guess(1)).toBe(true)
    expect(runtime.guess(1)).toBe(false)
    expect(messagesOfType(sent, 'guess')).toHaveLength(1)
    const reveal = {
      charadeId: charade.id,
      correct: true,
      phrase: 'Answer two',
      stats: { total: 4, correct: 3 },
      yourScore: 2
    }
    runtime.receive({ type: 'reveal', data: reveal })
    expect(runtime.getState()).toMatchObject({ screen: 'reveal', reveal })
    expect(effects.revealAudience).toHaveBeenCalledWith(true)

    expect(runtime.beginAuthoring()).toBe(true)
    const draft = runtime.getState().author!
    expect(runtime.getState().screen).toBe('author')
    for (const emote of draft.offeredEmotes.slice(0, 3)) expect(runtime.selectAuthorEmote(emote)).toBe(true)
    expect(runtime.previewAuthor()).toBe(true)
    expect(effects.showPreview).toHaveBeenCalledWith(makeLook('0xPlayer', 'Player'), draft.offeredEmotes.slice(0, 3))
    expect(runtime.postAuthor()).toBe(true)
    expect(runtime.postAuthor()).toBe(false)
    expect(messagesOfType(sent, 'post')).toHaveLength(1)

    runtime.receive({ type: 'posted', data: { charadeId: 'posted-1' } })
    expect(runtime.getState()).toMatchObject({ screen: 'posted', postedCharadeId: 'posted-1', pending: [] })
  })

  it('rejects an invalid server emote array and resolves the pending fetch', () => {
    const { runtime, sent, effects } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    sent.length = 0
    runtime.requestNextCharade()
    const valid = makeDecodeCharade()

    runtime.receive({ type: 'charade', data: { ...valid, emotes: ['wave', 'clap'] } })

    expect(runtime.getState()).toMatchObject({ charade: null, errorCode: 'invalid_charade', pending: [] })
    expect(effects.showPerformer).not.toHaveBeenCalled()
  })

  it('falls back to a plain guess after any server error on the decode screen', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    runtime.receive({ type: 'charade', data: makeDecodeCharade('live') })
    runtime.receive({ type: 'roundStart', data: { charadeId: 'live' } })
    sent.length = 0

    expect(runtime.guess(0)).toBe(true)
    runtime.receive({ type: 'error', data: { code: 'temporary-failure' } })

    expect(runtime.getState()).toMatchObject({ screen: 'decode', roundCharadeId: '', pending: [] })
    expect(runtime.guess(1)).toBe(true)
    expect(messagesOfType(sent, 'roundGuess')).toHaveLength(1)
    expect(messagesOfType(sent, 'guess')).toHaveLength(1)
  })
})

describe('heartbeats and request retries', () => {
  it('moves to waking after a heartbeat timeout and recovers the previous screen on pong', () => {
    const { runtime, sent, advance } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    runtime.receive({ type: 'charade', data: makeDecodeCharade() })
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
    runtime.receive({ type: 'charade', data: makeDecodeCharade('old') })
    runtime.dispatch({ type: 'heartbeatTimeout' })
    sent.length = 0

    runtime.receive({ type: 'roundStart', data: { charadeId: 'live' } })
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
})

describe('audience and rounds', () => {
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
    runtime.receive({ type: 'charade', data: makeDecodeCharade('old') })
    sent.length = 0

    runtime.receive({ type: 'roundStart', data: { charadeId: 'live' } })
    runtime.receive({ type: 'roundStart', data: { charadeId: 'live' } })
    expect(runtime.getState().roundCharadeId).toBe('live')
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)

    runtime.receive({ type: 'charade', data: makeDecodeCharade('live') })
    expect(runtime.guess(0)).toBe(true)
    expect(messagesOfType(sent, 'roundGuess')).toHaveLength(1)
    expect(messagesOfType(sent, 'guess')).toHaveLength(0)
  })

  it('accepts the next charade after one round mismatch refetch', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    runtime.receive({ type: 'charade', data: makeDecodeCharade('old') })
    sent.length = 0

    runtime.receive({ type: 'roundStart', data: { charadeId: 'departed-round' } })
    runtime.receive({ type: 'charade', data: makeDecodeCharade('plain-1') })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(2)
    expect(runtime.getState().charade?.id).toBe('old')

    runtime.receive({ type: 'charade', data: makeDecodeCharade('plain-2') })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(2)
    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: 'plain-2' } })
    expect(runtime.guess(0)).toBe(true)
    expect(messagesOfType(sent, 'guess')).toHaveLength(1)
  })

  it('waits for a pending guess before fetching a newly announced round', () => {
    const { runtime, sent } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    runtime.receive({ type: 'charade', data: makeDecodeCharade('old') })
    runtime.guess(0)
    sent.length = 0

    runtime.receive({ type: 'roundStart', data: { charadeId: 'live' } })

    expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: 'old' }, roundCharadeId: 'live' })
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(0)

    runtime.receive({
      type: 'reveal',
      data: {
        charadeId: 'old',
        correct: false,
        phrase: 'Answer one',
        stats: { total: 1, correct: 0 },
        yourScore: 0
      }
    })
    expect(runtime.getState()).toMatchObject({ screen: 'reveal', charade: { id: 'old' } })
    expect(runtime.requestNextCharade()).toBe(true)
    expect(messagesOfType(sent, 'nextCharade')).toHaveLength(1)
  })

  it('clears round context when that charade is revealed', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    runtime.receive({ type: 'charade', data: makeDecodeCharade('live') })
    runtime.receive({ type: 'roundStart', data: { charadeId: 'live' } })

    runtime.receive({
      type: 'reveal',
      data: {
        charadeId: 'live',
        correct: false,
        phrase: 'Answer one',
        stats: { total: 1, correct: 0 },
        yourScore: 0
      }
    })

    expect(runtime.getState()).toMatchObject({ screen: 'reveal', roundCharadeId: '' })
  })

  it.each(['foyer', 'since', 'reveal', 'author', 'posted', 'boards', 'invite'] as const)(
    'keeps the %s screen when a round starts',
    (screen) => {
      const { runtime, sent } = createFlowHarness()
      runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
      if (screen === 'since') {
        runtime.receive({ type: 'since', data: { triedYou: 2, gotYou: 1, rank: 4 } })
      } else if (screen === 'reveal') {
        runtime.receive({ type: 'charade', data: makeDecodeCharade('old') })
        runtime.receive({
          type: 'reveal',
          data: {
            charadeId: 'old',
            correct: false,
            phrase: 'Answer one',
            stats: { total: 1, correct: 0 },
            yourScore: 0
          }
        })
      } else if (screen === 'author' || screen === 'posted') {
        runtime.beginAuthoring()
        if (screen === 'posted') runtime.receive({ type: 'posted', data: { charadeId: 'authored' } })
      } else if (screen === 'boards') {
        runtime.showBoards()
      } else if (screen === 'invite') {
        runtime.showInvite()
      }
      sent.length = 0

      runtime.receive({ type: 'roundStart', data: { charadeId: 'live' } })

      expect(runtime.getState()).toMatchObject({ screen, roundCharadeId: 'live' })
      if (screen === 'since') {
        expect(runtime.getState()).toMatchObject({ since: { triedYou: 2, gotYou: 1, rank: 4 }, sinceShown: false })
      }
      expect(messagesOfType(sent, 'nextCharade')).toHaveLength(0)
    }
  )

  it('drops stale decode and round state when a new server instance is ready', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'one', serverTime: FIXED_NOW } })
    runtime.receive({ type: 'charade', data: makeDecodeCharade('live') })
    runtime.receive({ type: 'roundStart', data: { charadeId: 'live' } })
    runtime.dispatch({ type: 'heartbeatTimeout' })
    expect(runtime.getState().resumeScreen).toBe('decode')

    runtime.receive({ type: 'ready', data: { instanceId: 'two', serverTime: FIXED_NOW } })

    expect(runtime.getState()).toMatchObject({
      screen: 'foyer',
      resumeScreen: null,
      charade: null,
      roundCharadeId: ''
    })
  })

  it('moves the local winner directly to authoring and clears the winner toast after four seconds', () => {
    const { runtime, advance } = createFlowHarness({ address: '0xPlayer' })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    runtime.receive({ type: 'roundStart', data: { charadeId: 'live' } })

    runtime.receive({ type: 'roundWinner', data: { address: '0xPLAYER', name: 'Player' } })

    expect(runtime.getState()).toMatchObject({
      screen: 'author',
      roundCharadeId: '',
      roundWinner: { address: '0xPLAYER', name: 'Player' },
      toast: { text: 'Player won the round.', shownAt: FIXED_NOW }
    })
    expect(runtime.getState().author).not.toBeNull()
    advance(4_000)
    expect(runtime.getState().toast).toBeNull()
  })

  it('does not move a remote winner into authoring', () => {
    const { runtime } = createFlowHarness({ address: 'local' })
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    runtime.receive({ type: 'roundWinner', data: { address: 'remote', name: 'Remote' } })

    expect(runtime.getState().screen).toBe('foyer')
    expect(runtime.getState().author).toBeNull()
  })
})

describe('author controls and request guards', () => {
  it('allows two ordered phrase shuffles, never redeals an earlier phrase, and preserves emote selection order', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
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
    sent.length = 0
    expect(runtime.requestNextCharade()).toBe(true)
    expect(runtime.requestNextCharade()).toBe(false)
    runtime.receive({ type: 'charade', data: makeDecodeCharade() })
    expect(runtime.guess(-1)).toBe(false)
    expect(runtime.guess(3)).toBe(false)
    expect(runtime.guess(0)).toBe(true)
    expect(runtime.guess(1)).toBe(false)
    runtime.receive({
      type: 'reveal',
      data: {
        charadeId: 'charade-1',
        correct: false,
        phrase: 'Answer one',
        stats: { total: 1, correct: 0 },
        yourScore: 0
      }
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

  it('ignores emotes that were not offered and never selects more than three', () => {
    const { runtime } = createFlowHarness()
    runtime.receive({ type: 'ready', data: { instanceId: 'server', serverTime: FIXED_NOW } })
    runtime.beginAuthoring()
    const offered = runtime.getState().author!.offeredEmotes
    const notOffered = EMOTE_VOCABULARY.find((emote) => !offered.includes(emote))!
    runtime.selectAuthorEmote(notOffered as Emote)
    offered.slice(0, 4).forEach((emote) => runtime.selectAuthorEmote(emote))

    expect(runtime.getState().author?.selectedEmotes).toEqual(offered.slice(0, 3))
  })
})
