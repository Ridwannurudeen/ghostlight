import { engine } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/src/players'
import { DECK, type Emote, type Phrase } from '../shared/deck'
import {
  AUDIENCE_SEATS,
  HEARTBEAT_SECONDS,
  PROTOCOL_VERSION,
  THEMES,
  TITLES,
  type PlayerTitle,
  type ThemeId
} from '../shared/config'
import { room } from '../shared/messages'
import { dealPhrase, offerEmotes } from '../shared/pick'
import type { DailyProgress, Look, NextUnlock, PlaybillPerformer } from '../shared/types'

export type FlowScreen = 'waking' | 'foyer' | 'since' | 'decode' | 'reveal' | 'author' | 'posted' | 'boards' | 'invite'

export type ReactionKind = 'laugh' | 'confused' | 'genius'
export type GhostEmotes = [string, string, string]

export type DecodeReply = {
  address: string
  name: string
  look: Look
  emotes: GhostEmotes
  createdAt: number
}

export type DecodeCharade = {
  id: string
  authorName: string
  authorAddress: string
  look: Look
  emotes: GhostEmotes
  answers: [string, string, string]
  createdAt: number
  isHouse: boolean
  authorTitle: PlayerTitle
  reply: DecodeReply | null
}

export type ProgressView = {
  daily: DailyProgress
  title: PlayerTitle
  nextUnlock: NextUnlock
}

export type RevealResult = ProgressView & {
  charadeId: string
  correct: boolean
  phraseId: string
  phrase: string
  stats: {
    total: number
    correct: number
  }
  yourScore: number
  stampAwarded: boolean
  titleUnlocked: boolean
}

export type SinceSummary = ProgressView & {
  triedYou: number
  gotYou: number
  replies: number
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
  playbill: PlaybillPerformer[]
  ghostOfNightId: string
}

export type GhostOfNightView = {
  charadeId: string
  address: string
  name: string
  title: PlayerTitle
  look: Look
  total: number
  correct: number
}

export type ProgressNotice =
  | { id: string; kind: 'stamp' }
  | { id: string; kind: 'title'; title: Exclude<PlayerTitle, ''> }

