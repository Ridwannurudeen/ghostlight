import { engine } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/src/players'
import { DECK, type Emote, type Phrase } from '../shared/deck'
import { AUDIENCE_SEATS, HEARTBEAT_SECONDS, PROTOCOL_VERSION } from '../shared/config'
import { room } from '../shared/messages'
import { dealPhrase, offerEmotes } from '../shared/pick'
import type { Look } from '../shared/types'

export type FlowScreen = 'waking' | 'foyer' | 'since' | 'decode' | 'reveal' | 'author' | 'posted' | 'boards' | 'invite'

export type ReactionKind = 'laugh' | 'confused' | 'genius'
export type GhostEmotes = [string, string, string]

export type DecodeCharade = {
  id: string
  authorName: string
  authorAddress: string
  look: Look
  emotes: GhostEmotes
  answers: [string, string, string]
  createdAt: number
  isHouse: boolean
}

export type RevealResult = {
  charadeId: string
  correct: boolean
  phrase: string
  stats: {
    total: number
    correct: number
  }
  yourScore: number
}

export type SinceSummary = {
  triedYou: number
  gotYou: number
  rank: number
}

export type BoardsView = {
  topDecoders: Array<{
    address: string
    name: string
    correct: number
    total: number
  }>
  hardestGhosts: Array<{
    charadeId: string
    authorName: string
    total: number
    correct: number
  }>
}

export type AuthorDraft = {
  phrase: Phrase
  offeredEmotes: Emote[]
  selectedEmotes: Emote[]
  shufflesRemaining: number
}

export type PendingRequestKind = 'nextCharade' | 'guess' | 'roundGuess' | 'post'

export type PendingRequest = {
  requestId: string
  kind: PendingRequestKind
  sentAt: number
  retries: number
}

export type ClientFlowState = {
  screen: FlowScreen
  resumeScreen: Exclude<FlowScreen, 'waking'> | null
  ready: boolean
  transportReady: boolean
  instanceId: string
  lastHeartbeatAt: number
  charade: DecodeCharade | null
  reveal: RevealResult | null
  author: AuthorDraft | null
  dealtPhraseIds: string[]
  postedCharadeId: string
  boards: BoardsView
  since: SinceSummary | null
  sinceShown: boolean
  audience: Look[]
  reactionEvent: {
    kind: ReactionKind
    from: string
    sequence: number
  } | null
  roundCharadeId: string
  roundWinner: {
    address: string
    name: string
  } | null
  toast: {
    text: string
    shownAt: number
  } | null
  pending: PendingRequest[]
  inviteStatus: 'idle' | 'copied' | 'failed'
  errorCode: string
}

export type FlowAction =
  | { type: 'transport'; ready: boolean }
  | { type: 'ready'; instanceId: string; serverTime: number; now: number }
  | { type: 'pong'; now: number }
  | { type: 'heartbeatTimeout' }
  | { type: 'charade'; charade: DecodeCharade }
  | { type: 'reveal'; reveal: RevealResult }
  | { type: 'author'; draft: AuthorDraft }
  | { type: 'authorSelect'; emote: Emote }
  | { type: 'posted'; charadeId: string }
  | { type: 'since'; summary: SinceSummary }
  | { type: 'dismissSince' }
  | { type: 'audience'; looks: Look[] }
  | { type: 'boards'; boards: BoardsView }
  | { type: 'roundStart'; charadeId: string }
  | { type: 'roundWinner'; address: string; name: string; now: number }
  | { type: 'reaction'; kind: ReactionKind; from: string }
  | { type: 'show'; screen: 'foyer' | 'boards' | 'invite' }
  | { type: 'requestSent'; request: PendingRequest }
  | { type: 'requestRetried'; requestId: string; now: number }
  | { type: 'requestResolved'; kind: PendingRequestKind }
  | { type: 'requestTimedOut'; requestId: string }
  | { type: 'inviteStatus'; status: ClientFlowState['inviteStatus'] }
  | { type: 'clearToast' }
  | { type: 'error'; code: string }

