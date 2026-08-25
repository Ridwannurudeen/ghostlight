import { engine } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/src/players'
import { DECK, type Emote, type Phrase, type PhraseId } from '../shared/deck'
import {
  AUDIENCE_SEATS,
  HEARTBEAT_SECONDS,
  PROTOCOL_VERSION,
  THEMES,
  TITLES,
  type PlayerTitle,
  type ThemeId
} from '../shared/config'
import { SPECTATOR_REACTION_KINDS, room } from '../shared/messages'
import { isPhraseId, normalizePlayerName } from '../shared/i18n'
import { dealPhrase, offerEmotes } from '../shared/pick'
import type { DailyProgress, Look, NextUnlock, PlaybillPerformer } from '../shared/types'
import {
  recordDiagnosticsCharade,
  recordDiagnosticsGuess,
  recordDiagnosticsPing,
  recordDiagnosticsPong,
  recordDiagnosticsPost,
  recordDiagnosticsServerAttempt,
  recordDiagnosticsServerReady
} from './diagnostics'
import { sanitizeAvatarLook } from './look'
import type { RevealRunOptions } from './reveal'
import { isInDecodeArea } from './theater'

export type FlowScreen =
  | 'waking'
  | 'foyer'
  | 'since'
  | 'decode'
  | 'reveal'
  | 'author'
  | 'posted'
  | 'boards'
  | 'invite'
  | 'mail'
  | 'howToPlay'
  | 'settings'

export type ReactionKind = (typeof SPECTATOR_REACTION_KINDS)[number]
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
  answerIds?: [PhraseId, PhraseId, PhraseId]
  createdAt: number
  isHouse: boolean
  recipient?: string
  authorTitle: PlayerTitle
  reply: DecodeReply | null
}

export type ProgressView = {
  daily: DailyProgress
  title: PlayerTitle
  nextUnlock: NextUnlock
}

