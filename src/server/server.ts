import { AvatarBase, AvatarEquippedData, PlayerIdentityData, engine } from '@dcl/sdk/ecs'
import { onEnterScene, onLeaveScene } from '@dcl/sdk/src/players'
import {
  AUTHOR_COOLDOWN_SECONDS,
  EMOTE_STEP_SECONDS,
  PROTOCOL_VERSION,
  WIRE_INT_MAX,
  themeForTimestamp
} from '../shared/config'
import { DECK, EMOTE_VOCABULARY, isAllowedPerformance, isDecodablePerformance } from '../shared/deck'
import { normalizePlayerName } from '../shared/i18n'
import { Messages, SPECTATOR_REACTION_KINDS, room } from '../shared/messages'
import { chooseCharadeFor, chooseHouseCharade, chooseRetryBeat, pickDecoys, shuffleSeeded } from '../shared/pick'
import { showPolicyForTimestamp } from '../shared/show-policy'
import type { Charade, Look, PlayerProgress, PlayerStats, ShowSet } from '../shared/types'
import { SHOW_SET_SIZE, STORAGE_SCHEMA_VERSION } from '../shared/types'
import { LiveRounds } from './rounds'
import {
  DURABLE_MUTATION_JOURNAL_KEY,
  GhostlightState,
  dayKey,
  gameState,
  type DurableMutation,
  type DurableMutationFingerprint,
  type DurableStatsPatch
} from './state'
import { StorageCapacityError, StorageUnavailableError, flushNow, startFlushLoop } from './storage'

type HelloPayload = { displayName: string; isGuest: boolean; protocolVersion: number }
type PingPayload = { seq: number }
type NextCharadePayload = { requestId: string; exclude: string[] }
type GuessPayload = { charadeId: string; answerIndex: number; requestId: string; spotlight?: boolean }
type RoundGuessPayload = GuessPayload & { roundId: string }
type PostPayload = {
  phraseId: string
  emotes: string[]
  requestId: string
  touringConsent: boolean
  replyTo?: string
  recipient?: string
}
type PostPayloadInput = Omit<PostPayload, 'touringConsent'> & { touringConsent?: unknown }
type ReactPayload = { kind: string }

type RevealPayload = {
  requestId: string
  charadeId: string
  correct: boolean
  phraseId: string
  phrase: string
  stats: { total: number; correct: number }
  yourScore: number
  daily: ReturnType<GhostlightState['getDaily']>
  revision: number
  stampAwarded: boolean
  attempt: 1 | 2
  title: PlayerProgress['title']
  nextUnlock: PlayerProgress['nextUnlock']
  titleUnlocked: boolean
  spotlight: boolean
  scoreDelta: number
  setRound: number
  setSize: number
  setScore: number
  setStreak: number
  setBestStreak: number
  setUnderstood: number
  setComplete: boolean
  isFinale: boolean
}

type RetryPayload = {
  requestId: string
  charadeId: string
  removedAnswerIndex: number
  replayBeatIndex: number
}

type PostedPayload = {
  requestId: string
  charadeId: string
  replyTo?: string
  recipient?: string
  daily: ReturnType<GhostlightState['getDaily']>
  revision: number
  stampAwarded: boolean
  title: PlayerProgress['title']
  nextUnlock: PlayerProgress['nextUnlock']
  titleUnlocked: boolean
}

type AuthoredPost = {
  phraseId: string
  emotes: string[]
  touringConsent: boolean
  replyTo?: string
  recipient?: string
}

type GuessFingerprint = Extract<DurableMutationFingerprint, { kind: 'guess' }>

type CompletedRequest =
  | { type: 'retry'; data: RetryPayload; durable: boolean; fingerprint: GuessFingerprint }
  | { type: 'reveal'; data: RevealPayload; durable: boolean; fingerprint: GuessFingerprint; mutationId?: string }
  | { type: 'posted'; data: PostedPayload; durable: boolean; authoredPost: AuthoredPost; mutationId?: string }

type PreparedCharade = {
  charade: Charade
  showKey: string
  publicId: string
  answers: string[]
  answerIds: string[]
  correctIndex: number
}

type ServedCharade = {
  prepared: PreparedCharade
  firstGuessEligibleAt: number | null
  retry: {
    requestId: string
    removedAnswerIndex: number
    replayBeatIndex: number
    spotlight: boolean
    fingerprint: GuessFingerprint
    response: RetryPayload
  } | null
}

type CachedRequest<T> = {
  owner: string
  expiresAt: number
  value: T
}

type RateBucket = {
  tokens: number
  updatedAt: number
}

export type ProtocolSend = (type: string, data: unknown, to?: string[]) => void | Promise<void>

export type ServerProtocolOptions = {
  state: GhostlightState
  send: ProtocolSend
  snapshotLook: (address: string) => Look | null | Promise<Look | null>
  ready?: Promise<void>
  flush?: () => Promise<unknown>
  now?: () => number
  instanceId?: string
  lookAttempts?: number
  lookRetryMilliseconds?: number
  random?: () => number
  roundDurationMilliseconds?: number
  firstGuessDelayMilliseconds?: number
}

const VALID_REACTION_KINDS = new Set<string>(SPECTATOR_REACTION_KINDS)
const REACTION_COOLDOWN_MILLISECONDS = 1_000
const EMOTES = new Set<string>(EMOTE_VOCABULARY)
const MAX_WEARABLE_URNS = 20
const MAX_WIRE_ADDRESS_BYTES = 48
const MAX_WIRE_ID_BYTES = 64
const MAX_WIRE_URN_BYTES = 512
const MAX_WIRE_LOOK_BYTES = 2_800
const MAX_APPLICATION_MESSAGE_BYTES = 4_000
const MAX_EXCLUDE_IDS = 20
const REQUEST_CACHE_TTL_MILLISECONDS = 15_000
const MAX_CACHED_REQUESTS_PER_PLAYER = 32
const MAX_CACHED_REQUESTS = 1_024
const MAX_OUTSTANDING_REQUESTS_PER_PLAYER = 4
const REQUEST_TOKEN_CAPACITY = 16
const REQUEST_TOKENS_PER_SECOND = 8
const DEFAULT_BODY_SHAPE = 'urn:decentraland:off-chain:base-avatars:BaseMale'
const STABLE_ADDRESS = /^0x[a-f0-9]{40}$/iu
const ROUND_ID = /^[1-9][0-9]*$/u
const NO_PHRASE_IDS: ReadonlySet<string> = new Set()

function emptyShowSet(showKey: string): ShowSet {
  return { showKey, round: 0, score: 0, streak: 0, bestStreak: 0, understood: 0 }
}

function showSetFor(stats: PlayerStats, showKey: string) {
  if (stats.showSet?.showKey !== showKey) stats.showSet = emptyShowSet(showKey)
  return stats.showSet
}

function activeShowForTimestamp(timestamp: number) {
  const policy = showPolicyForTimestamp(timestamp)
  if (!policy) return null
  const primaryPhraseIds: ReadonlySet<string> = new Set(policy.primaryPhraseIds)
  const decoyPhraseIds: ReadonlySet<string> = new Set(policy.decoyPhraseIds)
  const housePhraseIds: ReadonlySet<string> = new Set(policy.housePhraseIds)
  return {
    policy,
    primaryPhraseIds,
    housePhraseIds,
    decoyDeck: DECK.filter((phrase) => decoyPhraseIds.has(phrase.id))
  }
}

type ActiveShow = NonNullable<ReturnType<typeof activeShowForTimestamp>>

function canonicalAddress(address: string) {
  return address.toLowerCase()
}