export function createInitialFlowState(): ClientFlowState {
  return {
    screen: 'waking',
    resumeScreen: null,
    ready: false,
    transportReady: false,
    instanceId: '',
    lastHeartbeatAt: 0,
    charade: null,
    reveal: null,
    author: null,
    dealtPhraseIds: [],
    postedCharadeId: '',
    boards: { topDecoders: [], hardestGhosts: [] },
    since: null,
    sinceShown: false,
    audience: [],
    reactionEvent: null,
    roundCharadeId: '',
    roundWinner: null,
    toast: null,
    pending: [],
    inviteStatus: 'idle',
    errorCode: ''
  }
}

function mergeAudience(current: Look[], incoming: Look[]) {
  const merged = [...current]

  for (const look of incoming) {
    const address = look.address.toLowerCase()
    const existing = merged.findIndex((candidate) => candidate.address.toLowerCase() === address)
    if (existing >= 0) merged.splice(existing, 1)
    merged.push(look)
  }

  return merged.slice(-AUDIENCE_SEATS)
}

export function flowReducer(state: ClientFlowState, action: FlowAction): ClientFlowState {
  switch (action.type) {
    case 'transport':
      return action.ready
        ? { ...state, transportReady: true }
        : {
            ...state,
            ready: false,
            transportReady: false,
            resumeScreen: state.screen === 'waking' ? state.resumeScreen : state.screen,
            screen: 'waking'
          }
    case 'ready': {
      const newInstance = state.instanceId !== action.instanceId
      const screen = state.resumeScreen ?? (state.since && !state.sinceShown ? 'since' : 'foyer')
      return {
        ...state,
        ready: true,
        transportReady: true,
        instanceId: action.instanceId,
        lastHeartbeatAt: action.now,
        screen,
        resumeScreen: null,
        audience: newInstance ? [] : state.audience,
        errorCode: ''
      }
    }
    case 'pong':
      return {
        ...state,
        ready: true,
        lastHeartbeatAt: action.now,
        screen:
          state.screen === 'waking'
            ? (state.resumeScreen ?? (state.since && !state.sinceShown ? 'since' : 'foyer'))
            : state.screen,
        resumeScreen: null,
        errorCode: ''
      }
    case 'heartbeatTimeout':
      return {
        ...state,
        ready: false,
        resumeScreen: state.screen === 'waking' ? state.resumeScreen : state.screen,
        screen: 'waking'
      }
    case 'charade':
      return {
        ...state,
        screen: 'decode',
        charade: action.charade,
        reveal: null,
        errorCode: '',
        pending: state.pending.filter((request) => request.kind !== 'nextCharade')
      }
    case 'reveal':
      return {
        ...state,
        screen: state.screen === 'author' ? 'author' : 'reveal',
        reveal: action.reveal,
        errorCode: '',
        pending: state.pending.filter((request) => request.kind !== 'guess' && request.kind !== 'roundGuess')
      }
    case 'author':
      return {
        ...state,
        screen: 'author',
        author: action.draft,
        dealtPhraseIds: state.dealtPhraseIds.includes(action.draft.phrase.id)
          ? state.dealtPhraseIds
          : [...state.dealtPhraseIds, action.draft.phrase.id],
        errorCode: ''
      }
    case 'authorSelect': {
      if (!state.author || !state.author.offeredEmotes.includes(action.emote)) return state
      const alreadySelected = state.author.selectedEmotes.includes(action.emote)
      const selectedEmotes = alreadySelected
        ? state.author.selectedEmotes.filter((emote) => emote !== action.emote)
        : state.author.selectedEmotes.length < 3
          ? [...state.author.selectedEmotes, action.emote]
          : state.author.selectedEmotes
      return { ...state, author: { ...state.author, selectedEmotes } }
    }
    case 'posted':
      return {
        ...state,
        screen: 'posted',
        postedCharadeId: action.charadeId,
        errorCode: '',
        pending: state.pending.filter((request) => request.kind !== 'post')
      }
    case 'since':
      return {
        ...state,
        since: action.summary,
        screen:
          state.ready && !state.sinceShown && (state.screen === 'foyer' || state.screen === 'waking')
            ? 'since'
            : state.screen
      }
    case 'dismissSince':
      return { ...state, sinceShown: true, screen: 'foyer' }
    case 'audience':
      return { ...state, audience: mergeAudience(state.audience, action.looks) }
    case 'boards':
      return { ...state, boards: action.boards }
    case 'roundStart':
      return { ...state, roundCharadeId: action.charadeId, roundWinner: null }
    case 'roundWinner':
      return {
        ...state,
        roundWinner: { address: action.address, name: action.name },
        toast: { text: `${action.name} won the round.`, shownAt: action.now },
        roundCharadeId: ''
      }
    case 'reaction':
      return {
        ...state,
        reactionEvent: {
          kind: action.kind,
          from: action.from,
          sequence: (state.reactionEvent?.sequence ?? 0) + 1
        }
      }
    case 'show':
      return { ...state, screen: action.screen, inviteStatus: action.screen === 'invite' ? 'idle' : state.inviteStatus }
    case 'requestSent':
      return { ...state, pending: [...state.pending, action.request], errorCode: '' }
    case 'requestRetried':
      return {
        ...state,
        pending: state.pending.map((request) =>
          request.requestId === action.requestId
            ? { ...request, retries: request.retries + 1, sentAt: action.now }
            : request
        )
      }
    case 'requestResolved':
      return { ...state, pending: state.pending.filter((request) => request.kind !== action.kind) }
    case 'requestTimedOut':
      return {
        ...state,
        pending: state.pending.filter((request) => request.requestId !== action.requestId),
        errorCode: 'request_timeout'
      }
    case 'inviteStatus':
      return { ...state, inviteStatus: action.status }
    case 'clearToast':
      return { ...state, toast: null }
    case 'error':
      return { ...state, errorCode: action.code, pending: [] }
  }
}