export type RevealResult = ProgressView & {
  revision: number
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
  revision: number
  triedYou: number
  gotYou: number
  replies: number
  mail: number
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
  phase: 'phrase' | 'emotes' | 'confirm'
  replyTo?: string
  recipient?: {
    address: string
    name: string
  }
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
  playerIsGuest: boolean
  progress: ProgressView
  progressRevision: number
  notices: ProgressNotice[]
  charade: DecodeCharade | null
  reveal: RevealResult | null
  author: AuthorDraft | null
  authorReturnScreen: 'foyer' | 'decode' | 'reveal' | 'mail'
  dealtPhraseIds: string[]
  postedCharadeId: string
  postedReplyTo: string
  postedRecipient: string
  mailRecipient: {
    address: string
    name: string
  } | null
  boards: BoardsView
  ghostOfNight: GhostOfNightView | null
  since: SinceSummary | null
  sinceShown: boolean
  audience: Look[]
  reactionEvent: {
    kind: ReactionKind
    from: string
    sequence: number
    shownAt: number
  } | null
  reactionMenuOpen: boolean
  roundId: string
  latestRoundSequence: number
  roundCharadeId: string
  roundWinner: {
    address: string
    name: string
  } | null
  toast: {
    winnerName: string
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
      playerIsGuest?: boolean
    }
  | { type: 'pong'; now: number }
  | { type: 'heartbeatTimeout' }
  | { type: 'charade'; charade: DecodeCharade }
  | { type: 'charadeReply'; charadeId: string; reply: DecodeReply }
  | { type: 'reveal'; reveal: RevealResult }
  | { type: 'author'; draft: AuthorDraft; returnScreen: ClientFlowState['authorReturnScreen'] }
  | { type: 'authorPhase'; phase: AuthorDraft['phase'] }
  | { type: 'authorSelect'; emote: Emote }
  | { type: 'authorBack' }
  | { type: 'progress'; progress: ProgressView; revision: number }
  | {
      type: 'posted'
      result: { charadeId: string; replyTo?: string; recipient?: string; revision: number } & ProgressView & {
          stampAwarded: boolean
          titleUnlocked: boolean
        }
    }
  | { type: 'since'; summary: SinceSummary }
  | { type: 'dismissSince' }
  | { type: 'audience'; looks: Look[] }
  | { type: 'boards'; boards: BoardsView }
  | { type: 'ghostOfNight'; ghost: GhostOfNightView }
  | { type: 'mailRecipient'; recipient: ClientFlowState['mailRecipient'] }
  | { type: 'roundStart'; roundId: string; charadeId: string; sequence: number }
  | { type: 'roundWinner'; roundId: string; charadeId: string; address: string; name: string; now: number }
  | { type: 'reaction'; kind: ReactionKind; from: string; now: number }
  | { type: 'toggleReactionMenu' }
  | { type: 'show'; screen: 'foyer' | 'boards' | 'invite' | 'mail' | 'howToPlay' | 'settings' }
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
    playerIsGuest: true,
    progress: {
      daily: { day: '', decoded: 0, authored: 0, stamped: false },
      title: '',
      nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 }
    },
    progressRevision: -1,
    notices: [],
    charade: null,
    reveal: null,
    author: null,
    authorReturnScreen: 'foyer',
    dealtPhraseIds: [],
    postedCharadeId: '',
    postedReplyTo: '',
    postedRecipient: '',
    mailRecipient: null,
    boards: { topDecoders: [], hardestGhosts: [], playbill: [], ghostOfNightId: '' },
    ghostOfNight: null,
    since: null,
    sinceShown: false,
    audience: [],
    reactionEvent: null,
    reactionMenuOpen: false,
    roundId: '',
    latestRoundSequence: 0,
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
        playerIsGuest: action.playerIsGuest ?? true,
        screen,
        resumeScreen: null,
        charade: newInstance ? null : state.charade,
        reveal: newInstance ? null : state.reveal,
        author: newInstance ? null : state.author,
        authorReturnScreen: newInstance ? 'foyer' : state.authorReturnScreen,
        postedCharadeId: newInstance ? '' : state.postedCharadeId,
        postedReplyTo: newInstance ? '' : state.postedReplyTo,
        postedRecipient: newInstance ? '' : state.postedRecipient,
        mailRecipient: null,
        progressRevision: newInstance ? -1 : state.progressRevision,
        since: newInstance ? null : state.since,
        sinceShown: newInstance ? false : state.sinceShown,
        audience: newInstance ? [] : state.audience,
        reactionEvent: newInstance ? null : state.reactionEvent,
        reactionMenuOpen: false,
        roundId: newInstance ? '' : state.roundId,
        latestRoundSequence: newInstance ? 0 : state.latestRoundSequence,
        roundCharadeId: newInstance ? '' : state.roundCharadeId,
        roundWinner: newInstance ? null : state.roundWinner,
        toast: newInstance ? null : state.toast,
        pending: newInstance ? [] : state.pending,
        notices: newInstance ? [] : state.notices,
        boards: newInstance ? { topDecoders: [], hardestGhosts: [], playbill: [], ghostOfNightId: '' } : state.boards,
        ghostOfNight: newInstance ? null : state.ghostOfNight,
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
        screen: state.screen === 'since' && !state.sinceShown ? 'since' : 'decode',
        charade: action.charade,
        reveal: null,
        reactionMenuOpen: false,
        errorCode: '',
        pending: state.pending.filter((request) => request.kind !== 'nextCharade')
      }
    case 'charadeReply':
      return state.charade?.id === action.charadeId
        ? { ...state, charade: { ...state.charade, reply: action.reply } }
        : state
    case 'reveal': {
      const freshProgress = action.reveal.revision >= state.progressRevision
      return {
        ...state,
        screen: state.screen === 'author' ? 'author' : 'reveal',
        reveal: action.reveal,
        progress: freshProgress
          ? {
              daily: action.reveal.daily,
              title: action.reveal.title,
              nextUnlock: action.reveal.nextUnlock
            }
          : state.progress,
        progressRevision: freshProgress ? action.reveal.revision : state.progressRevision,
        notices: freshProgress
          ? appendProgressNotices(state.notices, action.reveal.charadeId, action.reveal)
          : state.notices,
        errorCode: '',
        pending: state.pending.filter((request) => request.kind !== 'guess' && request.kind !== 'roundGuess')
      }
    }
    case 'author':
      return {
        ...state,
        screen: 'author',
        author: action.draft,
        authorReturnScreen: action.returnScreen,
        dealtPhraseIds: state.dealtPhraseIds.includes(action.draft.phrase.id)
          ? state.dealtPhraseIds
          : [...state.dealtPhraseIds, action.draft.phrase.id],
        errorCode: ''
      }
    case 'authorPhase':
      return state.author ? { ...state, author: { ...state.author, phase: action.phase } } : state
    case 'authorSelect': {
      if (!state.author || !state.author.offeredEmotes.includes(action.emote)) return state
      const alreadySelected = state.author.selectedEmotes.includes(action.emote)
      const selectedEmotes = alreadySelected
        ? state.author.selectedEmotes.filter((emote) => emote !== action.emote)
        : state.author.selectedEmotes.length < 3
          ? [...state.author.selectedEmotes, action.emote]
          : state.author.selectedEmotes
      return {
        ...state,
        author: {
          ...state.author,
          selectedEmotes,
          phase: selectedEmotes.length === 3 ? 'confirm' : state.author.phase
        }
      }
    }
    case 'authorBack':
      return { ...state, screen: state.authorReturnScreen }
    case 'progress':
      return action.revision < state.progressRevision
        ? state
        : { ...state, progress: action.progress, progressRevision: action.revision }
    case 'posted': {
      const freshProgress = action.result.revision >= state.progressRevision
      return {
        ...state,
        screen: 'posted',
        postedCharadeId: action.result.charadeId,
        postedReplyTo: action.result.replyTo ?? '',
        postedRecipient: action.result.recipient ?? '',
        progress: freshProgress
          ? {
              daily: action.result.daily,
              title: action.result.title,
              nextUnlock: action.result.nextUnlock
            }
          : state.progress,
        progressRevision: freshProgress ? action.result.revision : state.progressRevision,
        notices: freshProgress
          ? appendProgressNotices(state.notices, action.result.charadeId, action.result)
          : state.notices,
        errorCode: '',
        pending: state.pending.filter((request) => request.kind !== 'post')
      }
    }
    case 'since':
      if (action.summary.revision < state.progressRevision) return state
      return {
        ...state,
        since: action.summary,
        progress: {
          daily: action.summary.daily,
          title: action.summary.title,
          nextUnlock: action.summary.nextUnlock
        },
        progressRevision: action.summary.revision,
        screen:
          state.ready && !state.sinceShown && (state.screen === 'foyer' || state.screen === 'waking')
            ? 'since'
            : state.screen
      }
    case 'dismissSince':
      return { ...state, sinceShown: true, screen: state.charade ? 'decode' : 'foyer' }
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
    case 'mailRecipient':
      return { ...state, mailRecipient: action.recipient }
    case 'roundStart':
      return action.sequence <= state.latestRoundSequence
        ? state
        : {
            ...state,
            roundId: action.roundId,
            latestRoundSequence: action.sequence,
            roundCharadeId: action.charadeId,
            roundWinner: null
          }
    case 'roundWinner':
      if (action.roundId !== state.roundId || action.charadeId !== state.roundCharadeId) return state
      return {
        ...state,
        roundWinner: { address: action.address, name: action.name },
        toast: { winnerName: action.name, shownAt: action.now },
        roundId: '',
        roundCharadeId: ''
      }
    case 'reaction':
      return {
        ...state,
        reactionEvent: {
          kind: action.kind,
          from: action.from,
          sequence: (state.reactionEvent?.sequence ?? 0) + 1,
          shownAt: action.now
        }
      }
    case 'toggleReactionMenu':
      return state.reactionMenuOpen || canSpectatorReact(state)
        ? { ...state, reactionMenuOpen: !state.reactionMenuOpen }
        : state
    case 'show':
      return {
        ...state,
        screen: action.screen,
        mailRecipient: action.screen === 'mail' ? state.mailRecipient : null,
        reactionMenuOpen: false,
        inviteStatus: action.screen === 'invite' ? 'idle' : state.inviteStatus
      }
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
        roundId: state.screen === 'decode' && state.roundCharadeId === state.charade?.id ? '' : state.roundId,
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
  | { type: 'nextCharade'; data: { requestId: string; exclude: string[] } }
  | { type: 'guess'; data: { charadeId: string; answerIndex: number; requestId: string } }
  | { type: 'roundGuess'; data: { charadeId: string; answerIndex: number; requestId: string } }
  | {
      type: 'post'
      data: { phraseId: string; emotes: string[]; requestId: string; replyTo?: string; recipient?: string }
    }