function utf8Bytes(value: string) {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

function encodedBytes(value: unknown) {
  return utf8Bytes(JSON.stringify(value))
}

function encodedStringBytes(value: string) {
  return encodedBytes(value) - 2
}

function validWireString(value: string, maxBytes = MAX_WIRE_ID_BYTES) {
  return value.length > 0 && encodedStringBytes(value) <= maxBytes
}

function validApplicationPayload(value: unknown) {
  return encodedBytes(value) < MAX_APPLICATION_MESSAGE_BYTES
}

function limitText(value: string, maxBytes: number) {
  if (encodedStringBytes(value) <= maxBytes) return value
  const kept: string[] = []
  let bytes = 0
  for (const character of value) {
    const characterBytes = encodedStringBytes(character)
    if (bytes + characterBytes > maxBytes) break
    kept.push(character)
    bytes += characterBytes
  }
  return kept.join('')
}

function withoutLastSeen(look: Look): Look {
  const bodyShape = encodedStringBytes(look.bodyShape) <= MAX_WIRE_URN_BYTES ? look.bodyShape : DEFAULT_BODY_SHAPE
  const bounded: Look = {
    address: limitText(look.address, MAX_WIRE_ADDRESS_BYTES),
    name: normalizePlayerName(look.name),
    isGuest: look.isGuest,
    bodyShape,
    skinColor: look.skinColor,
    hairColor: look.hairColor,
    eyeColor: look.eyeColor,
    wearables: look.wearables
      .filter((wearable) => encodedStringBytes(wearable) <= MAX_WIRE_URN_BYTES)
      .slice(0, MAX_WEARABLE_URNS)
  }
  while (bounded.wearables.length > 0 && encodedBytes(bounded) > MAX_WIRE_LOOK_BYTES) bounded.wearables.pop()
  return bounded
}

function hashText(value: string, salt: number) {
  let hash = (2166136261 ^ salt) >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function charadeId(address: string, requestId: string) {
  const source = `${canonicalAddress(address)}:${requestId}`
  return `ghost-${hashText(source, 0)}${hashText(source, 0x9e3779b9)}`
}

function snapshotAuthoredPost(data: PostPayload): AuthoredPost {
  return {
    phraseId: data.phraseId,
    emotes: [...data.emotes],
    touringConsent: data.touringConsent,
    ...(data.replyTo === undefined ? {} : { replyTo: data.replyTo }),
    ...(data.recipient === undefined ? {} : { recipient: canonicalAddress(data.recipient) })
  }
}

function sameAuthoredPost(left: AuthoredPost, right: AuthoredPost) {
  return (
    left.phraseId === right.phraseId &&
    left.emotes.length === right.emotes.length &&
    left.emotes.every((emote, index) => emote === right.emotes[index]) &&
    left.touringConsent === right.touringConsent &&
    left.replyTo === right.replyTo &&
    left.recipient === right.recipient
  )
}

function cloneStats(stats: PlayerStats): PlayerStats {
  return {
    ...stats,
    seen: [...stats.seen],
    authored: [...stats.authored],
    pending: { ...stats.pending },
    daily: { ...stats.daily },
    stampedDays: [...stats.stampedDays],
    ...(stats.showSet ? { showSet: { ...stats.showSet } } : {})
  }
}

function durableStatsPatch(
  address: string,
  persistent: boolean,
  before: PlayerStats,
  after: PlayerStats
): DurableStatsPatch {
  const seenAdd = after.seen.find((id) => !before.seen.includes(id))
  const authoredAdd = after.authored.find((id) => !before.authored.includes(id))
  const stampedDayAdd = after.stampedDays.find((day) => !before.stampedDays.includes(day))
  return {
    address: canonicalAddress(address),
    persistent,
    ...(seenAdd ? { seenAdd } : {}),
    ...(authoredAdd ? { authoredAdd } : {}),
    ...(stampedDayAdd ? { stampedDayAdd } : {}),
    after: {
      name: after.name,
      decoded: after.decoded,
      correct: after.correct,
      authoredCount: after.authoredCount,
      lastSeenAt: after.lastSeenAt,
      pending: { ...after.pending },
      daily: { ...after.daily },
      revision: after.revision,
      title: after.title,
      ...(after.showSet ? { showSet: { ...after.showSet } } : {})
    }
  }
}

function guessFingerprint(data: GuessPayload, roundId: string | null): GuessFingerprint {
  return {
    kind: 'guess',
    charadeId: data.charadeId,
    answerIndex: data.answerIndex,
    spotlight: data.spotlight === true,
    roundId
  }
}

function postFingerprint(post: AuthoredPost): DurableMutationFingerprint {
  return {
    kind: 'post',
    phraseId: post.phraseId,
    emotes: [post.emotes[0], post.emotes[1], post.emotes[2]],
    touringConsent: post.touringConsent,
    ...(post.replyTo === undefined ? {} : { replyTo: post.replyTo }),
    ...(post.recipient === undefined ? {} : { recipient: post.recipient })
  }
}

function sameDurableFingerprint(left: DurableMutationFingerprint, right: DurableMutationFingerprint) {
  if (left.kind !== right.kind) return false
  if (left.kind === 'guess' && right.kind === 'guess') {
    return (
      left.charadeId === right.charadeId &&
      left.answerIndex === right.answerIndex &&
      left.spotlight === right.spotlight &&
      left.roundId === right.roundId
    )
  }
  if (left.kind !== 'post' || right.kind !== 'post') return false
  return (
    left.phraseId === right.phraseId &&
    left.emotes.every((emote, index) => emote === right.emotes[index]) &&
    left.touringConsent === right.touringConsent &&
    left.replyTo === right.replyTo &&
    left.recipient === right.recipient
  )
}

function storedCharadeMatchesPost(charade: Charade, author: string, post: AuthoredPost) {
  return (
    post.replyTo === undefined &&
    canonicalAddress(charade.author.address) === author &&
    charade.phraseId === post.phraseId &&
    charade.emotes.length === post.emotes.length &&
    charade.emotes.every((emote, index) => emote === post.emotes[index]) &&
    charade.touringConsent === post.touringConsent &&
    (charade.recipient === undefined ? undefined : canonicalAddress(charade.recipient)) === post.recipient
  )
}

function findStoredReplyRequest(state: GhostlightState, replier: string, requestId: string) {
  return (
    state
      .getPlayerCharades()
      .find(
        (charade) => charade.reply?.requestId === requestId && canonicalAddress(charade.reply.address) === replier
      ) ?? null
  )
}

function storedReplyMatchesPost(charade: Charade, replier: string, requestId: string, post: AuthoredPost) {
  const reply = charade.reply
  return (
    reply !== undefined &&
    reply.requestId === requestId &&
    reply.requestId.length <= MAX_WIRE_ID_BYTES &&
    canonicalAddress(reply.address) === replier &&
    post.replyTo === charade.id &&
    post.recipient === undefined &&
    post.touringConsent === false &&
    post.phraseId === charade.phraseId &&
    reply.emotes.length === post.emotes.length &&
    reply.emotes.every((emote, index) => emote === post.emotes[index])
  )
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

export function snapshotServerLook(address: string): Look | null {
  const wanted = canonicalAddress(address)
  for (const [, identity, avatar, equipped] of engine.getEntitiesWith(
    PlayerIdentityData,
    AvatarBase,
    AvatarEquippedData
  )) {
    if (canonicalAddress(identity.address) !== wanted) continue
    return {
      address: identity.address,
      name: avatar.name || 'Guest',
      isGuest: identity.isGuest,
      bodyShape: avatar.bodyShapeUrn || 'urn:decentraland:off-chain:base-avatars:BaseMale',
      skinColor: avatar.skinColor ?? { r: 0.6, g: 0.46, b: 0.36 },
      hairColor: avatar.hairColor ?? { r: 0.28, g: 0.14, b: 0.08 },
      eyeColor: avatar.eyesColor ?? { r: 0.3, g: 0.48, b: 0.62 },
      wearables: equipped.wearableUrns.slice(0, MAX_WEARABLE_URNS)
    }
  }
  return null
}

export function createServerProtocol(options: ServerProtocolOptions) {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const firstGuessDelayMilliseconds = options.firstGuessDelayMilliseconds ?? EMOTE_STEP_SECONDS * 3 * 1_000
  const ready = options.ready ?? Promise.resolve()
  const checkpoint = options.flush ?? (async () => {})
  const initialTimestamp = now()
  const instanceId = options.instanceId ?? String(initialTimestamp)
  const looks = new Map<string, Look>()
  const present = new Set<string>()
  const sessionGenerations = new Map<string, number>()
  let nextSessionGeneration = 0
  const welcomed = new Set<string>()
  const negotiated = new Set<string>()
  const welcomePromises = new Map<string, Promise<boolean>>()
  const pendingWelcomeLooks = new Map<string, { generation: number; look: Look }>()
  const cancelledWelcomePromises = new WeakSet<Promise<boolean>>()
  const servedAnswers = new Map<string, ServedCharade>()
  const activeDecoders = new Set<string>()
  const lastAuthors = new Map<string, string>()
  const lastPosts = new Map<string, number>()
  const lastReactions = new Map<string, number>()
  const completedRequests = new Map<string, CachedRequest<CompletedRequest>>()
  const nextRequests = new Map<string, CachedRequest<Promise<PreparedCharade | null>>>()
  const activeRequestHandlers = new Map<string, Promise<void>>()
  const outstandingRequests = new Map<string, number>()
  const requestBuckets = new Map<string, RateBucket>()
  let currentDay = dayKey(initialTimestamp)
  let currentShow = activeShowForTimestamp(initialTimestamp)
  const rounds = new LiveRounds(
    (type, data) =>
      options.send(type, {
        ...(data as Record<string, unknown>),
        instanceId,
        showKey: currentShow?.policy.showKey ?? ''
      }),
    now,
    options.roundDurationMilliseconds
  )
  let rolloverPromise: Promise<Set<string>> | null = null
  let houseSequence = 0
  let answerSequence = 0
  const serverSecret = `${initialTimestamp}:${random()}:${random()}`
  let activeRoundCharade: PreparedCharade | null = null
  let mutationQueue = Promise.resolve()
  let queuedMutations = 0
  const pendingLeavePersistence = new Map<string, { generation: number; look: Look }>()
  const activeLeavePersistence = new Map<string, Promise<void>>()

  function sessionGeneration(address: string) {
    const key = canonicalAddress(address)
    return present.has(key) ? (sessionGenerations.get(key) ?? null) : null
  }

  function isCurrentSession(address: string, generation: number) {
    const key = canonicalAddress(address)
    return present.has(key) && sessionGenerations.get(key) === generation
  }

  function pruneCache<T>(cache: Map<string, CachedRequest<T>>) {
    const timestamp = now()
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= timestamp) cache.delete(key)
    }
  }

  function cacheGet<T>(cache: Map<string, CachedRequest<T>>, key: string) {
    const entry = cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now()) {
      cache.delete(key)
      return null
    }
    cache.delete(key)
    cache.set(key, entry)
    return entry.value
  }

  function cacheSet<T>(cache: Map<string, CachedRequest<T>>, key: string, owner: string, value: T) {
    pruneCache(cache)
    cache.delete(key)
    cache.set(key, { owner, expiresAt: now() + REQUEST_CACHE_TTL_MILLISECONDS, value })
    while ([...cache.values()].filter((entry) => entry.owner === owner).length > MAX_CACHED_REQUESTS_PER_PLAYER) {
      const oldest = [...cache].find(([, entry]) => entry.owner === owner)
      if (!oldest) break
      cache.delete(oldest[0])
    }
    while (cache.size > MAX_CACHED_REQUESTS) cache.delete(cache.keys().next().value!)
  }

  function takeRequestToken(address: string) {
    const timestamp = now()
    const bucketKey = canonicalAddress(address)
    const current = requestBuckets.get(bucketKey) ?? { tokens: REQUEST_TOKEN_CAPACITY, updatedAt: timestamp }
    const elapsed = Math.max(0, timestamp - current.updatedAt)
    const tokens = Math.min(REQUEST_TOKEN_CAPACITY, current.tokens + (elapsed * REQUEST_TOKENS_PER_SECOND) / 1_000)
    if (tokens < 1) {
      requestBuckets.set(bucketKey, { tokens, updatedAt: timestamp })
      return false
    }
    requestBuckets.set(bucketKey, { tokens: tokens - 1, updatedAt: timestamp })
    return true
  }

  async function sendTo(address: string, type: string, data: unknown) {
    await options.send(type, data, [address])
  }

  async function sendError(address: string, code: string, requestId?: string) {
    await sendTo(address, requestId ? 'requestError' : 'error', requestId ? { code, requestId } : { code })
  }

  async function checkpointOrError(address: string, generation: number, requestId?: string, mutationId?: string) {
    try {
      await checkpoint()
      if (mutationId) await options.state.completeDurableMutation(mutationId)
      options.state.evictInactiveStats(new Set(looks.keys()))
      return true
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] checkpoint failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable', requestId)
      return false
    }
  }

  async function requireNegotiated(address: string) {
    const key = canonicalAddress(address)
    if (present.has(key) && negotiated.has(key)) return true
    await sendError(address, 'protocol-required')
    return false
  }

  async function serializeRequest(key: string, run: () => Promise<void>) {
    const active = activeRequestHandlers.get(key)
    const owner = active ? active.catch(() => {}).then(run) : run()
    activeRequestHandlers.set(key, owner)
    try {
      await owner
    } finally {
      if (activeRequestHandlers.get(key) === owner) activeRequestHandlers.delete(key)
    }
  }

  async function serializeMutation<T>(run: () => Promise<T>) {
    queuedMutations += 1
    const previous = mutationQueue
    let release = () => {}
    mutationQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => {})
    try {
      return await run()
    } finally {
      queuedMutations -= 1
      release()
    }
  }

  async function checkpointCachedMutation(address: string, generation: number, requestId: string, mutationId?: string) {
    if (!mutationId) return checkpointOrError(address, generation, requestId)
    return serializeMutation(() => checkpointOrError(address, generation, requestId, mutationId))
  }

  function settleRecoveredGuess(mutation: DurableMutation) {
    if (mutation.fingerprint.kind !== 'guess' || mutation.response.type !== 'reveal') return
    const owner = mutation.owner
    const fingerprint = mutation.fingerprint
    const reveal = mutation.response.data as RevealPayload
    let recoveredIsHouse: boolean | undefined
    for (const [servedKey, served] of servedAnswers) {
      if (servedKey.startsWith(`${owner}:`) && served.prepared.publicId === fingerprint.charadeId) {
        recoveredIsHouse = served.prepared.charade.isHouse
        servedAnswers.delete(servedKey)
      }
    }
    for (const [requestKey, entry] of nextRequests) {
      if (entry.owner === owner) nextRequests.delete(requestKey)
    }
    activeDecoders.delete(owner)
    const currentRound = rounds.current
    const recoveredCharade = options.state.getCharade(fingerprint.charadeId)
    const isHouse = recoveredIsHouse ?? recoveredCharade?.isHouse
    if (
      fingerprint.roundId !== null &&
      currentRound?.roundId === fingerprint.roundId &&
      currentRound.charadeId === fingerprint.charadeId
    ) {
      rounds.guess(
        owner,
        fingerprint.roundId,
        fingerprint.charadeId,
        isHouse === false && reveal.correct && reveal.attempt === 1
      )
    }
    cacheSet(completedRequests, mutation.id, owner, {
      type: 'reveal',
      data: reveal,
      durable: true,
      fingerprint
    })
  }

  async function reconcileActiveDurableMutation() {
    const active = options.state.getActiveDurableMutation()
    if (!active) return null
    const recovered = await options.state.recoverDurableMutation(active.id)
    if (recovered) settleRecoveredGuess(recovered)
    return recovered
  }

  async function reconcileActiveDurableMutationOrError(address: string, generation: number, requestId: string) {
    try {
      await reconcileActiveDurableMutation()
      return true
    } catch (error) {
      if (!(error instanceof StorageUnavailableError || error instanceof StorageCapacityError)) {
        console.error('[storage] durable reconciliation failed', error)
      }
      if (isCurrentSession(address, generation)) {
        await sendError(
          address,
          error instanceof StorageCapacityError ? 'server-busy' : 'storage-unavailable',
          requestId
        )
      }
      return false
    }
  }

  function scheduleLeavePersistence(key: string) {
    const active = activeLeavePersistence.get(key)
    if (active) return active
    let processed: { generation: number; look: Look } | undefined
    const persistence = serializeMutation(async () => {
      processed = pendingLeavePersistence.get(key)
      if (!processed) return
      pendingLeavePersistence.delete(key)
      await reconcileActiveDurableMutation()
      options.state.touchVisitor(processed.look)
      options.state.saveStats(key, !processed.look.isGuest)
      await checkpoint()
    })
      .catch((error) => {
        console.error('[storage] leave persistence failed', error)
      })
      .finally(() => {
        activeLeavePersistence.delete(key)
        if (!present.has(key) && processed && sessionGenerations.get(key) === processed.generation) {
          sessionGenerations.delete(key)
        }
        if (pendingLeavePersistence.has(key)) {
          void scheduleLeavePersistence(key)
        } else if (!present.has(key)) {
          options.state.evictStats(key)
        }
      })
    activeLeavePersistence.set(key, persistence)
    return persistence
  }

  async function recoverActiveRequest(
    address: string,
    generation: number,
    requestId: string,
    mutation: DurableMutation
  ) {
    return serializeMutation(async () => {
      try {
        const active = options.state.getActiveDurableMutation(mutation.id)
        if (active) {
          const recovered = await options.state.recoverDurableMutation(active.id)
          if (recovered) settleRecoveredGuess(recovered)
        } else if (!options.state.getDurableCompletion(mutation.owner, mutation.fingerprint.kind, mutation.requestId)) {
          throw new StorageUnavailableError([`scene:${DURABLE_MUTATION_JOURNAL_KEY}`])
        }
        options.state.evictInactiveStats(new Set(looks.keys()))
        return true
      } catch (error) {
        if (!(error instanceof StorageUnavailableError || error instanceof StorageCapacityError)) {
          console.error('[storage] durable recovery failed', error)
        }
        if (isCurrentSession(address, generation)) {
          await sendError(
            address,
            error instanceof StorageCapacityError ? 'server-busy' : 'storage-unavailable',
            requestId
          )
        }
        return false
      }
    })
  }

  async function withRequestAdmission(address: string, kind: string, data: unknown, run: () => Promise<void>) {
    const key = canonicalAddress(address)
    const outstandingKey = `${key}:${sessionGenerations.get(key) ?? 0}`
    if (!takeRequestToken(address)) return
    if (!validApplicationPayload(data)) {
      await sendError(address, `invalid-${kind}`)
      return
    }
    const outstanding = outstandingRequests.get(outstandingKey) ?? 0
    if (outstanding >= MAX_OUTSTANDING_REQUESTS_PER_PLAYER) return
    outstandingRequests.set(outstandingKey, outstanding + 1)
    try {
      await ready
      await run()
    } finally {
      const remaining = (outstandingRequests.get(outstandingKey) ?? 1) - 1
      if (remaining > 0) outstandingRequests.set(outstandingKey, remaining)
      else outstandingRequests.delete(outstandingKey)
    }
  }

  async function waitForLook(address: string) {
    const attempts = options.lookAttempts ?? 20
    const retryMilliseconds = options.lookRetryMilliseconds ?? 100
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const look = await options.snapshotLook(address)
      if (look) return withoutLastSeen(look)
      if (attempt + 1 < attempts && retryMilliseconds > 0) await sleep(retryMilliseconds)
    }
    return null
  }

  function playerName(address: string) {
    return looks.get(canonicalAddress(address))?.name ?? 'Visitor'
  }

  async function sendAudience(address: string, generation: number, visitors = options.state.recentVisitors) {
    const wanted = canonicalAddress(address)
    const audience = visitors
      .filter((visitor) => canonicalAddress(visitor.address) !== wanted)
      .slice(0, 6)
      .map(withoutLastSeen)

    if (audience.length === 0) {
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'audience', { looks: [] })
      return
    }
    for (const look of audience) {
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'audience', { looks: [look] })
    }
  }

  async function buildBoardsMessages() {
    const [playbill, ghostOfNight] = await Promise.all([
      options.state.getRecentPerformers(),
      options.state.getGhostOfNight()
    ])
    const topDecoders = options.state.boards.decoders.map((entry) => ({
      ...entry,
      address: limitText(entry.address, MAX_WIRE_ADDRESS_BYTES),
      name: normalizePlayerName(entry.name)
    }))
    const hardestGhosts = options.state.boards.hardest.map((entry) => ({
      ...entry,
      charadeId: limitText(entry.charadeId, MAX_WIRE_ID_BYTES),
      authorName: normalizePlayerName(entry.authorName)
    }))
    const wirePlaybill = playbill.map((entry) => ({
      ...entry,
      address: limitText(entry.address, MAX_WIRE_ADDRESS_BYTES),
      name: normalizePlayerName(entry.name)
    }))
    const boardsPayload = {
      topDecoders,
      hardestGhosts,
      playbill: wirePlaybill,
      ghostOfNightId: limitText(ghostOfNight?.charade.id ?? '', MAX_WIRE_ID_BYTES)
    }
    while (encodedBytes(boardsPayload) >= 4_000) {
      if (boardsPayload.hardestGhosts.length > 0) boardsPayload.hardestGhosts.pop()
      else if (boardsPayload.topDecoders.length > 0) boardsPayload.topDecoders.pop()
      else if (boardsPayload.playbill.length > 0) boardsPayload.playbill.pop()
      else break
    }
    const ghostOfNightPayload = ghostOfNight
      ? (() => {
          const ghostLook = withoutLastSeen(ghostOfNight.charade.author)
          return {
            charadeId: limitText(ghostOfNight.charade.id, MAX_WIRE_ID_BYTES),
            address: ghostLook.address,
            name: ghostLook.name,
            title: ghostOfNight.title,
            look: ghostLook,
            total: ghostOfNight.charade.guesses.total,
            correct: ghostOfNight.charade.guesses.correct
          }
        })()
      : null
    return { boardsPayload, ghostOfNightPayload }
  }

  async function sendBoards(address: string, generation: number) {
    const messages = await buildBoardsMessages()
    if (!isCurrentSession(address, generation)) return
    await sendTo(address, 'boards', messages.boardsPayload)
    if (messages.ghostOfNightPayload && isCurrentSession(address, generation)) {
      await sendTo(address, 'ghostOfNight', messages.ghostOfNightPayload)
    }
  }

  async function refreshBoards() {
    const recipients = [...looks.values()].map((look) => look.address)
    if (recipients.length === 0) return
    const messages = await buildBoardsMessages()
    await options.send('boards', messages.boardsPayload, recipients)
    if (messages.ghostOfNightPayload) await options.send('ghostOfNight', messages.ghostOfNightPayload, recipients)
  }

  async function rolloverIfNeeded(timestamp = now()) {
    if (rolloverPromise) {
      const announced = new Set(await rolloverPromise)
      const laterAnnouncements = await rolloverIfNeeded(timestamp)
      for (const address of laterAnnouncements) announced.add(address)
      return announced
    }
    const nextDay = dayKey(timestamp)
    if (nextDay <= currentDay) return new Set<string>()
    const nextShow = activeShowForTimestamp(timestamp)
    const showChanged = nextShow?.policy.showKey !== currentShow?.policy.showKey
    rolloverPromise = (async () => {
      const sessions = [...looks].map(([address, look]) => ({ address, look, generation: sessionGeneration(address) }))
      const scheduleSessions = [...negotiated].map((address) => ({
        address: looks.get(address)?.address ?? address,
        generation: sessionGeneration(address)
      }))
      const refreshed: Array<{
        address: string
        look: Look
        generation: number
        stats: Awaited<ReturnType<GhostlightState['getOrCreateStats']>>
      }> = []
      for (const { address, look, generation } of sessions) {
        if (generation === null) continue
        const stats = await options.state.getOrCreateStats(address, look.name, !look.isGuest)
        refreshed.push({ address, look, generation, stats })
      }
      await serializeMutation(async () => {
        await reconcileActiveDurableMutation()
        if (nextDay !== currentDay) options.state.rollover(timestamp)
        if (showChanged) {
          servedAnswers.clear()
          nextRequests.clear()
          activeDecoders.clear()
          activeRoundCharade = null
          rounds.reset()
          for (const [requestKey, entry] of completedRequests) {
            if (entry.value.type === 'retry') completedRequests.delete(requestKey)
          }
        }
        await checkpoint()
        for (const { address, look, generation, stats } of refreshed) {
          if (generation === null || !isCurrentSession(address, generation)) continue
          if (nextShow) {
            const previousShowSet = stats.showSet
            showSetFor(stats, nextShow.policy.showKey)
            if (stats.showSet !== previousShowSet) options.state.saveStats(address, !look.isGuest)
          }
        }
        if (showChanged) await checkpoint()
        currentDay = nextDay
        currentShow = nextShow
      })
      const announced = new Set<string>()
      for (const { address, generation } of scheduleSessions) {
        if (
          generation === null ||
          !isCurrentSession(address, generation) ||
          !negotiated.has(canonicalAddress(address))
        ) {
          continue
        }
        await sendTo(address, 'ready', readyPayload(timestamp))
        if (!isCurrentSession(address, generation) || !negotiated.has(canonicalAddress(address))) continue
        await sendTo(address, 'showSchedule', showSchedulePayload(timestamp))
        announced.add(canonicalAddress(address))
      }
      for (const { address, look, generation, stats } of refreshed) {
        if (!isCurrentSession(address, generation)) continue
        const daily = { ...options.state.getDaily(stats) }
        await sendTo(look.address, 'progress', {
          daily,
          revision: stats.revision,
          ...progressFor(stats)
        })
        if (!isCurrentSession(address, generation)) continue
        await sendBoards(look.address, generation)
      }
      return announced
    })().finally(() => {
      rolloverPromise = null
    })
    return rolloverPromise
  }

  async function rolloverOrError(address: string, generation: number, timestamp?: number, requestId?: string) {
    try {
      return { announced: await rolloverIfNeeded(timestamp) }
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] rollover failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable', requestId)
      return null
    }
  }

  async function requireCurrentPrimary(
    address: string,
    generation: number,
    showKey: string,
    phraseId: string,
    errorCode: string,
    requestId: string
  ) {
    if (!(await rolloverOrError(address, generation, undefined, requestId))) return false
    if (!isCurrentSession(address, generation)) return false
    if (currentShow?.policy.showKey !== showKey || !currentShow.primaryPhraseIds.has(phraseId)) {
      await sendError(address, errorCode, requestId)
      return false
    }
    return true
  }

  function progressFor(stats: Awaited<ReturnType<GhostlightState['getOrCreateStats']>>) {
    const progress = options.state.getPlayerProgress(stats)
    return { title: progress.title, nextUnlock: { ...progress.nextUnlock } }
  }

  async function sendVisibleTitles(address: string, generation: number) {
    const key = canonicalAddress(address)
    for (const [visibleAddress, look] of looks) {
      if (look.isGuest) continue
      const stats = options.state.playerStats.get(visibleAddress)
      if (!stats) continue
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'playerTitle', { address: look.address, title: progressFor(stats).title })
    }
    const ownStats = options.state.playerStats.get(key)
    if (!ownStats || looks.get(key)?.isGuest) return
    const recipients = [...looks.entries()]
      .filter(([visibleAddress]) => visibleAddress !== key)
      .map(([, look]) => look.address)
    if (recipients.length > 0 && isCurrentSession(address, generation)) {
      await options.send('playerTitle', { address, title: progressFor(ownStats).title }, recipients)
    }
  }

  async function broadcastTitleUnlock(address: string, title: PlayerProgress['title']) {
    if (looks.get(canonicalAddress(address))?.isGuest) return
    const recipients = [...looks.values()].map((look) => look.address)
    if (recipients.length > 0) await options.send('playerTitle', { address, title }, recipients)
  }

  function readyPayload(timestamp = now()) {
    const theme = themeForTimestamp(timestamp)
    return { instanceId, serverTime: timestamp, theme: theme.id, themeLabel: theme.label }
  }

  function showSchedulePayload(timestamp: number) {
    if (!currentShow) return { instanceId, serverTime: timestamp, showKey: '' }
    return {
      instanceId,
      serverTime: timestamp,
      showKey: currentShow.policy.showKey,
      ...(currentShow.policy.kind === 'season-zero' ? { season: currentShow.policy.season } : {})
    }
  }

  function selectRoundCharade(show: ActiveShow) {
    const presentAddresses = new Set([...looks.keys()])
    const seen = new Set<string>()
    for (const address of presentAddresses) {
      for (const charadeId of options.state.playerStats.get(address)?.seen ?? []) seen.add(charadeId)
    }
    const previous = activeRoundCharade?.charade.id
    const theme = show.policy.legacyTheme.id
    let selected: Charade | null = null
    for (const charade of options.state.getPool()) {
      if (
        !show.primaryPhraseIds.has(charade.phraseId) ||
        presentAddresses.has(canonicalAddress(charade.author.address)) ||
        charade.id === previous ||
        seen.has(charade.id)
      ) {
        continue
      }
      if (!selected) {
        selected = charade
        continue
      }
      const selectedPreferred = DECK.find((phrase) => phrase.id === selected!.phraseId)?.theme === theme ? 0 : 1
      const candidatePreferred = DECK.find((phrase) => phrase.id === charade.phraseId)?.theme === theme ? 0 : 1
      if (
        candidatePreferred - selectedPreferred ||
        charade.guesses.total - selected.guesses.total ||
        charade.createdAt - selected.createdAt ||
        charade.id.localeCompare(selected.id)
      ) {
        const order =
          candidatePreferred - selectedPreferred ||
          charade.guesses.total - selected.guesses.total ||
          charade.createdAt - selected.createdAt ||
          charade.id.localeCompare(selected.id)
        if (order < 0) selected = charade
      }
    }
    return (
      selected ??
      chooseHouseCharade(
        `round:${show.policy.showKey}:${previous ?? ''}:${houseSequence++}`,
        theme,
        show.housePhraseIds
      )
    )
  }

  function ensureRound(show: ActiveShow) {
    if (!rounds.isLive) return null
    const current = rounds.current
    if (
      current &&
      !rounds.isSettled &&
      activeRoundCharade?.publicId === current.charadeId &&
      activeRoundCharade.showKey === show.policy.showKey
    ) {
      return activeRoundCharade
    }
    if (!current && activeRoundCharade) {
      if (
        activeRoundCharade.charade.recipient !== undefined ||
        (!activeRoundCharade.charade.isHouse &&
          [...looks.keys()].some(
            (address) =>
              canonicalAddress(activeRoundCharade!.charade.author.address) === address ||
              (options.state.playerStats.get(address)?.seen.includes(activeRoundCharade!.charade.id) ?? false)
          ))
      ) {
        activeRoundCharade = null
      }
    }
    if (!current && activeRoundCharade) {
      rounds.start(activeRoundCharade.publicId)
      return activeRoundCharade
    }
    const selected = selectRoundCharade(show)
    activeRoundCharade =
      prepareCharade(selected, show) ??
      prepareCharade(
        chooseHouseCharade(
          `invalid-round:${show.policy.showKey}:${houseSequence++}`,
          show.policy.legacyTheme.id,
          show.housePhraseIds
        ),
        show
      )
    if (!activeRoundCharade) return null
    rounds.start(activeRoundCharade.publicId)
    return activeRoundCharade
  }

  async function runWelcome(address: string, generation: number) {
    const key = canonicalAddress(address)
    const owner = welcomePromises.get(key)
    if (!owner) return false
    if (!negotiated.has(key) || !isCurrentSession(key, generation)) return false
    const look = await waitForLook(address)
    if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
    if (!look) return false
    pendingWelcomeLooks.set(key, { generation, look })

    const stats = await options.state.getOrCreateStats(key, look.name, !look.isGuest)
    await rolloverIfNeeded()
    if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
    const canReceiveMail = !look.isGuest && STABLE_ADDRESS.test(look.address)
    let previousVisitors: typeof options.state.recentVisitors = []
    let rankIndex = -1
    let pending = { ...stats.pending }
    let progress = progressFor(stats)
    let consumed = false
    try {
      const persisted = await serializeMutation(async () => {
        await reconcileActiveDurableMutation()
        if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
        previousVisitors = [...options.state.recentVisitors]
        if (currentShow && stats.showSet?.showKey !== currentShow.policy.showKey) {
          showSetFor(stats, currentShow.policy.showKey)
          options.state.saveStats(key, !look.isGuest)
        }
        looks.set(key, look)
        options.state.touchVisitor(look)
        rankIndex = options.state.boards.decoders.findIndex((row) => canonicalAddress(row.address) === key)
        pending = { ...stats.pending }
        pending.mail = canReceiveMail
          ? options.state.countMailForRecipient(
              look.address,
              stats.seen,
              currentShow?.primaryPhraseIds ?? NO_PHRASE_IDS
            )
          : 0
        progress = progressFor(stats)
        options.state.consumePending(key, !look.isGuest)
        consumed = true
        try {
          await checkpoint()
        } catch (error) {
          if (welcomePromises.get(key) === owner && isCurrentSession(key, generation)) {
            stats.pending = pending
            options.state.saveStats(key, !look.isGuest)
            consumed = false
          }
          throw error
        }
        return true
      })
      if (!persisted) return false
      await rolloverIfNeeded()
    } catch (error) {
      if (consumed && welcomePromises.get(key) === owner && isCurrentSession(key, generation)) {
        await serializeMutation(async () => {
          await reconcileActiveDurableMutation()
          stats.pending = pending
          options.state.saveStats(key, !look.isGuest)
        })
      }
      throw error
    }
    if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false

    await sendTo(address, 'progress', {
      daily: { ...options.state.getDaily(stats) },
      revision: stats.revision,
      ...progress
    })
    if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
    try {
      await rolloverIfNeeded()
    } catch (error) {
      if (welcomePromises.get(key) === owner && isCurrentSession(key, generation)) {
        await serializeMutation(async () => {
          await reconcileActiveDurableMutation()
          stats.pending = pending
          options.state.saveStats(key, !look.isGuest)
        })
      }
      throw error
    }
    if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
    pending.mail = canReceiveMail
      ? options.state.countMailForRecipient(look.address, stats.seen, currentShow?.primaryPhraseIds ?? NO_PHRASE_IDS)
      : 0
    if (pending.triedYou > 0 || pending.replies > 0 || pending.mail > 0) {
      await sendTo(address, 'since', {
        triedYou: pending.triedYou,
        gotYou: pending.gotYou,
        replies: pending.replies,
        mail: pending.mail,
        rank: rankIndex < 0 ? 0 : rankIndex + 1,
        daily: { ...options.state.getDaily(stats) },
        revision: stats.revision,
        ...progress
      })
      if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
    }
    await sendVisibleTitles(address, generation)
    if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
    await sendAudience(address, generation, previousVisitors)
    if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
    await sendBoards(address, generation)
    if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
    welcomed.add(key)
    return true
  }

  function welcome(address: string, generation: number) {
    const key = canonicalAddress(address)
    if (welcomed.has(key)) return Promise.resolve(true)
    const active = welcomePromises.get(key)
    if (active) return active
    const pending = Promise.resolve()
      .then(() => runWelcome(address, generation))
      .finally(() => {
        if (welcomePromises.get(key) === pending) welcomePromises.delete(key)
        if (pendingWelcomeLooks.get(key)?.generation === generation) pendingWelcomeLooks.delete(key)
      })
    welcomePromises.set(key, pending)
    return pending
  }

  async function ensureWelcome(address: string, generation: number, requestId?: string) {
    const key = canonicalAddress(address)
    if (!isCurrentSession(key, generation)) return false
    if (!(await requireNegotiated(address))) return false
    if (welcomed.has(key)) return true
    try {
      const result = await welcome(address, generation)
      if (!result && isCurrentSession(address, generation)) await sendError(address, 'look-not-ready', requestId)
      return result
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] welcome failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable', requestId)
      return false
    }
  }

  async function handleEnter(address: string) {
    await ready
    const key = canonicalAddress(address)
    if (!present.has(key)) {
      present.add(key)
      sessionGenerations.set(key, ++nextSessionGeneration)
    }
    await sendTo(address, 'ready', readyPayload())
  }

  async function handleLeave(address: string) {
    await ready
    const key = canonicalAddress(address)
    const leavingGeneration = sessionGenerations.get(key)
    present.delete(key)
    const pendingWelcome = welcomePromises.get(key)
    if (pendingWelcome) cancelledWelcomePromises.add(pendingWelcome)
    welcomePromises.delete(key)
    const pendingLook = pendingWelcomeLooks.get(key)
    const look =
      looks.get(key) ?? (pendingLook && pendingLook.generation === leavingGeneration ? pendingLook.look : undefined)
    pendingWelcomeLooks.delete(key)
    looks.delete(key)
    welcomed.delete(key)
    negotiated.delete(key)
    activeDecoders.delete(key)
    lastAuthors.delete(key)
    lastPosts.delete(key)
    for (const answerKey of servedAnswers.keys()) {
      if (answerKey.startsWith(`${key}:`)) servedAnswers.delete(answerKey)
    }
    for (const [request, entry] of completedRequests) {
      if (entry.owner === key) completedRequests.delete(request)
    }
    for (const [request, entry] of nextRequests) {
      if (entry.owner === key) nextRequests.delete(request)
    }
    for (const bucketKey of requestBuckets.keys()) {
      if (bucketKey === key) requestBuckets.delete(bucketKey)
    }
    for (const outstandingKey of outstandingRequests.keys()) {
      if (outstandingKey.startsWith(`${key}:`)) outstandingRequests.delete(outstandingKey)
    }
    lastReactions.delete(key)
    rounds.leave(key)
    if (!rounds.current) activeRoundCharade = null
    if (!look) {
      if (!present.has(key) && sessionGenerations.get(key) === leavingGeneration) sessionGenerations.delete(key)
      if (!activeLeavePersistence.has(key) && !pendingLeavePersistence.has(key)) options.state.evictStats(key)
      return
    }
    const mutationWasQueued = queuedMutations > 0 || activeLeavePersistence.has(key)
    pendingLeavePersistence.set(key, { generation: leavingGeneration ?? 0, look })
    const persistence = scheduleLeavePersistence(key)
    if (!mutationWasQueued) await persistence
  }

  async function handleHello(data: HelloPayload, address: string) {
    await ready
    const generation = sessionGeneration(address)
    if (generation === null || !validApplicationPayload(data)) {
      await sendError(address, 'protocol-required')
      return
    }
    if (data.protocolVersion !== PROTOCOL_VERSION) {
      negotiated.delete(canonicalAddress(address))
      await sendError(address, 'protocol-version')
      return
    }
    negotiated.add(canonicalAddress(address))
    const timestamp = now()
    const rollover = await rolloverOrError(address, generation, timestamp)
    if (!rollover) return
    if (!isCurrentSession(address, generation)) return
    if (!rollover.announced.has(canonicalAddress(address))) {
      await sendTo(address, 'ready', readyPayload(timestamp))
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'showSchedule', showSchedulePayload(timestamp))
    }
    if (!isCurrentSession(address, generation)) return
    const pendingWelcome = welcome(address, generation)
    try {
      if (!(await pendingWelcome) && !cancelledWelcomePromises.has(pendingWelcome)) {
        if (isCurrentSession(address, generation)) await sendError(address, 'look-not-ready')
      }
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] welcome failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable')
    }
  }

  async function handlePing(data: PingPayload, address: string) {
    await ready
    const generation = sessionGeneration(address)
    if (generation === null) return
    const timestamp = now()
    if (negotiated.has(canonicalAddress(address)) && !(await rolloverOrError(address, generation, timestamp))) return
    if (!isCurrentSession(address, generation)) return
    await sendTo(address, 'pong', { seq: data.seq })
    if (!isCurrentSession(address, generation)) return
    if (negotiated.has(canonicalAddress(address))) {
      await sendTo(address, 'showSchedule', showSchedulePayload(timestamp))
      if (!isCurrentSession(address, generation)) return
      const announcement = rounds.announcementFor(address)
      if (announcement) {
        const showKey = currentShow?.policy.showKey ?? ''
        await sendTo(address, 'roundStart', {
          instanceId,
          roundId: announcement.roundId,
          charadeId: announcement.charadeId,
          showKey
        })
        if (!isCurrentSession(address, generation)) return
        if (announcement.winner) {
          await sendTo(address, 'roundWinner', {
            instanceId,
            roundId: announcement.roundId,
            charadeId: announcement.charadeId,
            address: announcement.winner.address,
            name: announcement.winner.name,
            showKey
          })
        }
      }
    }
    if (negotiated.has(canonicalAddress(address)) && !welcomed.has(canonicalAddress(address))) {
      await ensureWelcome(address, generation)
    }
  }

  function prepareCharade(charade: Charade | null, show: ActiveShow): PreparedCharade | null {
    if (!charade || !show.primaryPhraseIds.has(charade.phraseId)) return null
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)
    if (!phrase) return null
    if (
      !charade.isHouse &&
      (!isAllowedPerformance(phrase, charade.emotes) || !isDecodablePerformance(phrase, charade.emotes, show.decoyDeck))
    ) {
      return null
    }
    if (
      charade.reply &&
      (!isAllowedPerformance(phrase, charade.reply.emotes) ||
        !isDecodablePerformance(phrase, charade.reply.emotes, show.decoyDeck))
    ) {
      return null
    }
    const privateSeed = `${serverSecret}:${++answerSequence}:${random()}`
    const decoys = pickDecoys(phrase.id, charade.emotes, show.decoyDeck, privateSeed)
    if (decoys.length !== 2) return null
    const shuffled = shuffleSeeded([phrase, decoys[0], decoys[1]], `${privateSeed}:answers`)
    return {
      charade,
      showKey: show.policy.showKey,
      publicId: charade.isHouse ? `house-${hashText(privateSeed, 0)}${hashText(privateSeed, 0x9e3779b9)}` : charade.id,
      answers: shuffled.map((answer) => answer.text),
      answerIds: shuffled.map((answer) => answer.id),
      correctIndex: shuffled.findIndex((answer) => answer.id === phrase.id)
    }
  }

  async function sendCharade(address: string, generation: number, requestId: string, prepared: PreparedCharade) {
    const addressKey = canonicalAddress(address)
    if (!isCurrentSession(address, generation)) return false
    const servedKey = `${addressKey}:${prepared.publicId}`
    for (const answerKey of servedAnswers.keys()) {
      if (answerKey.startsWith(`${addressKey}:`) && answerKey !== servedKey) servedAnswers.delete(answerKey)
    }
    const served = servedAnswers.get(servedKey) ?? { prepared, firstGuessEligibleAt: null, retry: null }
    served.firstGuessEligibleAt = null
    servedAnswers.set(servedKey, served)
    const presentation = served.prepared
    const { charade } = presentation
    const cachedAuthorStats = options.state.playerStats.get(canonicalAddress(charade.author.address))
    const authorTitle = charade.isHouse || !cachedAuthorStats ? '' : progressFor(cachedAuthorStats).title
    const cachedStats = options.state.playerStats.get(addressKey)
    const showSet = cachedStats ? showSetFor(cachedStats, prepared.showKey) : emptyShowSet(prepared.showKey)
    const setRound = Math.min(showSet.round + 1, SHOW_SET_SIZE)
    activeDecoders.add(addressKey)
    lastAuthors.set(addressKey, charade.author.address)
    const authorLook = withoutLastSeen(charade.author)
    await sendTo(address, 'charade', {
      requestId,
      id: presentation.publicId,
      authorName: authorLook.name,
      authorAddress: authorLook.address,
      look: authorLook,
      emotes: [...charade.emotes],
      answers: presentation.answers,
      answerIds: presentation.answerIds,
      createdAt: charade.createdAt,
      isHouse: charade.isHouse,
      authorTitle,
      setRound,
      setSize: SHOW_SET_SIZE,
      setScore: showSet.score,
      setStreak: showSet.streak,
      isFinale: setRound === SHOW_SET_SIZE,
      ...(charade.recipient ? { recipient: charade.recipient } : {})
    })
    if (!isCurrentSession(address, generation)) return false
    if (charade.reply) {
      const replyLook = withoutLastSeen(charade.reply.look)
      await sendTo(address, 'charadeReply', {
        charadeId: charade.id,
        address: replyLook.address,
        name: replyLook.name,
        look: replyLook,
        emotes: [...charade.reply.emotes],
        createdAt: charade.reply.createdAt
      })
    }
    if (!isCurrentSession(address, generation) || servedAnswers.get(servedKey) !== served) return false
    served.firstGuessEligibleAt = now() + firstGuessDelayMilliseconds
    return true
  }

  async function handleNextCharade(data: NextCharadePayload, address: string, transitionRetry = 0) {
    await ready
    if (
      !validWireString(data.requestId) ||
      data.exclude.length > MAX_EXCLUDE_IDS ||
      data.exclude.some((id) => !validWireString(id))
    ) {
      await sendError(address, 'invalid-next-charade', validWireString(data.requestId) ? data.requestId : undefined)
      return
    }
    const generation = sessionGeneration(address)
    if (generation === null) {
      await sendError(address, 'protocol-required', data.requestId)
      return
    }
    if (!(await ensureWelcome(address, generation, data.requestId))) return
    if (!(await rolloverOrError(address, generation, undefined, data.requestId))) return
    if (!isCurrentSession(address, generation)) return
    const show = currentShow
    if (!show) {
      await sendError(address, 'invalid-next-charade', data.requestId)
      return
    }
    const key = canonicalAddress(address)
    const selectionKey = `${key}:${show.policy.showKey}:${data.requestId}`
    let selection = cacheGet(nextRequests, selectionKey)
    const activeRetry = [...servedAnswers.entries()].find(
      ([servedKey, served]) => servedKey.startsWith(`${key}:`) && served.retry !== null
    )?.[1]
    if (activeRetry && !selection) {
      await sendError(address, 'invalid-next-charade', data.requestId)
      return
    }
    if (!selection) {
      selection = (async () => {
        const look = looks.get(key)
        const stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
        if (stats.showSet?.showKey !== show.policy.showKey || stats.showSet.round >= SHOW_SET_SIZE) {
          await serializeMutation(async () => {
            await reconcileActiveDurableMutation()
            const current = showSetFor(stats, show.policy.showKey)
            if (current.round >= SHOW_SET_SIZE) stats.showSet = emptyShowSet(show.policy.showKey)
            options.state.saveStats(key, !(look?.isGuest ?? true))
          })
        }
        if (!isCurrentSession(address, generation)) {
          return prepareCharade(
            chooseHouseCharade(
              `${key}:stale:${show.policy.showKey}:${houseSequence++}`,
              show.policy.legacyTheme.id,
              show.housePhraseIds
            ),
            show
          )
        }
        const mail =
          look && !look.isGuest && STABLE_ADDRESS.test(look.address)
            ? options.state.getMailForRecipient(look.address, stats.seen, data.exclude, show.primaryPhraseIds)
            : null
        if (mail) {
          const preparedMail = prepareCharade(mail, show)
          if (preparedMail) return preparedMail
        }
        const currentRound = rounds.current
        const currentCharade = currentRound && !rounds.isSettled ? (activeRoundCharade?.charade ?? null) : null
        const roundEligible =
          currentCharade !== null &&
          (currentCharade.isHouse ||
            (!stats.seen.includes(currentCharade.id) && canonicalAddress(currentCharade.author.address) !== key))

        if (!rounds.hasPlayer(key) && (currentCharade === null || roundEligible)) {
          rounds.enter({ address: look?.address ?? address, name: look?.name ?? playerName(key) })
        }
        if (currentRound && data.exclude.includes(currentRound.charadeId)) rounds.abstain(key, currentRound.roundId)

        const liveCharade = ensureRound(show)
        const requesterGuessed = rounds.current?.guessed.includes(key) ?? false
        const selected =
          (rounds.isParticipant(key) && !requesterGuessed ? liveCharade : null) ??
          prepareCharade(
            chooseCharadeFor(
              key,
              [...stats.seen, ...data.exclude],
              options.state.getPool().filter((charade) => show.primaryPhraseIds.has(charade.phraseId)),
              lastAuthors.get(key),
              show.policy.legacyTheme.id
            ) ??
              chooseHouseCharade(
                `${key}:${show.policy.showKey}:${data.requestId}:${houseSequence++}`,
                show.policy.legacyTheme.id,
                show.housePhraseIds
              ),
            show
          )
        return (
          selected ??
          prepareCharade(
            chooseHouseCharade(
              `${key}:invalid:${show.policy.showKey}:${houseSequence++}`,
              show.policy.legacyTheme.id,
              show.housePhraseIds
            ),
            show
          )
        )
      })()
      cacheSet(nextRequests, selectionKey, key, selection)
      void selection.catch(() => {
        if (cacheGet(nextRequests, selectionKey) === selection) nextRequests.delete(selectionKey)
      })
    }
    const prepared = await selection
    if (!isCurrentSession(address, generation)) return
    if (!(await rolloverOrError(address, generation, undefined, data.requestId))) return
    if (!isCurrentSession(address, generation)) return
    if (!prepared || prepared.showKey !== currentShow?.policy.showKey) {
      nextRequests.delete(selectionKey)
      if (transitionRetry === 0 && currentShow) {
        await handleNextCharade(data, address, 1)
        return
      }
      await sendError(address, 'invalid-next-charade', data.requestId)
      return
    }
    if (activeRetry && prepared.publicId !== activeRetry.prepared.publicId) {
      await sendError(address, 'invalid-next-charade', data.requestId)
      return
    }
    if (rounds.playerCount === 1 && !rounds.current && prepared.charade.recipient === undefined) {
      activeRoundCharade = prepared
    }
    await sendCharade(address, generation, data.requestId, prepared)
  }

  function requestKey(address: string, kind: string, requestId: string) {
    return `${canonicalAddress(address)}:${kind}:${requestId}`
  }

  function isCurrentRoundGuess(address: string, roundId: string | null, charadeId: string) {
    const current = rounds.current
    if (!current) return !rounds.isLive
    if (roundId === null) return current.charadeId !== charadeId || !rounds.isParticipant(address)
    return current.roundId === roundId && current.charadeId === charadeId && rounds.isParticipant(address)
  }

  function isCurrentServed(showKey: string, servedKey: string, servedState: ServedCharade) {
    return currentShow?.policy.showKey === showKey && servedAnswers.get(servedKey) === servedState
  }

  async function handleGuess(data: GuessPayload, address: string, roundId: string | null) {
    await ready
    const correlatedRequestId = validWireString(data.requestId) ? data.requestId : undefined
    const generation = sessionGeneration(address)
    if (generation === null) {
      await sendError(address, 'protocol-required', correlatedRequestId)
      return
    }
    if (!(await ensureWelcome(address, generation, correlatedRequestId))) return
    if (!(await rolloverOrError(address, generation, undefined, correlatedRequestId))) return
    if (!isCurrentSession(address, generation)) return
    const key = canonicalAddress(address)
    if (
      !validWireString(data.requestId) ||
      !validWireString(data.charadeId) ||
      (roundId !== null &&
        (typeof roundId !== 'string' ||
          !validWireString(roundId) ||
          !ROUND_ID.test(roundId) ||
          !Number.isSafeInteger(Number(roundId)))) ||
      !Number.isInteger(data.answerIndex) ||
      data.answerIndex < 0 ||
      data.answerIndex > 2 ||
      (data.spotlight !== undefined && typeof data.spotlight !== 'boolean')
    ) {
      await sendError(address, 'invalid-guess', validWireString(data.requestId) ? data.requestId : undefined)
      return
    }
    const idempotencyKey = requestKey(key, 'guess', data.requestId)
    const fingerprint = guessFingerprint(data, roundId)
    const completed = cacheGet(completedRequests, idempotencyKey)
    if (completed) {
      if (
        (completed.type !== 'retry' && completed.type !== 'reveal') ||
        !sameDurableFingerprint(completed.fingerprint, fingerprint)
      ) {
        await sendError(address, 'invalid-guess', data.requestId)
        return
      }
      if (!completed.durable) {
        if (
          !(await checkpointCachedMutation(
            address,
            generation,
            data.requestId,
            completed.type === 'retry' ? undefined : completed.mutationId
          ))
        ) {
          return
        }
        completed.durable = true
      }
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, completed.type, completed.data)
      return
    }
    const activeMutation = options.state.getActiveDurableMutation(idempotencyKey)
    if (activeMutation) {
      if (
        activeMutation.response.type !== 'reveal' ||
        fingerprint.kind !== 'guess' ||
        !sameDurableFingerprint(activeMutation.fingerprint, fingerprint)
      ) {
        await sendError(address, 'invalid-guess', data.requestId)
        return
      }
      if (!(await recoverActiveRequest(address, generation, data.requestId, activeMutation))) return
      const reveal = activeMutation.response.data as RevealPayload
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'reveal', reveal)
      if (reveal.titleUnlocked) await broadcastTitleUnlock(address, reveal.title)
      if (activeMutation.charade) await refreshBoards()
      return
    }
    const durableCompletion = options.state.getDurableCompletion(key, 'guess', data.requestId)
    if (durableCompletion) {
      if (!sameDurableFingerprint(durableCompletion.fingerprint, fingerprint)) {
        await sendError(address, 'invalid-guess', data.requestId)
        return
      }
      await sendTo(address, 'reveal', durableCompletion.response.data as RevealPayload)
      return
    }
    if (!isCurrentRoundGuess(key, roundId, data.charadeId)) {
      await sendError(address, 'invalid-guess', data.requestId)
      return
    }
    const servedKey = `${key}:${data.charadeId}`
    const servedState = servedAnswers.get(servedKey)
    if (!servedState) {
      await sendError(address, 'charade-not-served', data.requestId)
      return
    }
    if (
      servedState.retry === null &&
      (servedState.firstGuessEligibleAt === null || now() < servedState.firstGuessEligibleAt)
    ) {
      await sendError(address, 'invalid-guess', data.requestId)
      return
    }
    const served = servedState.prepared
    const { charade } = served
    const look = looks.get(key)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)
    if (!phrase) {
      servedAnswers.delete(servedKey)
      await sendError(address, 'invalid-charade', data.requestId)
      return
    }
    const countable =
      !charade.isHouse && charade.recipient === undefined && !(look?.isGuest ?? true) && !charade.author.isGuest
    const notifyAuthor = !charade.isHouse && !(look?.isGuest ?? true) && !charade.author.isGuest
    let stats: Awaited<ReturnType<GhostlightState['getOrCreateStats']>>
    try {
      stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] guess prerequisites failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable', data.requestId)
      return
    }
    if (!(await rolloverOrError(address, generation, undefined, data.requestId))) return
    if (!isCurrentSession(address, generation)) return
    if (
      !isCurrentServed(served.showKey, servedKey, servedState) ||
      !isCurrentRoundGuess(key, roundId, data.charadeId)
    ) {
      await sendError(address, 'invalid-guess', data.requestId)
      return
    }
    if (!charade.isHouse && stats.seen.includes(charade.id)) {
      await sendError(address, 'already-guessed', data.requestId)
      return
    }
    const correct = data.answerIndex === served.correctIndex
    const storedRetry = servedState.retry
    if (storedRetry?.requestId === data.requestId) {
      if (!sameDurableFingerprint(storedRetry.fingerprint, fingerprint)) {
        await sendError(address, 'invalid-guess', data.requestId)
        return
      }
      await sendTo(address, 'retry', storedRetry.response)
      return
    }
    if (!storedRetry && !correct) {
      const replayBeatIndex = chooseRetryBeat(
        charade.emotes,
        served.answerIds,
        data.answerIndex,
        `${served.publicId}:${served.answerIds.join('|')}:${data.answerIndex}:retry`
      )
      const retry: RetryPayload = {
        requestId: data.requestId,
        charadeId: data.charadeId,
        removedAnswerIndex: data.answerIndex,
        replayBeatIndex
      }
      servedState.retry = {
        requestId: data.requestId,
        removedAnswerIndex: data.answerIndex,
        replayBeatIndex,
        spotlight: data.spotlight === true,
        fingerprint,
        response: retry
      }
      cacheSet(completedRequests, idempotencyKey, key, {
        type: 'retry',
        data: retry,
        durable: true,
        fingerprint
      })
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'retry', retry)
      return
    }
    if (storedRetry && data.answerIndex === storedRetry.removedAnswerIndex) {
      await sendError(address, 'invalid-guess', data.requestId)
      return
    }

    let authorStats: Awaited<ReturnType<GhostlightState['getOrCreateStats']>> | null
    try {
      authorStats = notifyAuthor
        ? await options.state.getOrCreateStats(charade.author.address, charade.author.name, true)
        : null
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] guess prerequisites failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable', data.requestId)
      return
    }
    if (!(await rolloverOrError(address, generation, undefined, data.requestId))) return
    if (!isCurrentSession(address, generation)) return
    if (
      !isCurrentServed(served.showKey, servedKey, servedState) ||
      !isCurrentRoundGuess(key, roundId, data.charadeId)
    ) {
      await sendError(address, 'invalid-guess', data.requestId)
      return
    }

    const committed = await serializeMutation(async () => {
      if (
        !isCurrentSession(address, generation) ||
        !isCurrentServed(served.showKey, servedKey, servedState) ||
        !isCurrentRoundGuess(key, roundId, data.charadeId)
      ) {
        if (isCurrentSession(address, generation)) await sendError(address, 'invalid-guess', data.requestId)
        return null
      }
      if (!(await reconcileActiveDurableMutationOrError(address, generation, data.requestId))) return null
      if (
        !isCurrentSession(address, generation) ||
        !isCurrentServed(served.showKey, servedKey, servedState) ||
        !isCurrentRoundGuess(key, roundId, data.charadeId)
      ) {
        if (isCurrentSession(address, generation)) await sendError(address, 'invalid-guess', data.requestId)
        return null
      }

      const mutationTime = now()
      if (dayKey(mutationTime) > currentDay) return { retryAfterRollover: mutationTime }
      const statsBefore = cloneStats(stats)
      const statsAfter = cloneStats(stats)
      const authorBefore = authorStats ? cloneStats(authorStats) : null
      const authorAfter = authorStats ? cloneStats(authorStats) : null
      const previousTitle = progressFor(statsAfter).title
      const attempt = storedRetry ? 2 : 1
      const recovered = attempt === 2 && correct
      const understood = correct && !recovered
      const spotlight = storedRetry?.spotlight ?? data.spotlight === true
      const showSet = showSetFor(statsAfter, served.showKey)
      const scoreDelta = recovered ? 50 : correct ? (spotlight ? 200 : 100) : spotlight ? -100 : 0
      showSet.round = Math.min(showSet.round + 1, SHOW_SET_SIZE)
      showSet.score = Math.max(0, Math.min(showSet.score + scoreDelta, SHOW_SET_SIZE * 200))
      if (understood) {
        showSet.streak = Math.min(showSet.streak + 1, SHOW_SET_SIZE)
        showSet.bestStreak = Math.max(showSet.bestStreak, showSet.streak)
        showSet.understood = Math.min(showSet.understood + 1, SHOW_SET_SIZE)
      } else if (!correct) {
        showSet.streak = 0
      }
      if (!charade.isHouse && !statsAfter.seen.includes(charade.id)) statsAfter.seen.push(charade.id)
      let stampAwarded = false
      if (countable) {
        statsAfter.decoded = Math.min(statsAfter.decoded + 1, WIRE_INT_MAX)
        statsAfter.correct = Math.min(statsAfter.correct + (understood ? 1 : 0), WIRE_INT_MAX)
        stampAwarded = options.state.recordDailyDecode(statsAfter)
        options.state.advanceProgressRevision(statsAfter)
      }
      statsAfter.lastSeenAt = mutationTime
      const progress = progressFor(statsAfter)
      const titleUnlocked = progress.title !== previousTitle && progress.title !== ''
      if (authorAfter) {
        authorAfter.pending.triedYou = Math.min(authorAfter.pending.triedYou + 1, WIRE_INT_MAX)
        authorAfter.pending.gotYou = Math.min(authorAfter.pending.gotYou + (understood ? 1 : 0), WIRE_INT_MAX)
        authorAfter.lastSeenAt = mutationTime
        options.state.getPlayerProgress(authorAfter)
      }
      const currentCharade = options.state.getCharade(charade.id) ?? charade
      const updatedCharade = countable
        ? {
            ...currentCharade,
            guesses: {
              total: Math.min(currentCharade.guesses.total + 1, WIRE_INT_MAX),
              correct: Math.min(currentCharade.guesses.correct + (understood ? 1 : 0), WIRE_INT_MAX)
            },
            lastGuessAt: mutationTime
          }
        : undefined
      const ranked = updatedCharade
        ? options.state.previewRankedGuess(updatedCharade, key, statsAfter.name, understood)
        : null
      const reveal: RevealPayload = {
        requestId: data.requestId,
        charadeId: data.charadeId,
        correct,
        phraseId: phrase.id,
        phrase: phrase.text,
        stats: { ...(updatedCharade?.guesses ?? currentCharade.guesses) },
        yourScore: statsAfter.correct,
        daily: { ...options.state.getDaily(statsAfter) },
        revision: statsAfter.revision,
        stampAwarded,
        attempt,
        ...progress,
        titleUnlocked,
        spotlight,
        scoreDelta,
        setRound: showSet.round,
        setSize: SHOW_SET_SIZE,
        setScore: showSet.score,
        setStreak: showSet.streak,
        setBestStreak: showSet.bestStreak,
        setUnderstood: showSet.understood,
        setComplete: showSet.round === SHOW_SET_SIZE,
        isFinale: showSet.round === SHOW_SET_SIZE
      }
      const mutation: DurableMutation = {
        v: 1,
        id: idempotencyKey,
        owner: key,
        requestId: data.requestId,
        createdAt: mutationTime,
        fingerprint: guessFingerprint(data, roundId),
        response: { type: 'reveal', data: reveal as unknown as Record<string, unknown> },
        ...(authorBefore && authorAfter ? { notifiedAuthor: canonicalAddress(charade.author.address) } : {}),
        ...(updatedCharade ? { charade: updatedCharade } : {}),
        stats: [
          durableStatsPatch(key, !(look?.isGuest ?? true), statsBefore, statsAfter),
          ...(authorBefore && authorAfter
            ? [durableStatsPatch(charade.author.address, true, authorBefore, authorAfter)]
            : [])
        ],
        ...(ranked?.decoder ? { decoder: ranked.decoder } : {}),
        ...(ranked ? { boards: ranked.boards } : {})
      }
      try {
        await options.state.beginDurableMutation(mutation)
        await options.state.applyDurableMutation(mutation)
      } catch (error) {
        if (error instanceof StorageCapacityError) {
          await sendError(address, 'server-busy', data.requestId)
          return null
        }
        if (!(error instanceof StorageUnavailableError)) console.error('[storage] guess mutation failed', error)
        await sendError(address, 'storage-unavailable', data.requestId)
        return null
      }

      servedAnswers.delete(servedKey)
      for (const [requestKey, entry] of nextRequests) {
        if (entry.owner === key) nextRequests.delete(requestKey)
      }
      activeDecoders.delete(key)
      if (roundId !== null) rounds.guess(key, roundId, data.charadeId, !charade.isHouse && understood)

      const request = {
        type: 'reveal' as const,
        data: reveal,
        durable: false,
        fingerprint,
        mutationId: mutation.id
      }
      cacheSet(completedRequests, idempotencyKey, key, request)
      if (!(await checkpointOrError(address, generation, data.requestId, mutation.id))) return null
      request.durable = true
      return { mutation, request, reveal, titleUnlocked, title: progress.title }
    })
    if (!committed) return
    if ('retryAfterRollover' in committed) {
      if (!(await rolloverOrError(address, generation, committed.retryAfterRollover, data.requestId))) return
      return handleGuess(data, address, roundId)
    }
    if (!isCurrentSession(address, generation)) return
    await sendTo(address, 'reveal', committed.reveal)
    if (committed.titleUnlocked) await broadcastTitleUnlock(address, committed.title)
    if (countable) await refreshBoards()
  }

  async function handlePost(data: PostPayloadInput, address: string) {
    await ready
    const correlatedRequestId = validWireString(data.requestId) ? data.requestId : undefined
    const generation = sessionGeneration(address)
    if (generation === null) {
      await sendError(address, 'protocol-required', correlatedRequestId)
      return
    }
    if (!(await ensureWelcome(address, generation, correlatedRequestId))) return
    if (!(await rolloverOrError(address, generation, undefined, correlatedRequestId))) return
    if (!isCurrentSession(address, generation)) return
    if (options.state.isReadOnly) {
      await sendError(address, 'server-busy', correlatedRequestId)
      return
    }
    const key = canonicalAddress(address)
    if (!validWireString(data.requestId)) {
      await sendError(address, data.replyTo === undefined ? 'invalid-post' : 'invalid-reply')
      return
    }
    if (typeof data.touringConsent !== 'boolean') {
      await sendError(address, data.replyTo === undefined ? 'invalid-post' : 'invalid-reply', data.requestId)
      return
    }
    if ((data.replyTo !== undefined || data.recipient !== undefined) && data.touringConsent) {
      await sendError(address, data.replyTo === undefined ? 'invalid-post' : 'invalid-reply', data.requestId)
      return
    }
    if (!Array.isArray(data.emotes) || data.emotes.length !== 3 || data.emotes.some((emote) => !EMOTES.has(emote))) {
      await sendError(address, data.replyTo === undefined ? 'invalid-post' : 'invalid-reply', data.requestId)
      return
    }
    const authoredPost = snapshotAuthoredPost({ ...data, touringConsent: data.touringConsent })
    const idempotencyKey = requestKey(key, 'post', data.requestId)
    const completed = cacheGet(completedRequests, idempotencyKey)
    if (completed) {
      if (completed.type !== 'posted' || !sameAuthoredPost(completed.authoredPost, authoredPost)) {
        await sendError(address, data.replyTo === undefined ? 'invalid-post' : 'invalid-reply', data.requestId)
        return
      }
      if (!completed.durable) {
        if (!(await checkpointCachedMutation(address, generation, data.requestId, completed.mutationId))) return
        completed.durable = true
      }
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, completed.type, completed.data)
      return
    }
    const activeMutation = options.state.getActiveDurableMutation(idempotencyKey)
    if (activeMutation) {
      if (
        activeMutation.response.type !== 'posted' ||
        !sameDurableFingerprint(activeMutation.fingerprint, postFingerprint(authoredPost))
      ) {
        await sendError(address, data.replyTo === undefined ? 'invalid-post' : 'invalid-reply', data.requestId)
        return
      }
      if (!(await recoverActiveRequest(address, generation, data.requestId, activeMutation))) return
      const posted = activeMutation.response.data as PostedPayload
      if (activeMutation.fingerprint.kind !== 'post') {
        await sendError(address, data.replyTo === undefined ? 'invalid-post' : 'invalid-reply', data.requestId)
        return
      }
      if (activeMutation.fingerprint.replyTo === undefined) lastPosts.set(key, activeMutation.createdAt)
      cacheSet(completedRequests, idempotencyKey, key, {
        type: 'posted',
        data: posted,
        durable: true,
        authoredPost
      })
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'posted', posted)
      if (
        activeMutation.fingerprint.replyTo === undefined &&
        activeMutation.fingerprint.recipient === undefined &&
        posted.titleUnlocked
      ) {
        await broadcastTitleUnlock(address, posted.title)
      }
      if (activeMutation.fingerprint.replyTo === undefined && activeMutation.fingerprint.recipient === undefined) {
        await refreshBoards()
      }
      return
    }
    const durableCompletion = options.state.getDurableCompletion(key, 'post', data.requestId)
    if (durableCompletion) {
      if (!sameDurableFingerprint(durableCompletion.fingerprint, postFingerprint(authoredPost))) {
        await sendError(address, data.replyTo === undefined ? 'invalid-post' : 'invalid-reply', data.requestId)
        return
      }
      await sendTo(address, 'posted', durableCompletion.response.data as PostedPayload)
      return
    }
    const welcomedLook = looks.get(key)
    if (!welcomedLook || welcomedLook.isGuest) {
      await sendError(address, data.recipient !== undefined ? 'mail-guest' : 'post-guest', data.requestId)
      return
    }
    const storedReplyRequest = findStoredReplyRequest(options.state, key, data.requestId)
    if (data.replyTo !== undefined) {
      if (
        !validWireString(data.requestId) ||
        !validWireString(data.replyTo) ||
        data.recipient !== undefined ||
        !data.phraseId
      ) {
        await sendError(address, 'invalid-reply', data.requestId)
        return
      }
      const storedCharadeRequest = options.state.getCharade(charadeId(key, data.requestId))
      if (
        (storedCharadeRequest && canonicalAddress(storedCharadeRequest.author.address) === key) ||
        (storedReplyRequest && !storedReplyMatchesPost(storedReplyRequest, key, data.requestId, authoredPost))
      ) {
        await sendError(address, 'invalid-reply', data.requestId)
        return
      }
      const target = options.state.getCharade(data.replyTo)
      const look = looks.get(key)
      const stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
      if (!isCurrentSession(address, generation)) return
      if (
        !target ||
        target.isHouse ||
        canonicalAddress(target.author.address) === key ||
        (target.recipient !== undefined && canonicalAddress(target.recipient) !== key) ||
        !stats.seen.includes(target.id) ||
        target.phraseId !== data.phraseId
      ) {
        await sendError(address, 'reply-not-eligible', data.requestId)
        return
      }
      if (storedReplyRequest) {
        const posted: PostedPayload = {
          requestId: data.requestId,
          charadeId: target.id,
          replyTo: target.id,
          daily: { ...options.state.getDaily(stats) },
          revision: stats.revision,
          stampAwarded: false,
          ...progressFor(stats),
          titleUnlocked: false
        }
        const request = { type: 'posted' as const, data: posted, durable: false, authoredPost }
        cacheSet(completedRequests, idempotencyKey, key, request)
        if (!(await checkpointOrError(address, generation, data.requestId))) return
        request.durable = true
        if (!isCurrentSession(address, generation)) return
        await sendTo(address, 'posted', posted)
        return
      }
      const replyShow = currentShow
      if (
        !replyShow ||
        !replyShow.primaryPhraseIds.has(target.phraseId) ||
        !isAllowedPerformance(target.phraseId, data.emotes) ||
        !isDecodablePerformance(target.phraseId, data.emotes, replyShow.decoyDeck)
      ) {
        await sendError(address, 'invalid-reply', data.requestId)
        return
      }
      const existingReply = target.reply
      if (existingReply) {
        await sendError(
          address,
          canonicalAddress(existingReply.address) === key ? 'invalid-reply' : 'reply-taken',
          data.requestId
        )
        return
      }
      const replyLook = await waitForLook(address)
      if (!replyLook) {
        if (isCurrentSession(address, generation)) await sendError(address, 'look-not-ready', data.requestId)
        return
      }
      if (!isCurrentSession(address, generation)) return
      let authorStats: Awaited<ReturnType<GhostlightState['getOrCreateStats']>>
      try {
        authorStats = await options.state.getOrCreateStats(
          target.author.address,
          target.author.name,
          !target.author.isGuest
        )
      } catch (error) {
        if (!(error instanceof StorageUnavailableError)) console.error('[storage] reply prerequisites failed', error)
        if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable', data.requestId)
        return
      }
      if (
        !(await requireCurrentPrimary(
          address,
          generation,
          replyShow.policy.showKey,
          target.phraseId,
          'invalid-reply',
          data.requestId
        ))
      ) {
        return
      }
      const replyCommit = await serializeMutation(async () => {
        if (!isCurrentSession(address, generation)) return
        if (!(await reconcileActiveDurableMutationOrError(address, generation, data.requestId))) return
        if (!isCurrentSession(address, generation)) return
        const currentTarget = options.state.getCharade(target.id)
        if (!currentTarget || currentTarget.reply) {
          await sendError(
            address,
            currentTarget?.reply && canonicalAddress(currentTarget.reply.address) !== key
              ? 'reply-taken'
              : 'invalid-reply',
            data.requestId
          )
          return
        }
        if (
          currentShow?.policy.showKey !== replyShow.policy.showKey ||
          !currentShow.primaryPhraseIds.has(currentTarget.phraseId)
        ) {
          await sendError(address, 'invalid-reply', data.requestId)
          return
        }
        const mutationTime = now()
        if (dayKey(mutationTime) > currentDay) return { retryAfterRollover: mutationTime }
        const authorBefore = cloneStats(authorStats)
        const authorAfter = cloneStats(authorStats)
        authorAfter.pending.replies = Math.min(authorAfter.pending.replies + 1, WIRE_INT_MAX)
        authorAfter.lastSeenAt = mutationTime
        options.state.getPlayerProgress(authorAfter)
        const updated: Charade = {
          ...currentTarget,
          reply: {
            requestId: data.requestId,
            address: replyLook.address,
            name: replyLook.name,
            look: replyLook,
            emotes: [data.emotes[0], data.emotes[1], data.emotes[2]],
            createdAt: mutationTime
          }
        }
        const posted: PostedPayload = {
          requestId: data.requestId,
          charadeId: target.id,
          replyTo: target.id,
          daily: { ...options.state.getDaily(stats) },
          revision: stats.revision,
          stampAwarded: false,
          ...progressFor(stats),
          titleUnlocked: false
        }
        const mutation: DurableMutation = {
          v: 1,
          id: idempotencyKey,
          owner: key,
          requestId: data.requestId,
          createdAt: mutationTime,
          fingerprint: postFingerprint(authoredPost),
          response: { type: 'posted', data: posted as unknown as Record<string, unknown> },
          charade: updated,
          stats: [durableStatsPatch(target.author.address, !target.author.isGuest, authorBefore, authorAfter)]
        }
        try {
          await options.state.beginDurableMutation(mutation)
          await options.state.applyDurableMutation(mutation)
        } catch (error) {
          if (error instanceof StorageCapacityError) {
            await sendError(address, 'server-busy', data.requestId)
            return
          }
          if (!(error instanceof StorageUnavailableError)) console.error('[storage] reply mutation failed', error)
          await sendError(address, 'storage-unavailable', data.requestId)
          return
        }
        const request = {
          type: 'posted' as const,
          data: posted,
          durable: false,
          authoredPost,
          mutationId: mutation.id
        }
        cacheSet(completedRequests, idempotencyKey, key, request)
        if (!(await checkpointOrError(address, generation, data.requestId, mutation.id))) return
        request.durable = true
        if (!isCurrentSession(address, generation)) return
        await sendTo(address, 'posted', posted)
      })
      if (replyCommit && 'retryAfterRollover' in replyCommit) {
        if (!(await rolloverOrError(address, generation, replyCommit.retryAfterRollover, data.requestId))) return
        return handlePost(data, address)
      }
      return
    }
    const phrase = DECK.find((candidate) => candidate.id === data.phraseId)
    if (!validWireString(data.requestId) || !phrase) {
      await sendError(address, 'invalid-post', data.requestId)
      return
    }
    if (storedReplyRequest) {
      await sendError(address, 'invalid-post', data.requestId)
      return
    }

    const id = charadeId(key, data.requestId)
    const existing = options.state.getCharade(id)
    if (existing) {
      if (!storedCharadeMatchesPost(existing, key, authoredPost)) {
        await sendError(address, 'invalid-post', data.requestId)
        return
      }
      const look = looks.get(key)
      const stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
      if (!isCurrentSession(address, generation)) return
      const posted: PostedPayload = {
        requestId: data.requestId,
        charadeId: id,
        ...(existing.recipient ? { recipient: existing.recipient } : {}),
        daily: { ...options.state.getDaily(stats) },
        revision: stats.revision,
        stampAwarded: false,
        ...progressFor(stats),
        titleUnlocked: false
      }
      const request = { type: 'posted' as const, data: posted, durable: false, authoredPost }
      cacheSet(completedRequests, idempotencyKey, key, request)
      if (!(await checkpointOrError(address, generation, data.requestId))) return
      request.durable = true
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'posted', posted)
      return
    }
    const postShow = currentShow
    if (
      !postShow ||
      !postShow.primaryPhraseIds.has(phrase.id) ||
      !isAllowedPerformance(phrase, data.emotes) ||
      !isDecodablePerformance(phrase, data.emotes, postShow.decoyDeck)
    ) {
      await sendError(address, 'invalid-post', data.requestId)
      return
    }

    function latestPostAt() {
      const persisted = options.state
        .getPlayerCharades()
        .filter((charade) => canonicalAddress(charade.author.address) === key)
        .reduce<number | null>(
          (latest, charade) => (latest === null ? charade.createdAt : Math.max(latest, charade.createdAt)),
          null
        )
      const session = lastPosts.get(key)
      if (persisted === null) return session ?? null
      return session === undefined ? persisted : Math.max(session, persisted)
    }

    let recipientLook: Look | null = null
    if (data.recipient !== undefined) {
      const sender = looks.get(key)
      if (!sender || sender.isGuest || !STABLE_ADDRESS.test(sender.address)) {
        await sendError(address, 'mail-guest', data.requestId)
        return
      }
      if (!STABLE_ADDRESS.test(data.recipient) || canonicalAddress(data.recipient) === key) {
        await sendError(address, 'mail-recipient-invalid', data.requestId)
        return
      }
      recipientLook = options.state.getKnownRecipient(data.recipient)
      if (!recipientLook || recipientLook.isGuest || !STABLE_ADDRESS.test(recipientLook.address)) {
        await sendError(address, 'mail-recipient-unknown', data.requestId)
        return
      }
    }

    const beforeLookTime = now()
    const previousPost = latestPostAt()
    if (previousPost !== null && beforeLookTime - previousPost < AUTHOR_COOLDOWN_SECONDS * 1000) {
      await sendError(address, 'post-rate-limited', data.requestId)
      return
    }

    const look = await waitForLook(address)
    if (!look) {
      if (isCurrentSession(address, generation)) await sendError(address, 'look-not-ready', data.requestId)
      return
    }
    if (!isCurrentSession(address, generation)) return
    if (look.isGuest) {
      await sendError(address, recipientLook ? 'mail-guest' : 'post-guest', data.requestId)
      return
    }
    if (recipientLook && (look.isGuest || !STABLE_ADDRESS.test(look.address))) {
      await sendError(address, 'mail-guest', data.requestId)
      return
    }
    const existingAfterSnapshot = options.state.getCharade(id)
    if (existingAfterSnapshot) {
      if (!storedCharadeMatchesPost(existingAfterSnapshot, key, authoredPost)) {
        await sendError(address, 'invalid-post', data.requestId)
        return
      }
      const stats = await options.state.getOrCreateStats(key, look.name, !look.isGuest)
      if (!isCurrentSession(address, generation)) return
      const replay = cacheGet(completedRequests, idempotencyKey)
      if (replay) {
        if (!replay.durable) {
          if (!(await checkpointOrError(address, generation, data.requestId))) return
          replay.durable = true
        }
        if (!isCurrentSession(address, generation)) return
        await sendTo(address, replay.type, replay.data)
        return
      }
      const posted: PostedPayload = {
        requestId: data.requestId,
        charadeId: id,
        ...(existingAfterSnapshot.recipient ? { recipient: existingAfterSnapshot.recipient } : {}),
        daily: { ...options.state.getDaily(stats) },
        revision: stats.revision,
        stampAwarded: false,
        ...progressFor(stats),
        titleUnlocked: false
      }
      const request = { type: 'posted' as const, data: posted, durable: false, authoredPost }
      cacheSet(completedRequests, idempotencyKey, key, request)
      if (!(await checkpointOrError(address, generation, data.requestId))) return
      request.durable = true
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'posted', posted)
      return
    }
    const currentTime = now()
    const lastPost = latestPostAt()
    if (lastPost !== null && currentTime - lastPost < AUTHOR_COOLDOWN_SECONDS * 1000) {
      await sendError(address, 'post-rate-limited', data.requestId)
      return
    }
    const charade: Charade = {
      v: STORAGE_SCHEMA_VERSION,
      id,
      author: look,
      phraseId: phrase.id,
      emotes: [data.emotes[0], data.emotes[1], data.emotes[2]],
      createdAt: currentTime,
      guesses: { total: 0, correct: 0 },
      lastGuessAt: 0,
      isHouse: false,
      touringConsent: recipientLook ? false : data.touringConsent,
      ...(recipientLook ? { recipient: recipientLook.address } : {})
    }
    let stats: Awaited<ReturnType<GhostlightState['getOrCreateStats']>>
    let recipientStats: Awaited<ReturnType<GhostlightState['getOrCreateStats']>> | null
    try {
      stats = await options.state.getOrCreateStats(key, look.name, !look.isGuest)
      recipientStats = recipientLook
        ? await options.state.getOrCreateStats(recipientLook.address, recipientLook.name, true)
        : null
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] post prerequisites failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable', data.requestId)
      return
    }
    if (
      !(await requireCurrentPrimary(
        address,
        generation,
        postShow.policy.showKey,
        phrase.id,
        'invalid-post',
        data.requestId
      ))
    ) {
      return
    }

    const postCommit = await serializeMutation(async () => {
      if (!isCurrentSession(address, generation)) return
      if (!(await reconcileActiveDurableMutationOrError(address, generation, data.requestId))) return
      if (!isCurrentSession(address, generation)) return
      if (currentShow?.policy.showKey !== postShow.policy.showKey || !currentShow.primaryPhraseIds.has(phrase.id)) {
        await sendError(address, 'invalid-post', data.requestId)
        return
      }
      const mutationTime = now()
      if (dayKey(mutationTime) > currentDay) return { retryAfterRollover: mutationTime }
      const latest = latestPostAt()
      if (latest !== null && mutationTime - latest < AUTHOR_COOLDOWN_SECONDS * 1_000) {
        await sendError(address, 'post-rate-limited', data.requestId)
        return
      }
      if (options.state.getCharade(id)) {
        await sendError(address, 'invalid-post', data.requestId)
        return
      }
      const updatedCharade: Charade = { ...charade, createdAt: mutationTime }
      if (!options.state.canUpsertCharade(updatedCharade)) {
        await sendError(address, 'server-busy', data.requestId)
        return
      }
      const statsBefore = cloneStats(stats)
      const statsAfter = cloneStats(stats)
      const recipientBefore = recipientStats ? cloneStats(recipientStats) : null
      const recipientAfter = recipientStats ? cloneStats(recipientStats) : null
      const previousTitle = progressFor(statsAfter).title
      let stampAwarded = false
      if (!recipientLook) {
        if (!statsAfter.authored.includes(id)) {
          statsAfter.authored.push(id)
          statsAfter.authoredCount = Math.min(statsAfter.authoredCount + 1, WIRE_INT_MAX)
        }
        stampAwarded = options.state.recordDailyAuthor(statsAfter)
        options.state.advanceProgressRevision(statsAfter)
      }
      statsAfter.lastSeenAt = mutationTime
      const progress = progressFor(statsAfter)
      const titleUnlocked = progress.title !== previousTitle && progress.title !== ''
      if (recipientAfter && recipientLook) {
        recipientAfter.pending.mail = Math.min(recipientAfter.pending.mail + 1, WIRE_INT_MAX)
        recipientAfter.lastSeenAt = mutationTime
        options.state.getPlayerProgress(recipientAfter)
      }
      const posted: PostedPayload = {
        requestId: data.requestId,
        charadeId: id,
        ...(recipientLook ? { recipient: recipientLook.address } : {}),
        daily: { ...options.state.getDaily(statsAfter) },
        revision: statsAfter.revision,
        stampAwarded,
        ...progress,
        titleUnlocked
      }
      const mutation: DurableMutation = {
        v: 1,
        id: idempotencyKey,
        owner: key,
        requestId: data.requestId,
        createdAt: mutationTime,
        fingerprint: postFingerprint(authoredPost),
        response: { type: 'posted', data: posted as unknown as Record<string, unknown> },
        charade: updatedCharade,
        stats: [
          durableStatsPatch(key, !look.isGuest, statsBefore, statsAfter),
          ...(recipientBefore && recipientAfter && recipientLook
            ? [durableStatsPatch(recipientLook.address, true, recipientBefore, recipientAfter)]
            : [])
        ]
      }
      try {
        await options.state.beginDurableMutation(mutation)
        await options.state.applyDurableMutation(mutation)
      } catch (error) {
        if (error instanceof StorageCapacityError) {
          await sendError(address, 'server-busy', data.requestId)
          return
        }
        if (!(error instanceof StorageUnavailableError)) console.error('[storage] post mutation failed', error)
        await sendError(address, 'storage-unavailable', data.requestId)
        return
      }
      lastPosts.set(key, mutationTime)
      const request = {
        type: 'posted' as const,
        data: posted,
        durable: false,
        authoredPost,
        mutationId: mutation.id
      }
      cacheSet(completedRequests, idempotencyKey, key, request)
      if (!(await checkpointOrError(address, generation, data.requestId, mutation.id))) return
      request.durable = true
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'posted', posted)
      if (!recipientLook && titleUnlocked) await broadcastTitleUnlock(address, progress.title)
      if (!recipientLook) await refreshBoards()
    })
    if (postCommit && 'retryAfterRollover' in postCommit) {
      if (!(await rolloverOrError(address, generation, postCommit.retryAfterRollover, data.requestId))) return
      return handlePost(data, address)
    }
  }

  async function handleReact(data: ReactPayload, address: string) {
    await ready
    const generation = sessionGeneration(address)
    if (generation === null) {
      await sendError(address, 'protocol-required')
      return
    }
    if (!(await ensureWelcome(address, generation))) return
    if (!(await rolloverOrError(address, generation))) return
    if (!isCurrentSession(address, generation)) return
    if (!VALID_REACTION_KINDS.has(data.kind)) {
      await sendError(address, 'invalid-reaction')
      return
    }
    const sender = canonicalAddress(address)
    if (looks.get(sender)?.isGuest) {
      await sendError(address, 'reaction-guest')
      return
    }
    const activeRound = rounds.current
    if (!activeRound || rounds.isSettled || activeDecoders.has(sender)) {
      await sendError(address, 'invalid-reaction')
      return
    }
    const currentTime = now()
    const previousReaction = lastReactions.get(sender)
    if (previousReaction !== undefined && currentTime - previousReaction < REACTION_COOLDOWN_MILLISECONDS) {
      await sendError(address, 'reaction-rate-limited')
      return
    }
    for (const [reactor, lastReaction] of lastReactions) {
      if (currentTime - lastReaction >= REACTION_COOLDOWN_MILLISECONDS) lastReactions.delete(reactor)
    }
    lastReactions.set(sender, currentTime)
    const recipients = [...looks.values()]
      .filter((look) => canonicalAddress(look.address) !== sender)
      .map((look) => look.address)
    if (!isCurrentSession(address, generation)) return
    if (recipients.length > 0) await options.send('react', { kind: data.kind }, recipients)
  }

  return {
    rounds,
    handleEnter,
    handleLeave,
    handleHello: (data: HelloPayload, address: string) =>
      withRequestAdmission(address, 'hello', data, () => handleHello(data, address)),
    handlePing: (data: PingPayload, address: string) =>
      withRequestAdmission(address, 'ping', data, () => handlePing(data, address)),
    handleNextCharade: (data: NextCharadePayload, address: string) =>
      withRequestAdmission(address, 'next-charade', data, async () => {
        if (!validWireString(data.requestId)) return handleNextCharade(data, address)
        return serializeRequest(`${canonicalAddress(address)}:decode`, () => handleNextCharade(data, address))
      }),
    handleGuess: (data: GuessPayload, address: string) =>
      withRequestAdmission(address, 'guess', data, async () => {
        if (!validWireString(data.requestId)) return handleGuess(data, address, null)
        return serializeRequest(`${canonicalAddress(address)}:decode`, () => handleGuess(data, address, null))
      }),
    handleRoundGuess: (data: RoundGuessPayload, address: string) =>
      withRequestAdmission(address, 'guess', data, async () => {
        if (!validWireString(data.requestId)) return handleGuess(data, address, data.roundId)
        return serializeRequest(`${canonicalAddress(address)}:decode`, () => handleGuess(data, address, data.roundId))
      }),
    handlePost: (data: PostPayload, address: string) =>
      withRequestAdmission(address, 'post', data, async () => {
        if (!validWireString(data.requestId)) return handlePost(data, address)
        return serializeRequest(`${canonicalAddress(address)}:post`, () => handlePost(data, address))
      }),
    handleReact: (data: ReactPayload, address: string) =>
      withRequestAdmission(address, 'reaction', data, () => handleReact(data, address)),
    resourceCounts: () => ({
      present: present.size,
      sessionGenerations: sessionGenerations.size,
      servedAnswers: servedAnswers.size,
      retryStates: [...servedAnswers.values()].filter((served) => served.retry !== null).length,
      activeDecoders: activeDecoders.size,
      completedRequests: completedRequests.size,
      nextRequests: nextRequests.size,
      outstandingRequests: [...outstandingRequests.values()].reduce((total, count) => total + count, 0),
      requestBuckets: requestBuckets.size
    }),
    mutationQueueDepth: () => queuedMutations
  }
}