export type OutboundMessage =
  | { type: 'hello'; data: { displayName: string; isGuest: boolean; protocolVersion: number } }
  | { type: 'ping'; data: { seq: number } }
  | { type: 'nextCharade'; data: { exclude: string[] } }
  | { type: 'guess'; data: { charadeId: string; answerIndex: number; requestId: string } }
  | { type: 'roundGuess'; data: { charadeId: string; answerIndex: number; requestId: string } }
  | { type: 'post'; data: { phraseId: string; emotes: string[]; requestId: string } }

export type ServerMessage =
  | { type: 'ready'; data: { instanceId: string; serverTime: number } }
  | { type: 'pong'; data: { seq: number } }
  | {
      type: 'charade'
      data: Omit<DecodeCharade, 'emotes' | 'answers'> & { emotes: string[]; answers: string[] }
    }
  | { type: 'reveal'; data: RevealResult }
  | { type: 'posted'; data: { charadeId: string } }
  | { type: 'since'; data: SinceSummary }
  | { type: 'audience'; data: { looks: Look[] } }
  | { type: 'boards'; data: BoardsView }
  | { type: 'roundStart'; data: { charadeId: string } }
  | { type: 'roundWinner'; data: { address: string; name: string } }
  | { type: 'react'; data: { kind: string }; from: string }
  | { type: 'error'; data: { code: string } }

export type FlowEffects = {
  showPerformer?: (look: Look, emotes: GhostEmotes) => void
  replayPerformer?: () => void
  showPreview?: (look: Look, emotes: GhostEmotes) => void
  revealAudience?: (correct: boolean) => void
}

export type FlowRuntimeOptions = {
  send: (message: OutboundMessage) => void | Promise<void>
  now?: () => number
  createRequestId?: () => string
  getProfile?: () => { address: string; name: string; isGuest: boolean } | null
  getLook?: () => Look | null
  isTransportReady?: () => boolean
  effects?: FlowEffects
}

type StoredRequest = {
  request: PendingRequest
  message: OutboundMessage
}

const REQUEST_RETRY_MILLISECONDS = 5_000
const CONNECTED_HEARTBEAT_SECONDS = 10
const HEARTBEAT_TIMEOUT_MILLISECONDS = 20_000
const TOAST_MILLISECONDS = 4_000