type ServerProgress = {
  daily?: DailyProgress
  title?: string
  nextUnlock?: NextUnlock
  revision: number
}

type ServerReveal = Omit<RevealResult, keyof ProgressView | 'stampAwarded' | 'titleUnlocked' | 'phraseId'> &
  ServerProgress & { requestId: string; phraseId?: string; stampAwarded?: boolean; titleUnlocked?: boolean }

type ServerPosted = { requestId: string; charadeId: string; replyTo?: string; recipient?: string } & ServerProgress & {
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
  | { type: 'progress'; data: ProgressView & { revision: number } }
  | { type: 'playerTitle'; data: { address: string; title: string } }
  | {
      type: 'charade'
      data: Omit<DecodeCharade, 'emotes' | 'answers' | 'answerIds' | 'authorTitle' | 'reply'> & {
        requestId: string
        emotes: string[]
        answers: string[]
        answerIds?: string[]
        authorTitle?: string
      }
    }
  | { type: 'charadeReply'; data: ServerReply }
  | { type: 'reveal'; data: ServerReveal }
  | { type: 'posted'; data: ServerPosted }
  | {
      type: 'since'
      data: Pick<SinceSummary, 'triedYou' | 'gotYou' | 'rank'> & { replies?: number; mail?: number } & ServerProgress
    }
  | { type: 'audience'; data: { looks: Look[] } }
  | { type: 'boards'; data: BoardsView }
  | { type: 'ghostOfNight'; data: GhostOfNightView }
  | { type: 'roundStart'; data: { roundId: string; charadeId: string } }
  | { type: 'roundWinner'; data: { roundId: string; charadeId: string; address: string; name: string } }
  | { type: 'react'; data: { kind: string }; from: string }
  | { type: 'error'; data: { code: string } }

export type FlowEffects = {
  showPerformer?: (look: Look, emotes: GhostEmotes) => void
  showDuet?: (author: { look: Look; emotes: GhostEmotes }, reply: DecodeReply) => void
  replayPerformer?: () => void
  showPreview?: (look: Look, emotes: GhostEmotes) => void
  clearPreview?: () => void
  clearPerformer?: () => void
  showReward?: (address: string, title: PlayerTitle) => void
  showStageReward?: (address: string, title: PlayerTitle) => void
  clearStageReward?: () => void
  showGhostOfNight?: (ghost: GhostOfNightView | null) => void
  beginReveal?: (charade: DecodeCharade, answerIndex: number, options?: RevealRunOptions) => void
  resolveReveal?: (reveal: RevealResult, charade: DecodeCharade) => void
  canAdvanceReveal?: () => boolean
  skipReveal?: () => boolean
  cancelReveal?: () => void
  cancelOpening?: () => void
}

export type FlowRuntimeOptions = {
  send: (message: OutboundMessage) => void | Promise<void>
  now?: () => number
  createRequestId?: () => string
  getProfile?: () => { address: string; name: string; isGuest: boolean } | null
  getLook?: () => Look | null
  isTransportReady?: () => boolean
  canDecode?: () => boolean
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

function validRevision(revision: number) {
  return Number.isSafeInteger(revision) && revision >= 0
}

function roundSequence(roundId: string) {
  if (!/^[1-9][0-9]*$/u.test(roundId)) return null
  const sequence = Number(roundId)
  return Number.isSafeInteger(sequence) ? sequence : null
}

function canonicalAddress(address: string) {
  return address.toLowerCase()
}

const STABLE_ADDRESS = /^0x[a-f0-9]{40}$/iu

export function mailRecipients(state: ClientFlowState) {
  const ownAddress = canonicalAddress(state.playerAddress)
  const seen = new Set<string>()
  return state.boards.playbill
    .filter((performer) => {
      const address = canonicalAddress(performer.address)
      if (performer.isGuest || !STABLE_ADDRESS.test(performer.address) || address === ownAddress || seen.has(address)) {
        return false
      }
      seen.add(address)
      return true
    })
    .map((performer) => ({ ...performer, name: normalizePlayerName(performer.name) }))
}

export function canSendMail(state: ClientFlowState) {
  return (
    state.ready && !state.playerIsGuest && STABLE_ADDRESS.test(state.playerAddress) && mailRecipients(state).length > 0
  )
}

export function canSpectatorReact(state: ClientFlowState) {
  return (
    state.ready &&
    (state.screen === 'foyer' || (state.screen === 'reveal' && state.reveal?.correct === false)) &&
    state.roundCharadeId !== '' &&
    state.pending.length === 0
  )
}

function sanitizeBoards(boards: BoardsView): BoardsView {
  return {
    topDecoders: boards.topDecoders.map((entry) => ({ ...entry, name: normalizePlayerName(entry.name) })),
    hardestGhosts: boards.hardestGhosts.map((entry) => ({
      ...entry,
      authorName: normalizePlayerName(entry.authorName)
    })),
    playbill: boards.playbill.slice(0, 6).map((performer) => ({
      ...performer,
      name: normalizePlayerName(performer.name),
      title: isPlayerTitle(performer.title) ? performer.title : ''
    })),
    ghostOfNightId: boards.ghostOfNightId
  }
}

type FlowProfile = NonNullable<ReturnType<NonNullable<FlowRuntimeOptions['getProfile']>>>

function isCompleteProfile(profile: FlowProfile | null | undefined): profile is FlowProfile {
  return !!profile && profile.address.trim().length > 0
}

export function canAnswerBack(state: ClientFlowState) {
  return (
    state.ready &&
    !state.playerIsGuest &&
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
    if (message.type === 'hello') {
      recordDiagnosticsServerAttempt(now())
    } else if (message.type === 'ping') {
      const sentAt = now()
      recordDiagnosticsServerAttempt(sentAt)
      recordDiagnosticsPing(message.data.seq, sentAt)
    }
    try {
      void Promise.resolve(options.send(message)).catch((error: unknown) => {
        console.error(`Ghostlight message ${message.type} failed`, error)
      })
    } catch (error: unknown) {
      console.error(`Ghostlight message ${message.type} failed`, error)
    }
  }

  function sendHello(force = false) {
    if (!options.getProfile || !state.transportReady) return
    const profile = options.getProfile()
    if (!isCompleteProfile(profile) || (!force && helloSent)) return
    emit({
      type: 'hello',
      data: {
        displayName: normalizePlayerName(profile.name),
        isGuest: profile.isGuest,
        protocolVersion: PROTOCOL_VERSION
      }
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

  function resolveRequest(requestId: string, ...kinds: PendingRequestKind[]) {
    const stored = requests.get(requestId)
    if (!stored || !kinds.includes(stored.request.kind)) return false
    requests.delete(requestId)
    dispatch({ type: 'requestResolved', kind: stored.request.kind })
    return true
  }

  function restoreCharadePresentation() {
    if (!state.charade) return
    if (state.charade.reply) {
      effects.showDuet?.({ look: state.charade.look, emotes: state.charade.emotes }, state.charade.reply)
    } else {
      effects.showPerformer?.(state.charade.look, state.charade.emotes)
    }
    effects.showStageReward?.(state.charade.authorAddress, state.charade.authorTitle)
  }

  function cancelReveal() {
    effects.cancelReveal?.()
  }

  function receive(message: ServerMessage) {
    switch (message.type) {
      case 'ready': {
        const receivedAt = now()
        recordDiagnosticsServerReady(receivedAt)
        const instanceChanged = state.instanceId !== message.data.instanceId
        const theme =
          THEMES.find((candidate) => candidate.id === message.data.theme) ??
          THEMES.find((candidate) => candidate.id === state.theme)!
        const candidateProfile = options.getProfile?.()
        const profile = isCompleteProfile(candidateProfile) ? candidateProfile : null
        if (instanceChanged) {
          roundMismatchRefetchAttempted = false
          requests.clear()
          pendingReplies.clear()
          effects.cancelOpening?.()
          cancelReveal()
          effects.clearPreview?.()
          effects.clearPerformer?.()
          effects.clearStageReward?.()
        }
        dispatch({
          type: 'ready',
          instanceId: message.data.instanceId,
          serverTime: message.data.serverTime,
          now: receivedAt,
          theme: theme.id,
          themeLabel: message.data.themeLabel || theme.label,
          playerAddress: profile?.address ?? state.playerAddress,
          playerName: profile ? normalizePlayerName(profile.name) : state.playerName,
          playerIsGuest: profile?.isGuest ?? state.playerIsGuest
        })
        if (instanceChanged || lastHelloInstance !== message.data.instanceId) sendHello(true)
        requestRoundCharadeIfNeeded()
        break
      }
      case 'progress': {
        if (!validRevision(message.data.revision) || message.data.revision < state.progressRevision) break
        const progress = progressFrom(message.data, state.progress)
        dispatch({ type: 'progress', progress, revision: message.data.revision })
        if (state.playerAddress) effects.showReward?.(state.playerAddress, progress.title)
        break
      }
      case 'playerTitle':
        if (STABLE_ADDRESS.test(message.data.address) && isPlayerTitle(message.data.title)) {
          effects.showReward?.(message.data.address, message.data.title)
        }
        break
      case 'pong': {
        const receivedAt = now()
        recordDiagnosticsPong(message.data.seq, receivedAt)
        dispatch({ type: 'pong', now: receivedAt })
        requestRoundCharadeIfNeeded()
        break
      }
      case 'charade': {
        if (!resolveRequest(message.data.requestId, 'nextCharade')) break
        if (
          message.data.emotes.length !== 3 ||
          message.data.answers.length !== 3 ||
          (message.data.answerIds !== undefined &&
            (message.data.answerIds.length !== 3 || !message.data.answerIds.every(isPhraseId)))
        ) {
          dispatch({ type: 'error', code: 'invalid_charade' })
          break
        }
        const [first, second, third] = message.data.emotes
        const [firstAnswer, secondAnswer, thirdAnswer] = message.data.answers
        const [firstAnswerId, secondAnswerId, thirdAnswerId] = message.data.answerIds ?? []
        const charade: DecodeCharade = {
          id: message.data.id,
          authorName: normalizePlayerName(message.data.authorName),
          authorAddress: message.data.authorAddress,
          look: sanitizeAvatarLook(message.data.look),
          createdAt: message.data.createdAt,
          isHouse: message.data.isHouse,
          ...(message.data.recipient ? { recipient: message.data.recipient } : {}),
          emotes: [first, second, third],
          answers: [firstAnswer, secondAnswer, thirdAnswer],
          ...(firstAnswerId && secondAnswerId && thirdAnswerId
            ? { answerIds: [firstAnswerId, secondAnswerId, thirdAnswerId] }
            : {}),
          authorTitle:
            typeof message.data.authorTitle === 'string' && isPlayerTitle(message.data.authorTitle)
              ? message.data.authorTitle
              : '',
          reply: pendingReplies.get(message.data.id) ?? null
        }
        pendingReplies.delete(message.data.id)
        if (state.roundCharadeId && state.roundCharadeId !== charade.id && !roundMismatchRefetchAttempted) {
          if (requestNextCharade()) {
            roundMismatchRefetchAttempted = true
            break
          }
        }
        recordDiagnosticsCharade(charade.recipient !== undefined)
        cancelReveal()
        dispatch({ type: 'charade', charade })
        if (charade.reply) {
          effects.showDuet?.({ look: charade.look, emotes: charade.emotes }, charade.reply)
        } else {
          effects.showPerformer?.(charade.look, charade.emotes)
        }
        effects.showStageReward?.(charade.authorAddress, charade.authorTitle)
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
          name: normalizePlayerName(message.data.name),
          look: sanitizeAvatarLook(message.data.look),
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
      case 'reveal': {
        if (
          state.charade?.id !== message.data.charadeId ||
          !resolveRequest(message.data.requestId, 'guess', 'roundGuess')
        ) {
          break
        }
        const revealedCharade = state.charade
        const freshProgress = validRevision(message.data.revision) && message.data.revision >= state.progressRevision
        const revealProgress = freshProgress ? progressFrom(message.data, state.progress) : state.progress
        const reveal: RevealResult = {
          ...message.data,
          ...revealProgress,
          revision: freshProgress ? message.data.revision : state.progressRevision,
          phraseId: message.data.phraseId ?? '',
          stampAwarded: message.data.stampAwarded === true,
          titleUnlocked: message.data.titleUnlocked === true
        }
        if (state.roundCharadeId === message.data.charadeId) roundMismatchRefetchAttempted = false
        recordDiagnosticsGuess()
        dispatch({ type: 'reveal', reveal })
        if (state.playerAddress) effects.showReward?.(state.playerAddress, reveal.title)
        if (revealedCharade?.id === message.data.charadeId) effects.resolveReveal?.(reveal, revealedCharade)
        break
      }
      case 'posted': {
        if (!resolveRequest(message.data.requestId, 'post')) break
        const freshProgress = validRevision(message.data.revision) && message.data.revision >= state.progressRevision
        const postedProgress = freshProgress ? progressFrom(message.data, state.progress) : state.progress
        const result = {
          charadeId: message.data.charadeId,
          replyTo: message.data.replyTo,
          recipient: message.data.recipient,
          ...postedProgress,
          revision: freshProgress ? message.data.revision : state.progressRevision,
          stampAwarded: message.data.stampAwarded === true,
          titleUnlocked: message.data.titleUnlocked === true
        }
        recordDiagnosticsPost(message.data.recipient !== undefined)
        dispatch({ type: 'posted', result })
        if (state.playerAddress) effects.showReward?.(state.playerAddress, result.title)
        break
      }
      case 'since': {
        if (!validRevision(message.data.revision) || message.data.revision < state.progressRevision) break
        const sinceProgress = progressFrom(message.data, state.progress)
        dispatch({
          type: 'since',
          summary: {
            ...message.data,
            replies: message.data.replies ?? 0,
            mail: message.data.mail ?? 0,
            revision: message.data.revision,
            ...sinceProgress
          }
        })
        if (state.playerAddress) effects.showReward?.(state.playerAddress, sinceProgress.title)
        break
      }
      case 'audience':
        dispatch({ type: 'audience', looks: message.data.looks.slice(0, AUDIENCE_SEATS).map(sanitizeAvatarLook) })
        break
      case 'boards': {
        const boards = sanitizeBoards({
          ...message.data,
          playbill: message.data.playbill ?? [],
          ghostOfNightId: message.data.ghostOfNightId ?? ''
        })
        if (state.ghostOfNight?.charadeId !== boards.ghostOfNightId) effects.showGhostOfNight?.(null)
        dispatch({ type: 'boards', boards })
        if (
          state.mailRecipient &&
          !mailRecipients(state).some(
            (candidate) => canonicalAddress(candidate.address) === canonicalAddress(state.mailRecipient!.address)
          )
        ) {
          dispatch({ type: 'mailRecipient', recipient: null })
        }
        break
      }
      case 'ghostOfNight':
        if (message.data.charadeId === state.boards.ghostOfNightId && isPlayerTitle(message.data.title)) {
          const ghost = {
            ...message.data,
            name: normalizePlayerName(message.data.name),
            look: sanitizeAvatarLook(message.data.look)
          }
          dispatch({ type: 'ghostOfNight', ghost })
          effects.showGhostOfNight?.(ghost)
        }
        break
      case 'roundStart': {
        const sequence = roundSequence(message.data.roundId)
        if (sequence === null || sequence <= state.latestRoundSequence) break
        if (state.roundCharadeId !== message.data.charadeId) roundMismatchRefetchAttempted = false
        dispatch({
          type: 'roundStart',
          roundId: message.data.roundId,
          charadeId: message.data.charadeId,
          sequence
        })
        requestRoundCharadeIfNeeded()
        break
      }
      case 'roundWinner': {
        if (message.data.roundId !== state.roundId || message.data.charadeId !== state.roundCharadeId) break
        roundMismatchRefetchAttempted = false
        const winnerName = normalizePlayerName(message.data.name)
        dispatch({
          type: 'roundWinner',
          roundId: message.data.roundId,
          charadeId: message.data.charadeId,
          address: message.data.address,
          name: winnerName,
          now: now()
        })
        const profile = options.getProfile?.()
        if (isCompleteProfile(profile) && profile.address.toLowerCase() === message.data.address.toLowerCase()) {
          beginAuthoring('reveal', true)
        }
        break
      }
      case 'react':
        if (isReactionKind(message.data.kind)) {
          dispatch({ type: 'reaction', kind: message.data.kind, from: message.from, now: now() })
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
        cancelReveal()
        requests.clear()
        dispatch({ type: 'error', code: message.data.code })
        if (message.data.code === 'protocol-required') {
          helloSent = false
          lastHelloInstance = ''
          sendHello(true)
        }
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

    if (transportReady && state.ready) sendHello()

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
      if (!state.ready) sendHello(true)
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
          if (stored.request.kind === 'guess' || stored.request.kind === 'roundGuess') cancelReveal()
          requests.delete(requestId)
          dispatch({ type: 'requestTimedOut', requestId })
        }
      }
    }

    if (state.toast && currentTime - state.toast.shownAt >= TOAST_MILLISECONDS) dispatch({ type: 'clearToast' })
  }

  function requestNextCharade() {
    if (
      !state.ready ||
      options.canDecode?.() === false ||
      state.pending.some((request) => request.kind === 'nextCharade')
    ) {
      return false
    }
    if (state.screen === 'reveal') {
      if (effects.canAdvanceReveal?.() === false) return false
      effects.skipReveal?.()
    }
    const requestId = createRequestId()
    sendRequest(
      'nextCharade',
      { type: 'nextCharade', data: { requestId, exclude: state.charade ? [state.charade.id] : [] } },
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

  function guess(answerIndex: number, revealOptions?: RevealRunOptions) {
    if (
      !state.ready ||
      !state.charade ||
      state.screen !== 'decode' ||
      options.canDecode?.() === false ||
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
    if (revealOptions) effects.beginReveal?.(state.charade, answerIndex, revealOptions)
    else effects.beginReveal?.(state.charade, answerIndex)
    return true
  }

  function beginAuthoring(
    returnScreen: ClientFlowState['authorReturnScreen'] = state.screen === 'reveal' ? 'reveal' : 'foyer',
    preservePendingGuess = false
  ) {
    if (
      !state.ready ||
      state.playerIsGuest ||
      (!preservePendingGuess &&
        state.pending.some((request) => request.kind === 'guess' || request.kind === 'roundGuess'))
    ) {
      return false
    }
    cancelReveal()
    effects.clearStageReward?.()
    const seed = createRequestId()
    const phrase = dealPhrase(DECK, state.dealtPhraseIds, seed)
    if (!phrase) {
      dispatch({ type: 'error', code: 'deck_exhausted' })
      return false
    }
    dispatch({
      type: 'author',
      returnScreen,
      draft: {
        phrase,
        offeredEmotes: offerEmotes(phrase, seed),
        selectedEmotes: [],
        shufflesRemaining: 2,
        phase: 'phrase'
      }
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
    cancelReveal()
    const seed = createRequestId()
    dispatch({
      type: 'author',
      returnScreen: 'reveal',
      draft: {
        phrase,
        offeredEmotes: offerEmotes(phrase, seed),
        selectedEmotes: [],
        shufflesRemaining: 0,
        phase: 'phrase',
        replyTo: charade.id
      }
    })
    return true
  }

  function selectGhostMailRecipient(recipientAddress: string) {
    if (!canSendMail(state)) return false
    const recipient = mailRecipients(state).find(
      (candidate) => canonicalAddress(candidate.address) === canonicalAddress(recipientAddress)
    )
    if (!recipient) return false
    dispatch({
      type: 'mailRecipient',
      recipient: { address: recipient.address, name: normalizePlayerName(recipient.name) }
    })
    return true
  }

  function beginGhostMail() {
    if (
      !canSendMail(state) ||
      !state.mailRecipient ||
      state.pending.some((request) => request.kind === 'guess' || request.kind === 'roundGuess')
    ) {
      return false
    }
    const recipient = mailRecipients(state).find(
      (candidate) => canonicalAddress(candidate.address) === canonicalAddress(state.mailRecipient!.address)
    )
    if (!recipient) return false
    cancelReveal()
    effects.clearStageReward?.()
    const seed = createRequestId()
    const phrase = dealPhrase(DECK, state.dealtPhraseIds, seed)
    if (!phrase) {
      dispatch({ type: 'error', code: 'deck_exhausted' })
      return false
    }
    dispatch({
      type: 'author',
      returnScreen: 'mail',
      draft: {
        phrase,
        offeredEmotes: offerEmotes(phrase, seed),
        selectedEmotes: [],
        shufflesRemaining: 2,
        phase: 'phrase',
        recipient: { address: recipient.address, name: normalizePlayerName(recipient.name) }
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
      returnScreen: state.authorReturnScreen,
      draft: {
        phrase,
        offeredEmotes: offerEmotes(phrase, seed),
        selectedEmotes: [],
        shufflesRemaining: state.author.shufflesRemaining - 1,
        phase: 'phrase',
        ...(state.author.recipient ? { recipient: state.author.recipient } : {})
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
          ...(state.author.replyTo ? { replyTo: state.author.replyTo } : {}),
          ...(state.author.recipient ? { recipient: state.author.recipient.address } : {})
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
    selectGhostMailRecipient,
    clearGhostMailRecipient() {
      dispatch({ type: 'mailRecipient', recipient: null })
    },
    beginGhostMail,
    canSendMail: () => canSendMail(state),
    canAnswerBack: () => canAnswerBack(state),
    shuffleAuthorPhrase,
    selectAuthorEmote,
    continueAuthoring() {
      if (!state.author || state.author.phase !== 'phrase') return false
      dispatch({ type: 'authorPhase', phase: 'emotes' })
      return true
    },
    reviseAuthorEmotes() {
      if (!state.author || state.author.phase !== 'confirm') return false
      dispatch({ type: 'authorPhase', phase: 'emotes' })
      return true
    },
    previewAuthor,
    postAuthor,
    backFromAuthor() {
      effects.clearPreview?.()
      dispatch({ type: 'authorBack' })
      if (state.screen === 'reveal' || state.screen === 'decode') restoreCharadePresentation()
    },
    dismissSince() {
      dispatch({ type: 'dismissSince' })
    },
    showFoyer() {
      if (state.screen === 'reveal') cancelReveal()
      dispatch({ type: 'show', screen: 'foyer' })
    },
    showBoards() {
      if (state.screen === 'reveal') cancelReveal()
      dispatch({ type: 'show', screen: 'boards' })
    },
    showInvite() {
      if (state.screen === 'reveal') cancelReveal()
      dispatch({ type: 'show', screen: 'invite' })
    },
    showMail() {
      if (!canSendMail(state)) return false
      dispatch({ type: 'mailRecipient', recipient: null })
      dispatch({ type: 'show', screen: 'mail' })
      return true
    },
    showSettings() {
      if (state.screen === 'reveal') cancelReveal()
      dispatch({ type: 'show', screen: 'settings' })
    },
    showHowToPlay() {
      if (state.screen === 'reveal') cancelReveal()
      dispatch({ type: 'show', screen: 'howToPlay' })
    },
    toggleReactionMenu() {
      dispatch({ type: 'toggleReactionMenu' })
    },
    showLocalReaction(kind: ReactionKind) {
      if (!isReactionKind(kind)) return false
      dispatch({ type: 'reaction', kind, from: state.playerAddress, now: now() })
      return true
    },
    setInviteStatus(status: ClientFlowState['inviteStatus']) {
      dispatch({ type: 'inviteStatus', status })
    },
    dismissNotice(id: string) {
      dispatch({ type: 'dismissNotice', id })
    },
    reportError(code: string, error?: unknown) {
      if (error !== undefined) console.error(`Ghostlight ${code}`, error)
      requests.clear()
      dispatch({ type: 'error', code })
    }
  }
}

function isReactionKind(kind: string): kind is ReactionKind {
  return SPECTATOR_REACTION_KINDS.some((candidate) => candidate === kind)
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
    if (!player?.userId.trim() || !player.avatar?.bodyShapeUrn) return null
    return { address: player.userId, name: normalizePlayerName(player.name), isGuest: player.isGuest }
  },
  getLook: () => {
    const player = getPlayer()
    if (!player?.userId.trim() || !player.avatar?.bodyShapeUrn) return null
    return sanitizeAvatarLook({
      address: player.userId,
      name: normalizePlayerName(player.name),
      isGuest: player.isGuest,
      bodyShape: player.avatar.bodyShapeUrn,
      skinColor: player.avatar.skinColor ?? { r: 0.6, g: 0.46, b: 0.36 },
      hairColor: player.avatar.hairColor ?? { r: 0.28, g: 0.14, b: 0 },
      eyeColor: player.avatar.eyesColor ?? { r: 0.3, g: 0.48, b: 0.62 },
      wearables: player.wearables
    })
  },
  isTransportReady: () => room.isReady(),
  canDecode: () => {
    const position = getPlayer()?.position
    return position !== undefined && isInDecodeArea(position)
  }
})

let started = false

export function startClientFlow() {
  if (started) return
  started = true

  room.onReady((ready) => clientFlow.dispatch({ type: 'transport', ready }))
  room.onMessage('ready', (data) => clientFlow.receive({ type: 'ready', data }))
  room.onMessage('pong', (data) => clientFlow.receive({ type: 'pong', data }))
  room.onMessage('progress', (data) =>
    clientFlow.receive({ type: 'progress', data: data as unknown as ProgressView & { revision: number } })
  )
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
        mail?: number
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