const INSTANCE_ID = String(Date.now())

export function runServerHandler(handler: Promise<void>) {
  void handler.catch((error: unknown) => console.error('[protocol] handler failed', error))
}

export function startServer() {
  const hydration = gameState.hydrate()
  startFlushLoop()
  const protocol = createServerProtocol({
    state: gameState,
    send: (type, data, to) => room.send(type as keyof typeof Messages, data as never, to ? { to } : undefined),
    snapshotLook: snapshotServerLook,
    ready: hydration,
    flush: flushNow,
    instanceId: INSTANCE_ID
  })

  const from = (context?: { from: string }) => context?.from
  room.onMessage('hello', (data, context) => {
    const address = from(context)
    if (address) runServerHandler(protocol.handleHello(data, address))
  })
  room.onMessage('ping', (data, context) => {
    const address = from(context)
    if (address) runServerHandler(protocol.handlePing(data, address))
  })
  room.onMessage('nextCharade', (data, context) => {
    const address = from(context)
    if (address) runServerHandler(protocol.handleNextCharade(data, address))
  })
  room.onMessage('guess', (data, context) => {
    const address = from(context)
    if (address) runServerHandler(protocol.handleGuess(data, address))
  })
  room.onMessage('post', (data, context) => {
    const address = from(context)
    if (address) runServerHandler(protocol.handlePost(data, address))
  })
  room.onMessage('roundGuess', (data, context) => {
    const address = from(context)
    if (address) runServerHandler(protocol.handleRoundGuess(data, address))
  })
  room.onMessage('react', (data, context) => {
    const address = from(context)
    if (address) runServerHandler(protocol.handleReact(data, address))
  })

  onEnterScene((player) => runServerHandler(protocol.handleEnter(player.userId)))
  onLeaveScene((address) => runServerHandler(protocol.handleLeave(address)))
}