export type AuthorDraft = {
  phrase: Phrase
  offeredEmotes: Emote[]
  selectedEmotes: Emote[]
  shufflesRemaining: number
  replyTo?: string
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
  serverClockOffset: number
  theme: ThemeId
  themeLabel: string
  playerAddress: string
  playerName: string
  progress: ProgressView
  playerTitles: Record<string, PlayerTitle>
  notices: ProgressNotice[]
  charade: DecodeCharade | null
  reveal: RevealResult | null
  author: AuthorDraft | null
  dealtPhraseIds: string[]
  postedCharadeId: string
  postedReplyTo: string
  boards: BoardsView
  ghostOfNight: GhostOfNightView | null
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
  | {
      type: 'ready'
      instanceId: string
      serverTime: number
      now: number
      theme: ThemeId
      themeLabel: string
      playerAddress: string
      playerName: string
    }
  | { type: 'pong'; now: number }
  | { type: 'heartbeatTimeout' }
  | { type: 'charade'; charade: DecodeCharade }
  | { type: 'charadeReply'; charadeId: string; reply: DecodeReply }
  | { type: 'reveal'; reveal: RevealResult }
  | { type: 'author'; draft: AuthorDraft }
  | { type: 'authorSelect'; emote: Emote }
  | { type: 'authorBack' }
  | { type: 'progress'; progress: ProgressView }
  | { type: 'playerTitle'; address: string; title: PlayerTitle }
  | {
      type: 'posted'
      result: { charadeId: string; replyTo?: string } & ProgressView & {
          stampAwarded: boolean
          titleUnlocked: boolean
        }
    }
  | { type: 'since'; summary: SinceSummary }
  | { type: 'dismissSince' }
  | { type: 'audience'; looks: Look[] }
  | { type: 'boards'; boards: BoardsView }
  | { type: 'ghostOfNight'; ghost: GhostOfNightView }
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
  | { type: 'dismissNotice'; id: string }
  | { type: 'error'; code: string }

export function createInitialFlowState(): ClientFlowState {
  const initialTheme = THEMES[0]
  return {
    screen: 'waking',
    resumeScreen: null,
    ready: false,
    transportReady: false,
    instanceId: '',
    lastHeartbeatAt: 0,
    serverClockOffset: 0,
    theme: initialTheme.id,
    themeLabel: initialTheme.label,
    playerAddress: '',
    playerName: '',
    progress: {
      daily: { day: '', decoded: 0, authored: 0, stamped: false },
      title: '',
      nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 }
    },
    playerTitles: {},
    notices: [],
    charade: null,
    reveal: null,
    author: null,
    dealtPhraseIds: [],
    postedCharadeId: '',
    postedReplyTo: '',
    boards: { topDecoders: [], hardestGhosts: [], playbill: [], ghostOfNightId: '' },
    ghostOfNight: null,
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

function appendProgressNotices(
  notices: ProgressNotice[],
  id: string,
  result: { stampAwarded: boolean; titleUnlocked: boolean; title: PlayerTitle }
) {
  const incoming: ProgressNotice[] = []
  if (result.stampAwarded) incoming.push({ id: `${id}:stamp`, kind: 'stamp' })
  if (result.titleUnlocked && result.title !== '') {
    incoming.push({ id: `${id}:title:${result.title}`, kind: 'title', title: result.title })
  }
  const known = new Set(notices.map((notice) => notice.id))
  return [...notices, ...incoming.filter((notice) => !known.has(notice.id))]
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
      const screen = newInstance
        ? 'foyer'
        : state.screen !== 'waking'
          ? state.screen
          : (state.resumeScreen ?? (state.since && !state.sinceShown ? 'since' : 'foyer'))
      return {
        ...state,
        ready: true,
        transportReady: true,
        instanceId: action.instanceId,
        lastHeartbeatAt: action.now,
        serverClockOffset: action.serverTime - action.now,
        theme: action.theme,
        themeLabel: action.themeLabel,
        playerAddress: action.playerAddress,
        playerName: action.playerName,
        screen,
        resumeScreen: null,
        charade: newInstance ? null : state.charade,
        audience: newInstance ? [] : state.audience,
        roundCharadeId: newInstance ? '' : state.roundCharadeId,
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
    case 'charadeReply':
      return state.charade?.id === action.charadeId
        ? { ...state, charade: { ...state.charade, reply: action.reply } }
        : state
    case 'reveal':
      return {
        ...state,
        screen: state.screen === 'author' ? 'author' : 'reveal',
        reveal: action.reveal,
        progress: {
          daily: action.reveal.daily,
          title: action.reveal.title,
          nextUnlock: action.reveal.nextUnlock
        },
        notices: appendProgressNotices(state.notices, action.reveal.charadeId, action.reveal),
        roundCharadeId: state.roundCharadeId === action.reveal.charadeId ? '' : state.roundCharadeId,
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
    case 'authorBack':
      return { ...state, screen: state.reveal ? 'reveal' : 'foyer' }
    case 'progress':
      return { ...state, progress: action.progress }
    case 'playerTitle':
      return {
        ...state,
        playerTitles: { ...state.playerTitles, [action.address.toLowerCase()]: action.title }
      }
    case 'posted':
      return {
        ...state,
        screen: 'posted',
        postedCharadeId: action.result.charadeId,
        postedReplyTo: action.result.replyTo ?? '',
        progress: {
          daily: action.result.daily,
          title: action.result.title,
          nextUnlock: action.result.nextUnlock
        },
        notices: appendProgressNotices(state.notices, action.result.charadeId, action.result),
        errorCode: '',
        pending: state.pending.filter((request) => request.kind !== 'post')
      }
    case 'since':
      return {
        ...state,
        since: action.summary,
        progress: {
          daily: action.summary.daily,
          title: action.summary.title,
          nextUnlock: action.summary.nextUnlock
        },
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
      return {
        ...state,
        boards: action.boards,
        ghostOfNight: state.ghostOfNight?.charadeId === action.boards.ghostOfNightId ? state.ghostOfNight : null
      }
    case 'ghostOfNight':
      return action.ghost.charadeId === state.boards.ghostOfNightId ? { ...state, ghostOfNight: action.ghost } : state
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
    case 'dismissNotice':
      return { ...state, notices: state.notices.filter((notice) => notice.id !== action.id) }
    case 'error':
      return {
        ...state,
        roundCharadeId:
          state.screen === 'decode' && state.roundCharadeId === state.charade?.id ? '' : state.roundCharadeId,
        errorCode: action.code,
        pending: []
      }
  }
}

export type OutboundMessage =
  | { type: 'hello'; data: { displayName: string; isGuest: boolean; protocolVersion: number } }
  | { type: 'ping'; data: { seq: number } }
  | { type: 'nextCharade'; data: { exclude: string[] } }
  | { type: 'guess'; data: { charadeId: string; answerIndex: number; requestId: string } }
  | { type: 'roundGuess'; data: { charadeId: string; answerIndex: number; requestId: string } }
  | { type: 'post'; data: { phraseId: string; emotes: string[]; requestId: string; replyTo?: string } }

type ServerProgress = {
  daily?: DailyProgress
  title?: string
  nextUnlock?: NextUnlock
}

type ServerReveal = Omit<RevealResult, keyof ProgressView | 'stampAwarded' | 'titleUnlocked' | 'phraseId'> &
  ServerProgress & { phraseId?: string; stampAwarded?: boolean; titleUnlocked?: boolean }

type ServerPosted = { charadeId: string; replyTo?: string } & ServerProgress & {
    stampAwarded?: boolean
    titleUnlocked?: boolean
  }

type ServerReply = Omit<DecodeReply, 'emotes'> & { charadeId: string; emotes: string[] }

export type ServerMessage =
  | {
      type: 'ready'
      data: { instanceId: string; serverTime: number; theme?: string; themeLabel?: string }
    }
  | { type: 'pong'; data: { seq: number } }
  | { type: 'progress'; data: ProgressView }
  | { type: 'playerTitle'; data: { address: string; title: string } }
  | {
      type: 'charade'
      data: Omit<DecodeCharade, 'emotes' | 'answers' | 'authorTitle' | 'reply'> & {
        emotes: string[]
        answers: string[]
        authorTitle?: string
      }
    }
  | { type: 'charadeReply'; data: ServerReply }
  | { type: 'reveal'; data: ServerReveal }
  | { type: 'posted'; data: ServerPosted }
  | {
      type: 'since'
      data: Pick<SinceSummary, 'triedYou' | 'gotYou' | 'rank'> & { replies?: number } & ServerProgress
    }
  | { type: 'audience'; data: { looks: Look[] } }
  | { type: 'boards'; data: BoardsView }
  | { type: 'ghostOfNight'; data: GhostOfNightView }
  | { type: 'roundStart'; data: { charadeId: string } }
  | { type: 'roundWinner'; data: { address: string; name: string } }
  | { type: 'react'; data: { kind: string }; from: string }
  | { type: 'error'; data: { code: string } }

export type FlowEffects = {
  showPerformer?: (look: Look, emotes: GhostEmotes) => void
  showDuet?: (author: { look: Look; emotes: GhostEmotes }, reply: DecodeReply) => void
  replayPerformer?: () => void
  showPreview?: (look: Look, emotes: GhostEmotes) => void
  clearPreview?: () => void
  showReward?: (address: string, title: PlayerTitle) => void
  showGhostOfNight?: (ghost: GhostOfNightView | null) => void
  beginReveal?: (charade: DecodeCharade, answerIndex: number) => void
  resolveReveal?: (reveal: RevealResult, charade: DecodeCharade) => void
  skipReveal?: () => void
  cancelReveal?: () => void
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

function isPlayerTitle(value: string): value is PlayerTitle {
  return value === '' || TITLES.some((title) => title === value)
}

function progressFrom(data: ServerProgress, fallback: ProgressView): ProgressView {
  if (!data.daily || !data.nextUnlock || typeof data.title !== 'string' || !isPlayerTitle(data.title)) return fallback
  return { daily: data.daily, title: data.title, nextUnlock: data.nextUnlock }
}

function canonicalAddress(address: string) {
  return address.toLowerCase()
}

export function canAnswerBack(state: ClientFlowState) {
  return (
    state.ready &&
    state.screen === 'reveal' &&
    !!state.playerAddress &&
    !!state.charade &&
    !state.charade.isHouse &&
    !state.charade.reply &&
    canonicalAddress(state.charade.authorAddress) !== canonicalAddress(state.playerAddress) &&
    state.reveal?.charadeId === state.charade.id &&
    !!state.reveal.phraseId
  )
}

export function createFlowRuntime(options: FlowRuntimeOptions) {
  let state = createInitialFlowState()
  let effects = options.effects ?? {}
  let heartbeatElapsed = HEARTBEAT_SECONDS
  let pingSequence = 0
  let requestSequence = 0
  let helloSent = false
  let lastHelloInstance = ''
  let roundMismatchRefetchAttempted = false
  const requests = new Map<string, StoredRequest>()
  const pendingReplies = new Map<string, DecodeReply>()
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
        const theme =
          THEMES.find((candidate) => candidate.id === message.data.theme) ??
          THEMES.find((candidate) => candidate.id === state.theme)!
        const profile = options.getProfile?.()
        if (instanceChanged) roundMismatchRefetchAttempted = false
        dispatch({
          type: 'ready',
          instanceId: message.data.instanceId,
          serverTime: message.data.serverTime,
          now: now(),
          theme: theme.id,
          themeLabel: message.data.themeLabel || theme.label,
          playerAddress: profile?.address ?? state.playerAddress,
          playerName: profile?.name ?? state.playerName
        })
        if (instanceChanged || lastHelloInstance !== message.data.instanceId) sendHello(true)
        requestRoundCharadeIfNeeded()
        break
      }
      case 'progress': {
        const progress = progressFrom(message.data, state.progress)
        dispatch({ type: 'progress', progress })
        if (state.playerAddress) effects.showReward?.(state.playerAddress, progress.title)
        break
      }
      case 'playerTitle':
        if (isPlayerTitle(message.data.title)) {
          dispatch({ type: 'playerTitle', address: message.data.address, title: message.data.title })
          effects.showReward?.(message.data.address, message.data.title)
        }
        break
      case 'pong':
        const wasReady = state.ready
        dispatch({ type: 'pong', now: now() })
        if (!wasReady) sendHello(true)
        requestRoundCharadeIfNeeded()
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
          answers: [firstAnswer, secondAnswer, thirdAnswer],
          authorTitle:
            typeof message.data.authorTitle === 'string' && isPlayerTitle(message.data.authorTitle)
              ? message.data.authorTitle
              : '',
          reply: pendingReplies.get(message.data.id) ?? null
        }
        pendingReplies.delete(message.data.id)
        resolveRequests('nextCharade')
        if (state.roundCharadeId && state.roundCharadeId !== charade.id && !roundMismatchRefetchAttempted) {
          if (requestNextCharade()) {
            roundMismatchRefetchAttempted = true
            break
          }
        }
        effects.cancelReveal?.()
        dispatch({ type: 'charade', charade })
        if (charade.reply) {
          effects.showDuet?.({ look: charade.look, emotes: charade.emotes }, charade.reply)
        } else {
          effects.showPerformer?.(charade.look, charade.emotes)
        }
        effects.showReward?.(charade.authorAddress, charade.authorTitle)
        break
      }
      case 'charadeReply': {
        if (
          !message.data.charadeId ||
          message.data.emotes.length !== 3 ||
          canonicalAddress(message.data.address) !== canonicalAddress(message.data.look.address)
        ) {
          break
        }
        const [first, second, third] = message.data.emotes
        const reply: DecodeReply = {
          address: message.data.address,
          name: message.data.name,
          look: message.data.look,
          emotes: [first, second, third],
          createdAt: message.data.createdAt
        }
        if (state.charade?.id === message.data.charadeId) {
          dispatch({ type: 'charadeReply', charadeId: message.data.charadeId, reply })
          effects.showDuet?.({ look: state.charade.look, emotes: state.charade.emotes }, reply)
        } else {
          pendingReplies.set(message.data.charadeId, reply)
          if (pendingReplies.size > 20) pendingReplies.delete(pendingReplies.keys().next().value!)
        }
        break
      }
      case 'reveal':
        const revealedCharade = state.charade
        const revealProgress = progressFrom(message.data, state.progress)
        const reveal: RevealResult = {
          ...message.data,
          ...revealProgress,
          phraseId: message.data.phraseId ?? '',
          stampAwarded: message.data.stampAwarded === true,
          titleUnlocked: message.data.titleUnlocked === true
        }
        if (state.roundCharadeId === message.data.charadeId) roundMismatchRefetchAttempted = false
        resolveRequests('guess', 'roundGuess')
        dispatch({ type: 'reveal', reveal })
        if (state.playerAddress) effects.showReward?.(state.playerAddress, reveal.title)
        if (revealedCharade?.id === message.data.charadeId) effects.resolveReveal?.(reveal, revealedCharade)
        break
      case 'posted': {
        const postedProgress = progressFrom(message.data, state.progress)
        const result = {
          charadeId: message.data.charadeId,
          replyTo: message.data.replyTo,
          ...postedProgress,
          stampAwarded: message.data.stampAwarded === true,
          titleUnlocked: message.data.titleUnlocked === true
        }
        resolveRequests('post')
        dispatch({ type: 'posted', result })
        if (state.playerAddress) effects.showReward?.(state.playerAddress, result.title)
        break
      }
      case 'since': {
        const sinceProgress = progressFrom(message.data, state.progress)
        dispatch({ type: 'since', summary: { ...message.data, replies: message.data.replies ?? 0, ...sinceProgress } })
        if (state.playerAddress) effects.showReward?.(state.playerAddress, sinceProgress.title)
        break
      }
      case 'audience':
        dispatch({ type: 'audience', looks: message.data.looks })
        break
      case 'boards': {
        const boards = {
          ...message.data,
          playbill: message.data.playbill ?? [],
          ghostOfNightId: message.data.ghostOfNightId ?? ''
        }
        if (state.ghostOfNight?.charadeId !== boards.ghostOfNightId) effects.showGhostOfNight?.(null)
        dispatch({ type: 'boards', boards })
        break
      }
      case 'ghostOfNight':
        if (message.data.charadeId === state.boards.ghostOfNightId && isPlayerTitle(message.data.title)) {
          dispatch({ type: 'ghostOfNight', ghost: message.data })
          effects.showGhostOfNight?.(message.data)
        }
        break
      case 'roundStart': {
        if (state.roundCharadeId !== message.data.charadeId) roundMismatchRefetchAttempted = false
        dispatch({ type: 'roundStart', charadeId: message.data.charadeId })
        requestRoundCharadeIfNeeded()
        break
      }
      case 'roundWinner': {
        roundMismatchRefetchAttempted = false
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
        const refetchUnservedCharade = message.data.code === 'charade-not-served' && state.screen === 'decode'
        const resumeDeferredRound =
          state.screen === 'decode' &&
          !!state.roundCharadeId &&
          state.charade?.id !== state.roundCharadeId &&
          state.pending.some((request) => request.kind === 'guess' || request.kind === 'roundGuess')
        if (state.screen === 'decode') roundMismatchRefetchAttempted = false
        effects.cancelReveal?.()
        requests.clear()
        dispatch({ type: 'error', code: message.data.code })
        if (refetchUnservedCharade) requestNextCharade()
        else if (resumeDeferredRound) requestRoundCharadeIfNeeded()
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
    if (state.screen === 'reveal') effects.skipReveal?.()
    const requestId = createRequestId()
    sendRequest(
      'nextCharade',
      { type: 'nextCharade', data: { exclude: state.charade ? [state.charade.id] : [] } },
      requestId
    )
    return true
  }

  function requestRoundCharadeIfNeeded() {
    const guessPending = state.pending.some((request) => request.kind === 'guess' || request.kind === 'roundGuess')
    if (
      state.screen === 'decode' &&
      state.roundCharadeId &&
      state.charade?.id !== state.roundCharadeId &&
      !roundMismatchRefetchAttempted &&
      !guessPending
    ) {
      requestNextCharade()
    }
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
    effects.beginReveal?.(state.charade, answerIndex)
    return true
  }

  function beginAuthoring() {
    if (!state.ready) return false
    effects.cancelReveal?.()
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

  function beginAnswerBack() {
    if (!canAnswerBack(state)) return false
    const charade = state.charade!
    const phrase = DECK.find((candidate) => candidate.id === state.reveal!.phraseId)
    if (!phrase) {
      dispatch({ type: 'error', code: 'invalid_reply_phrase' })
      return false
    }
    effects.cancelReveal?.()
    const seed = createRequestId()
    dispatch({
      type: 'author',
      draft: {
        phrase,
        offeredEmotes: offerEmotes(phrase, seed),
        selectedEmotes: [],
        shufflesRemaining: 0,
        replyTo: charade.id
      }
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
        data: {
          phraseId: state.author.phrase.id,
          emotes: [...state.author.selectedEmotes],
          requestId,
          ...(state.author.replyTo ? { replyTo: state.author.replyTo } : {})
        }
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
    beginAnswerBack,
    canAnswerBack: () => canAnswerBack(state),
    shuffleAuthorPhrase,
    selectAuthorEmote,
    previewAuthor,
    postAuthor,
    backFromAuthor() {
      effects.clearPreview?.()
      dispatch({ type: 'authorBack' })
    },
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
    dismissNotice(id: string) {
      dispatch({ type: 'dismissNotice', id })
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
  room.onMessage('progress', (data) => clientFlow.receive({ type: 'progress', data: data as unknown as ProgressView }))
  room.onMessage('playerTitle', (data) => clientFlow.receive({ type: 'playerTitle', data }))
  room.onMessage('charade', (data) => clientFlow.receive({ type: 'charade', data }))
  room.onMessage('charadeReply', (data) =>
    clientFlow.receive({ type: 'charadeReply', data: data as unknown as ServerReply })
  )
  room.onMessage('reveal', (data) => clientFlow.receive({ type: 'reveal', data: data as unknown as ServerReveal }))
  room.onMessage('posted', (data) => clientFlow.receive({ type: 'posted', data: data as unknown as ServerPosted }))
  room.onMessage('since', (data) =>
    clientFlow.receive({
      type: 'since',
      data: data as unknown as Pick<SinceSummary, 'triedYou' | 'gotYou' | 'rank'> & {
        replies?: number
      } & ServerProgress
    })
  )
  room.onMessage('audience', (data) => clientFlow.receive({ type: 'audience', data }))
  room.onMessage('boards', (data) => clientFlow.receive({ type: 'boards', data: data as unknown as BoardsView }))
  room.onMessage('ghostOfNight', (data) =>
    clientFlow.receive({ type: 'ghostOfNight', data: data as unknown as GhostOfNightView })
  )
  room.onMessage('roundStart', (data) => clientFlow.receive({ type: 'roundStart', data }))
  room.onMessage('roundWinner', (data) => clientFlow.receive({ type: 'roundWinner', data }))
  room.onMessage('react', (data, context) => clientFlow.receive({ type: 'react', data, from: context?.from ?? '' }))
  room.onMessage('error', (data) => clientFlow.receive({ type: 'error', data }))

  engine.addSystem((deltaSeconds) => clientFlow.tick(deltaSeconds))
}