export function createFlowRuntime(options: FlowRuntimeOptions) {
  let state = createInitialFlowState()
  let effects = options.effects ?? {}
  let heartbeatElapsed = HEARTBEAT_SECONDS
  let pingSequence = 0
  let requestSequence = 0
  let helloSent = false
  let lastHelloInstance = ''
  const requests = new Map<string, StoredRequest>()
  const listeners = new Set<(nextState: ClientFlowState) => void>()
  const now = options.now ?? Date.now
  const createRequestId = options.createRequestId ?? (() => `${Math.floor(now())}-${++requestSequence}`)

  function dispatch(action: FlowAction) {
    state = flowReducer(state, action)
    for (const listener of listeners) listener(state)
  }

  function emit(message: OutboundMessage) {
    try {
      void Promise.resolve(options.send(message)).catch((error: unknown) => {
        console.error(`Ghost Charades message ${message.type} failed`, error)
      })
    } catch (error: unknown) {
      console.error(`Ghost Charades message ${message.type} failed`, error)
    }
  }

  function sendHello(force = false) {
    if (!options.getProfile || !state.transportReady) return
    const profile = options.getProfile()
    if (!profile || (!force && helloSent)) return
    emit({
      type: 'hello',
      data: { displayName: profile.name, isGuest: profile.isGuest, protocolVersion: PROTOCOL_VERSION }
    })
    helloSent = true
    lastHelloInstance = state.instanceId
  }

  function sendRequest(kind: PendingRequestKind, message: OutboundMessage, requestId: string) {
    const request = { requestId, kind, sentAt: now(), retries: 0 }
    requests.set(requestId, { request, message })
    dispatch({ type: 'requestSent', request })
    emit(message)
  }

  function resolveRequests(...kinds: PendingRequestKind[]) {
    for (const [requestId, stored] of requests) {
      if (kinds.includes(stored.request.kind)) requests.delete(requestId)
    }
    for (const kind of kinds) dispatch({ type: 'requestResolved', kind })
  }

  function receive(message: ServerMessage) {
    switch (message.type) {
      case 'ready': {
        const instanceChanged = state.instanceId !== message.data.instanceId
        dispatch({
          type: 'ready',
          instanceId: message.data.instanceId,
          serverTime: message.data.serverTime,
          now: now()
        })
        if (instanceChanged || lastHelloInstance !== message.data.instanceId) sendHello(true)
        break
      }
      case 'pong':
        const wasReady = state.ready
        dispatch({ type: 'pong', now: now() })
        if (!wasReady) sendHello(true)
        break
      case 'charade': {
        if (message.data.emotes.length !== 3 || message.data.answers.length !== 3) {
          resolveRequests('nextCharade')
          dispatch({ type: 'error', code: 'invalid_charade' })
          break
        }
        const [first, second, third] = message.data.emotes
        const [firstAnswer, secondAnswer, thirdAnswer] = message.data.answers
        const charade: DecodeCharade = {
          ...message.data,
          emotes: [first, second, third],
          answers: [firstAnswer, secondAnswer, thirdAnswer]
        }
        resolveRequests('nextCharade')
        if (state.roundCharadeId && state.roundCharadeId !== charade.id) {
          requestNextCharade()
          break
        }
        dispatch({ type: 'charade', charade })
        effects.showPerformer?.(charade.look, charade.emotes)
        break
      }
      case 'reveal':
        resolveRequests('guess', 'roundGuess')
        dispatch({ type: 'reveal', reveal: message.data })
        effects.revealAudience?.(message.data.correct)
        break
      case 'posted':
        resolveRequests('post')
        dispatch({ type: 'posted', charadeId: message.data.charadeId })
        break
      case 'since':
        dispatch({ type: 'since', summary: message.data })
        break
      case 'audience':
        dispatch({ type: 'audience', looks: message.data.looks })
        break
      case 'boards':
        dispatch({ type: 'boards', boards: message.data })
        break
      case 'roundStart': {
        const needsRoundCharade = state.charade?.id !== message.data.charadeId
        dispatch({ type: 'roundStart', charadeId: message.data.charadeId })
        if (needsRoundCharade) requestNextCharade()
        break
      }
      case 'roundWinner': {
        resolveRequests('roundGuess')
        dispatch({ type: 'roundWinner', address: message.data.address, name: message.data.name, now: now() })
        const profile = options.getProfile?.()
        if (profile && profile.address.toLowerCase() === message.data.address.toLowerCase()) beginAuthoring()
        break
      }
      case 'react':
        if (isReactionKind(message.data.kind)) {
          dispatch({ type: 'reaction', kind: message.data.kind, from: message.from })
        }
        break
      case 'error':
        requests.clear()
        dispatch({ type: 'error', code: message.data.code })
        break
    }
  }

  function tick(deltaSeconds: number) {
    const currentTime = now()
    const transportReady = options.isTransportReady?.() ?? true
    if (transportReady !== state.transportReady) {
      dispatch({ type: 'transport', ready: transportReady })
      if (!transportReady) {
        helloSent = false
        lastHelloInstance = ''
      }
    }

    if (transportReady) sendHello()

    if (
      state.ready &&
      state.lastHeartbeatAt > 0 &&
      currentTime - state.lastHeartbeatAt >= HEARTBEAT_TIMEOUT_MILLISECONDS
    ) {
      dispatch({ type: 'heartbeatTimeout' })
      heartbeatElapsed = HEARTBEAT_SECONDS
    }

    heartbeatElapsed += deltaSeconds
    const heartbeatInterval = state.ready ? CONNECTED_HEARTBEAT_SECONDS : HEARTBEAT_SECONDS
    if (transportReady && heartbeatElapsed >= heartbeatInterval) {
      heartbeatElapsed = 0
      pingSequence += 1
      emit({ type: 'ping', data: { seq: pingSequence } })
    }

    if (state.ready) {
      for (const [requestId, stored] of requests) {
        const pending = state.pending.find((request) => request.requestId === requestId)
        if (!pending || currentTime - pending.sentAt < REQUEST_RETRY_MILLISECONDS) continue
        if (pending.retries === 0) {
          emit(stored.message)
          stored.request = { ...pending, retries: 1, sentAt: currentTime }
          dispatch({ type: 'requestRetried', requestId, now: currentTime })
        } else {
          requests.delete(requestId)
          dispatch({ type: 'requestTimedOut', requestId })
        }
      }
    }

    if (state.toast && currentTime - state.toast.shownAt >= TOAST_MILLISECONDS) dispatch({ type: 'clearToast' })
  }

  function requestNextCharade() {
    if (!state.ready || state.pending.some((request) => request.kind === 'nextCharade')) return false
    const requestId = createRequestId()
    sendRequest(
      'nextCharade',
      { type: 'nextCharade', data: { exclude: state.charade ? [state.charade.id] : [] } },
      requestId
    )
    return true
  }

  function guess(answerIndex: number) {
    if (
      !state.ready ||
      !state.charade ||
      state.screen !== 'decode' ||
      answerIndex < 0 ||
      answerIndex >= state.charade.answers.length
    ) {
      return false
    }
    if (state.pending.some((request) => request.kind === 'guess' || request.kind === 'roundGuess')) return false
    const requestId = createRequestId()
    const round = state.roundCharadeId === state.charade.id
    const type = round ? 'roundGuess' : 'guess'
    sendRequest(type, { type, data: { charadeId: state.charade.id, answerIndex, requestId } }, requestId)
    return true
  }

  function beginAuthoring() {
    if (!state.ready) return false
    const seed = createRequestId()
    const phrase = dealPhrase(DECK, state.dealtPhraseIds, seed)
    if (!phrase) {
      dispatch({ type: 'error', code: 'deck_exhausted' })
      return false
    }
    dispatch({
      type: 'author',
      draft: { phrase, offeredEmotes: offerEmotes(phrase, seed), selectedEmotes: [], shufflesRemaining: 2 }
    })
    return true
  }

  function shuffleAuthorPhrase() {
    if (!state.author || state.author.shufflesRemaining <= 0) return false
    const seed = createRequestId()
    const phrase = dealPhrase(DECK, state.dealtPhraseIds, seed)
    if (!phrase) return false
    dispatch({
      type: 'author',
      draft: {
        phrase,
        offeredEmotes: offerEmotes(phrase, seed),
        selectedEmotes: [],
        shufflesRemaining: state.author.shufflesRemaining - 1
      }
    })
    return true
  }

  function selectAuthorEmote(emote: Emote) {
    if (!state.author) return false
    dispatch({ type: 'authorSelect', emote })
    return true
  }

  function previewAuthor() {
    if (!state.author || state.author.selectedEmotes.length !== 3) return false
    const look = options.getLook?.()
    if (!look) {
      dispatch({ type: 'error', code: 'player_look_unavailable' })
      return false
    }
    const [first, second, third] = state.author.selectedEmotes
    effects.showPreview?.(look, [first, second, third])
    return true
  }

  function postAuthor() {
    if (!state.ready || !state.author || state.author.selectedEmotes.length !== 3) return false
    if (state.pending.some((request) => request.kind === 'post')) return false
    const requestId = createRequestId()
    sendRequest(
      'post',
      {
        type: 'post',
        data: { phraseId: state.author.phrase.id, emotes: [...state.author.selectedEmotes], requestId }
      },
      requestId
    )
    return true
  }

  return {
    getState: () => state,
    dispatch,
    receive,
    tick,
    subscribe(listener: (nextState: ClientFlowState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setEffects(nextEffects: FlowEffects) {
      effects = nextEffects
    },
    requestNextCharade,
    guess,
    replay() {
      if (!state.charade || state.screen !== 'decode') return false
      effects.replayPerformer?.()
      return true
    },
    beginAuthoring,
    shuffleAuthorPhrase,
    selectAuthorEmote,
    previewAuthor,
    postAuthor,
    dismissSince() {
      dispatch({ type: 'dismissSince' })
    },
    showFoyer() {
      dispatch({ type: 'show', screen: 'foyer' })
    },
    showBoards() {
      dispatch({ type: 'show', screen: 'boards' })
    },
    showInvite() {
      dispatch({ type: 'show', screen: 'invite' })
    },
    setInviteStatus(status: ClientFlowState['inviteStatus']) {
      dispatch({ type: 'inviteStatus', status })
    },
    reportError(code: string, error?: unknown) {
      if (error !== undefined) console.error(`Ghost Charades ${code}`, error)
      requests.clear()
      dispatch({ type: 'error', code })
    }
  }
}

function isReactionKind(kind: string): kind is ReactionKind {
  return kind === 'laugh' || kind === 'confused' || kind === 'genius'
}

function sendRoomMessage(message: OutboundMessage) {
  switch (message.type) {
    case 'hello':
      return room.send('hello', message.data)
    case 'ping':
      return room.send('ping', message.data)
    case 'nextCharade':
      return room.send('nextCharade', message.data)
    case 'guess':
      return room.send('guess', message.data)
    case 'roundGuess':
      return room.send('roundGuess', message.data)
    case 'post':
      return room.send('post', message.data)
  }
}

export const clientFlow = createFlowRuntime({
  send: sendRoomMessage,
  getProfile: () => {
    const player = getPlayer()
    return player ? { address: player.userId, name: player.name, isGuest: player.isGuest } : null
  },
  getLook: () => {
    const player = getPlayer()
    if (!player?.avatar) return null
    return {
      address: player.userId,
      name: player.name,
      isGuest: player.isGuest,
      bodyShape: player.avatar.bodyShapeUrn,
      skinColor: player.avatar.skinColor ?? { r: 0.6, g: 0.46, b: 0.36 },
      hairColor: player.avatar.hairColor ?? { r: 0.28, g: 0.14, b: 0 },
      eyeColor: player.avatar.eyesColor ?? { r: 0.3, g: 0.48, b: 0.62 },
      wearables: [...player.wearables]
    }
  },
  isTransportReady: () => room.isReady()
})

let started = false

export function startClientFlow() {
  if (started) return
  started = true

  room.onReady((ready) => clientFlow.dispatch({ type: 'transport', ready }))
  room.onMessage('ready', (data) => clientFlow.receive({ type: 'ready', data }))
  room.onMessage('pong', (data) => clientFlow.receive({ type: 'pong', data }))
  room.onMessage('charade', (data) => clientFlow.receive({ type: 'charade', data }))
  room.onMessage('reveal', (data) => clientFlow.receive({ type: 'reveal', data }))
  room.onMessage('posted', (data) => clientFlow.receive({ type: 'posted', data }))
  room.onMessage('since', (data) => clientFlow.receive({ type: 'since', data }))
  room.onMessage('audience', (data) => clientFlow.receive({ type: 'audience', data }))
  room.onMessage('boards', (data) => clientFlow.receive({ type: 'boards', data }))
  room.onMessage('roundStart', (data) => clientFlow.receive({ type: 'roundStart', data }))
  room.onMessage('roundWinner', (data) => clientFlow.receive({ type: 'roundWinner', data }))
  room.onMessage('react', (data, context) => clientFlow.receive({ type: 'react', data, from: context?.from ?? '' }))
  room.onMessage('error', (data) => clientFlow.receive({ type: 'error', data }))

  engine.addSystem((deltaSeconds) => clientFlow.tick(deltaSeconds))
}
