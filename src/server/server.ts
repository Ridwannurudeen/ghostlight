import { AvatarBase, AvatarEquippedData, PlayerIdentityData, engine } from '@dcl/sdk/ecs'
import { onEnterScene, onLeaveScene } from '@dcl/sdk/src/players'
import { AUTHOR_COOLDOWN_SECONDS, PROTOCOL_VERSION, WIRE_INT_MAX, themeForTimestamp } from '../shared/config'
import { DECK, EMOTE_VOCABULARY } from '../shared/deck'
import { normalizePlayerName } from '../shared/i18n'
import { Messages, SPECTATOR_REACTION_KINDS, room } from '../shared/messages'
import { chooseCharadeFor, chooseHouseCharade, pickDecoys, shuffleSeeded } from '../shared/pick'
import type { Charade, Look, PlayerProgress, PlayerStats, ShowSet } from '../shared/types'
import { SHOW_SET_SIZE, STORAGE_SCHEMA_VERSION } from '../shared/types'
import { LiveRounds } from './rounds'
import { GhostlightState, dayKey, gameState } from './state'
import { StorageCapacityError, StorageUnavailableError, flushNow, startFlushLoop } from './storage'

type HelloPayload = { displayName: string; isGuest: boolean; protocolVersion: number }
type PingPayload = { seq: number }
type NextCharadePayload = { requestId: string; exclude: string[] }
type GuessPayload = { charadeId: string; answerIndex: number; requestId: string; spotlight?: boolean }
type PostPayload = { phraseId: string; emotes: string[]; requestId: string; replyTo?: string; recipient?: string }
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

type PreparedCharade = {
  charade: Charade
  publicId: string
  answers: string[]
  answerIds: string[]
  correctIndex: number
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

function emptyShowSet(): ShowSet {
  return { round: 0, score: 0, streak: 0, bestStreak: 0, understood: 0 }
}

function showSetFor(stats: PlayerStats) {
  if (!stats.showSet) stats.showSet = emptyShowSet()
  return stats.showSet
}

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
  const ready = options.ready ?? Promise.resolve()
  const checkpoint = options.flush ?? (async () => {})
  const instanceId = options.instanceId ?? String(now())
  const looks = new Map<string, Look>()
  const present = new Set<string>()
  const sessionGenerations = new Map<string, number>()
  let nextSessionGeneration = 0
  const welcomed = new Set<string>()
  const negotiated = new Set<string>()
  const welcomePromises = new Map<string, Promise<boolean>>()
  const cancelledWelcomePromises = new WeakSet<Promise<boolean>>()
  const servedAnswers = new Map<string, PreparedCharade>()
  const activeDecoders = new Set<string>()
  const lastAuthors = new Map<string, string>()
  const lastPosts = new Map<string, number>()
  const lastReactions = new Map<string, number>()
  const completedRequests = new Map<
    string,
    CachedRequest<{
      type: 'reveal' | 'posted'
      data: RevealPayload | PostedPayload
      durable: boolean
    }>
  >()
  const nextRequests = new Map<string, CachedRequest<Promise<PreparedCharade>>>()
  const activeRequestHandlers = new Map<string, Promise<void>>()
  const outstandingRequests = new Map<string, number>()
  const requestBuckets = new Map<string, RateBucket>()
  const rounds = new LiveRounds((type, data) => options.send(type, data), now, options.roundDurationMilliseconds)
  let currentDay = dayKey(now())
  let rolloverPromise: Promise<void> | null = null
  let houseSequence = 0
  let answerSequence = 0
  const serverSecret = `${now()}:${random()}:${random()}`
  let activeRoundCharade: PreparedCharade | null = null

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

  async function sendError(address: string, code: string) {
    await sendTo(address, 'error', { code })
  }

  async function checkpointOrError(address: string, generation: number) {
    try {
      await checkpoint()
      options.state.evictInactiveStats(new Set(looks.keys()))
      return true
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] checkpoint failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable')
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

  async function rolloverIfNeeded() {
    const nextDay = dayKey(now())
    if (nextDay === currentDay) return
    if (rolloverPromise) return rolloverPromise
    rolloverPromise = (async () => {
      options.state.rollover(now())
      await checkpoint()
      currentDay = nextDay
      const sessions = [...looks].map(([address, look]) => ({ address, look, generation: sessionGeneration(address) }))
      for (const { address, look, generation } of sessions) {
        if (generation === null) continue
        const stats = await options.state.getOrCreateStats(address, look.name, !look.isGuest)
        if (!isCurrentSession(address, generation)) continue
        const daily = { ...options.state.getDaily(stats) }
        await sendTo(look.address, 'ready', readyPayload())
        if (!isCurrentSession(address, generation)) continue
        await sendTo(look.address, 'progress', {
          daily,
          revision: stats.revision,
          ...progressFor(stats)
        })
        if (!isCurrentSession(address, generation)) continue
        await sendBoards(look.address, generation)
      }
    })().finally(() => {
      rolloverPromise = null
    })
    return rolloverPromise
  }

  async function rolloverOrError(address: string, generation: number) {
    try {
      await rolloverIfNeeded()
      return true
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] rollover failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable')
      return false
    }
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

  function readyPayload() {
    const timestamp = now()
    const theme = themeForTimestamp(timestamp)
    return { instanceId, serverTime: timestamp, theme: theme.id, themeLabel: theme.label }
  }

  function selectRoundCharade() {
    const presentAddresses = new Set([...looks.keys()])
    const seen = new Set<string>()
    for (const address of presentAddresses) {
      for (const charadeId of options.state.playerStats.get(address)?.seen ?? []) seen.add(charadeId)
    }
    const previous = activeRoundCharade?.charade.id
    const theme = themeForTimestamp(now()).id
    let selected: Charade | null = null
    for (const charade of options.state.getPool()) {
      if (
        !DECK.some((phrase) => phrase.id === charade.phraseId) ||
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
    return selected ?? chooseHouseCharade(`round:${currentDay}:${previous ?? ''}:${houseSequence++}`, theme)
  }

  function ensureRound() {
    if (!rounds.isLive) return null
    const current = rounds.current
    if (current && !rounds.isSettled && activeRoundCharade?.publicId === current.charadeId) return activeRoundCharade
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
    const selected = selectRoundCharade()
    activeRoundCharade =
      prepareCharade(selected) ??
      prepareCharade(chooseHouseCharade(`invalid-round:${houseSequence++}`, themeForTimestamp(now()).id))
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

    const previousVisitors = [...options.state.recentVisitors]
    const stats = await options.state.getOrCreateStats(key, look.name, !look.isGuest)
    if (welcomePromises.get(key) !== owner || !isCurrentSession(key, generation)) return false
    looks.set(key, look)
    options.state.touchVisitor(look)
    const rankIndex = options.state.boards.decoders.findIndex((row) => canonicalAddress(row.address) === key)
    const pending = { ...stats.pending }
    pending.mail =
      !look.isGuest && STABLE_ADDRESS.test(look.address)
        ? options.state.countMailForRecipient(look.address, stats.seen)
        : 0
    const progress = progressFor(stats)

    options.state.consumePending(key, !look.isGuest)
    try {
      await checkpoint()
    } catch (error) {
      if (welcomePromises.get(key) === owner && isCurrentSession(key, generation)) {
        stats.pending = pending
        options.state.saveStats(key, !look.isGuest)
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
      })
    welcomePromises.set(key, pending)
    return pending
  }

  async function ensureWelcome(address: string, generation: number) {
    const key = canonicalAddress(address)
    if (!isCurrentSession(key, generation)) return false
    if (!(await requireNegotiated(address))) return false
    if (welcomed.has(key)) return true
    try {
      const result = await welcome(address, generation)
      if (!result && isCurrentSession(address, generation)) await sendError(address, 'look-not-ready')
      return result
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] welcome failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable')
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
    const look = looks.get(key)
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
    let failure: unknown
    try {
      if (look) {
        options.state.touchVisitor(look)
        options.state.saveStats(key, !look.isGuest)
      }
      await checkpoint()
    } catch (error) {
      failure = error
    } finally {
      if (!present.has(key) && sessionGenerations.get(key) === leavingGeneration) {
        sessionGenerations.delete(key)
        options.state.evictStats(key)
      }
    }
    if (failure !== undefined) console.error('[storage] leave persistence failed', failure)
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
    if (!(await rolloverOrError(address, generation))) return
    if (!isCurrentSession(address, generation)) return
    await sendTo(address, 'ready', readyPayload())
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
    if (negotiated.has(canonicalAddress(address)) && !(await rolloverOrError(address, generation))) return
    if (!isCurrentSession(address, generation)) return
    await sendTo(address, 'pong', { seq: data.seq })
    if (negotiated.has(canonicalAddress(address)) && !welcomed.has(canonicalAddress(address))) {
      await ensureWelcome(address, generation)
    }
  }

  function prepareCharade(charade: Charade): PreparedCharade | null {
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)
    if (!phrase) return null
    const privateSeed = `${serverSecret}:${++answerSequence}:${random()}`
    const decoys = pickDecoys(phrase.id, charade.emotes, DECK, privateSeed)
    if (decoys.length !== 2) return null
    const shuffled = shuffleSeeded([phrase, decoys[0], decoys[1]], `${privateSeed}:answers`)
    return {
      charade,
      publicId: charade.isHouse ? `house-${hashText(privateSeed, 0)}${hashText(privateSeed, 0x9e3779b9)}` : charade.id,
      answers: shuffled.map((answer) => answer.text),
      answerIds: shuffled.map((answer) => answer.id),
      correctIndex: shuffled.findIndex((answer) => answer.id === phrase.id)
    }
  }

  async function sendCharade(address: string, generation: number, requestId: string, prepared: PreparedCharade) {
    const { charade } = prepared
    const addressKey = canonicalAddress(address)
    const cachedAuthorStats = options.state.playerStats.get(canonicalAddress(charade.author.address))
    const authorTitle = charade.isHouse || !cachedAuthorStats ? '' : progressFor(cachedAuthorStats).title
    const showSet = options.state.playerStats.get(addressKey)?.showSet ?? emptyShowSet()
    const setRound = Math.min(showSet.round + 1, SHOW_SET_SIZE)
    if (!isCurrentSession(address, generation)) return false
    for (const answerKey of servedAnswers.keys()) {
      if (answerKey.startsWith(`${addressKey}:`)) servedAnswers.delete(answerKey)
    }
    servedAnswers.set(`${addressKey}:${prepared.publicId}`, prepared)
    activeDecoders.add(addressKey)
    lastAuthors.set(addressKey, charade.author.address)
    const authorLook = withoutLastSeen(charade.author)
    await sendTo(address, 'charade', {
      requestId,
      id: prepared.publicId,
      authorName: authorLook.name,
      authorAddress: authorLook.address,
      look: authorLook,
      emotes: [...charade.emotes],
      answers: prepared.answers,
      answerIds: prepared.answerIds,
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
    return true
  }

  async function handleNextCharade(data: NextCharadePayload, address: string) {
    await ready
    if (
      !validWireString(data.requestId) ||
      data.exclude.length > MAX_EXCLUDE_IDS ||
      data.exclude.some((id) => !validWireString(id))
    ) {
      await sendError(address, 'invalid-next-charade')
      return
    }
    const generation = sessionGeneration(address)
    if (generation === null) {
      await sendError(address, 'protocol-required')
      return
    }
    if (!(await ensureWelcome(address, generation))) return
    if (!(await rolloverOrError(address, generation))) return
    if (!isCurrentSession(address, generation)) return
    const key = canonicalAddress(address)
    const selectionKey = `${key}:${data.requestId}`
    let selection = cacheGet(nextRequests, selectionKey)
    if (!selection) {
      selection = (async () => {
        const look = looks.get(key)
        const stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
        if (!stats.showSet || stats.showSet.round >= SHOW_SET_SIZE) {
          stats.showSet = emptyShowSet()
          options.state.saveStats(key, !(look?.isGuest ?? true))
        }
        if (!isCurrentSession(address, generation)) {
          return prepareCharade(chooseHouseCharade(`${key}:stale:${houseSequence++}`, themeForTimestamp(now()).id))!
        }
        const mail =
          look && !look.isGuest && STABLE_ADDRESS.test(look.address)
            ? options.state.getMailForRecipient(look.address, stats.seen, data.exclude)
            : null
        if (mail) {
          const preparedMail = prepareCharade(mail)
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

        const liveCharade = ensureRound()
        const requesterGuessed = rounds.current?.guessed.includes(key) ?? false
        const selected =
          (rounds.isParticipant(key) && !requesterGuessed ? liveCharade : null) ??
          prepareCharade(
            chooseCharadeFor(
              key,
              [...stats.seen, ...data.exclude],
              options.state.getPool().filter((charade) => DECK.some((phrase) => phrase.id === charade.phraseId)),
              lastAuthors.get(key),
              themeForTimestamp(now()).id
            ) ?? chooseHouseCharade(`${key}:${data.requestId}:${houseSequence++}`, themeForTimestamp(now()).id)
          )
        return (
          selected ??
          prepareCharade(chooseHouseCharade(`${key}:invalid:${houseSequence++}`, themeForTimestamp(now()).id))!
        )
      })()
      cacheSet(nextRequests, selectionKey, key, selection)
      void selection.catch(() => {
        if (cacheGet(nextRequests, selectionKey) === selection) nextRequests.delete(selectionKey)
      })
    }
    const prepared = await selection
    if (!isCurrentSession(address, generation)) return
    if (rounds.playerCount === 1 && !rounds.current && prepared.charade.recipient === undefined) {
      activeRoundCharade = prepared
    }
    await sendCharade(address, generation, data.requestId, prepared)
  }

  function requestKey(address: string, kind: string, requestId: string) {
    return `${canonicalAddress(address)}:${kind}:${requestId}`
  }

  async function handleGuess(data: GuessPayload, address: string) {
    await ready
    const generation = sessionGeneration(address)
    if (generation === null) {
      await sendError(address, 'protocol-required')
      return
    }
    if (!(await ensureWelcome(address, generation))) return
    const key = canonicalAddress(address)
    if (
      !validWireString(data.requestId) ||
      !validWireString(data.charadeId) ||
      !Number.isInteger(data.answerIndex) ||
      data.answerIndex < 0 ||
      data.answerIndex > 2 ||
      (data.spotlight !== undefined && typeof data.spotlight !== 'boolean')
    ) {
      await sendError(address, 'invalid-guess')
      return
    }
    const idempotencyKey = requestKey(key, 'guess', data.requestId)
    const completed = cacheGet(completedRequests, idempotencyKey)
    if (completed) {
      if (!completed.durable) {
        if (!(await checkpointOrError(address, generation))) return
        completed.durable = true
      }
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, completed.type, completed.data)
      return
    }
    const servedKey = `${key}:${data.charadeId}`
    const served = servedAnswers.get(servedKey)
    if (!served) {
      await sendError(address, 'charade-not-served')
      return
    }
    const { charade } = served
    const look = looks.get(key)
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)
    if (!phrase) {
      servedAnswers.delete(servedKey)
      await sendError(address, 'invalid-charade')
      return
    }
    const countable =
      !charade.isHouse && charade.recipient === undefined && !(look?.isGuest ?? true) && !charade.author.isGuest
    const notifyAuthor = !charade.isHouse && !(look?.isGuest ?? true) && !charade.author.isGuest
    let stats: Awaited<ReturnType<GhostlightState['getOrCreateStats']>>
    let authorStats: Awaited<ReturnType<GhostlightState['getOrCreateStats']>> | null
    try {
      stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
      authorStats = notifyAuthor
        ? await options.state.getOrCreateStats(charade.author.address, charade.author.name, true)
        : null
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) console.error('[storage] guess prerequisites failed', error)
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable')
      return
    }
    if (!isCurrentSession(address, generation)) return
    if (!charade.isHouse && stats.seen.includes(charade.id)) {
      await sendError(address, 'already-guessed')
      return
    }
    const previousTitle = progressFor(stats).title
    const spotlight = data.spotlight === true

    servedAnswers.delete(servedKey)
    activeDecoders.delete(key)
    const roundIsActive = rounds.current?.charadeId === data.charadeId && rounds.isLive && rounds.isParticipant(key)
    const correct = data.answerIndex === served.correctIndex
    if (roundIsActive) rounds.guess(key, data.charadeId, !charade.isHouse && correct)

    let stampAwarded = false
    const showSet = showSetFor(stats)
    const scoreDelta = correct ? (spotlight ? 200 : 100) : spotlight ? -100 : 0
    showSet.round = Math.min(showSet.round + 1, SHOW_SET_SIZE)
    showSet.score = Math.max(0, Math.min(showSet.score + scoreDelta, SHOW_SET_SIZE * 200))
    if (correct) {
      showSet.streak = Math.min(showSet.streak + 1, SHOW_SET_SIZE)
      showSet.bestStreak = Math.max(showSet.bestStreak, showSet.streak)
      showSet.understood = Math.min(showSet.understood + 1, SHOW_SET_SIZE)
    } else {
      showSet.streak = 0
    }
    if (!charade.isHouse) {
      stats.seen.push(charade.id)
    }
    if (countable) {
      stats.decoded = Math.min(stats.decoded + 1, WIRE_INT_MAX)
      stats.correct = Math.min(stats.correct + (correct ? 1 : 0), WIRE_INT_MAX)
      stampAwarded = options.state.recordDailyDecode(stats)
      options.state.recordGuess(charade.id, correct)
      options.state.recordDecoder(key, stats.name, correct)
      options.state.advanceProgressRevision(stats)
    }
    if (authorStats) {
      authorStats!.pending.triedYou = Math.min(authorStats!.pending.triedYou + 1, WIRE_INT_MAX)
      authorStats!.pending.gotYou = Math.min(authorStats!.pending.gotYou + (correct ? 1 : 0), WIRE_INT_MAX)
      options.state.saveStats(charade.author.address, true)
    }
    options.state.saveStats(key, !(look?.isGuest ?? true))
    const progress = progressFor(stats)
    const titleUnlocked = progress.title !== previousTitle && progress.title !== ''

    const updated = options.state.getCharade(charade.id) ?? charade
    const reveal: RevealPayload = {
      requestId: data.requestId,
      charadeId: data.charadeId,
      correct,
      phraseId: phrase.id,
      phrase: phrase.text,
      stats: { ...updated.guesses },
      yourScore: stats.correct,
      daily: { ...options.state.getDaily(stats) },
      revision: stats.revision,
      stampAwarded,
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
    const request = { type: 'reveal' as const, data: reveal, durable: false }
    cacheSet(completedRequests, idempotencyKey, key, request)
    if (!(await checkpointOrError(address, generation))) return
    request.durable = true
    if (!isCurrentSession(address, generation)) return
    await sendTo(address, 'reveal', reveal)
    if (titleUnlocked) await broadcastTitleUnlock(address, progress.title)
    if (countable) await refreshBoards()
  }

  async function handlePost(data: PostPayload, address: string) {
    await ready
    const generation = sessionGeneration(address)
    if (generation === null) {
      await sendError(address, 'protocol-required')
      return
    }
    if (!(await ensureWelcome(address, generation))) return
    if (options.state.isReadOnly) {
      await sendError(address, 'server-busy')
      return
    }
    const key = canonicalAddress(address)
    if (!validWireString(data.requestId)) {
      await sendError(address, data.replyTo === undefined ? 'invalid-post' : 'invalid-reply')
      return
    }
    const idempotencyKey = requestKey(key, 'post', data.requestId)
    const completed = cacheGet(completedRequests, idempotencyKey)
    if (completed) {
      if (!completed.durable) {
        if (!(await checkpointOrError(address, generation))) return
        completed.durable = true
      }
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, completed.type, completed.data)
      return
    }
    const welcomedLook = looks.get(key)
    if (!welcomedLook || welcomedLook.isGuest) {
      await sendError(address, data.recipient !== undefined ? 'mail-guest' : 'post-guest')
      return
    }
    if (data.replyTo !== undefined) {
      if (
        !validWireString(data.requestId) ||
        !validWireString(data.replyTo) ||
        data.recipient !== undefined ||
        !data.phraseId ||
        data.emotes.length !== 3 ||
        data.emotes.some((emote) => !EMOTES.has(emote))
      ) {
        await sendError(address, 'invalid-reply')
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
        await sendError(address, 'reply-not-eligible')
        return
      }
      const existingReply = target.reply
      if (existingReply) {
        if (canonicalAddress(existingReply.address) !== key) {
          await sendError(address, 'reply-taken')
          return
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
        const request = { type: 'posted' as const, data: posted, durable: false }
        cacheSet(completedRequests, idempotencyKey, key, request)
        if (!(await checkpointOrError(address, generation))) return
        request.durable = true
        if (!isCurrentSession(address, generation)) return
        await sendTo(address, 'posted', posted)
        return
      }
      const replyLook = await waitForLook(address)
      if (!replyLook) {
        if (isCurrentSession(address, generation)) await sendError(address, 'look-not-ready')
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
        if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable')
        return
      }
      if (!isCurrentSession(address, generation)) return
      let attached: boolean
      try {
        attached = options.state.attachReply(target.id, {
          address: replyLook.address,
          name: replyLook.name,
          look: replyLook,
          emotes: [data.emotes[0], data.emotes[1], data.emotes[2]],
          createdAt: now()
        })
      } catch (error) {
        if (!(error instanceof StorageCapacityError)) throw error
        await sendError(address, 'server-busy')
        return
      }
      if (!attached) {
        const winner = options.state.getCharade(target.id)?.reply
        if (!winner || canonicalAddress(winner.address) !== key) {
          await sendError(address, 'reply-taken')
          return
        }
      } else {
        authorStats.pending.replies = Math.min(authorStats.pending.replies + 1, WIRE_INT_MAX)
        options.state.saveStats(target.author.address, !target.author.isGuest)
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
      const request = { type: 'posted' as const, data: posted, durable: false }
      cacheSet(completedRequests, idempotencyKey, key, request)
      if (!(await checkpointOrError(address, generation))) return
      request.durable = true
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'posted', posted)
      return
    }
    const phrase = DECK.find((candidate) => candidate.id === data.phraseId)
    if (
      !validWireString(data.requestId) ||
      !phrase ||
      data.emotes.length !== 3 ||
      data.emotes.some((emote) => !EMOTES.has(emote))
    ) {
      await sendError(address, 'invalid-post')
      return
    }

    const id = charadeId(key, data.requestId)
    const existing = options.state.getCharade(id)
    if (existing) {
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
      const request = { type: 'posted' as const, data: posted, durable: false }
      cacheSet(completedRequests, idempotencyKey, key, request)
      if (!(await checkpointOrError(address, generation))) return
      request.durable = true
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'posted', posted)
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
        await sendError(address, 'mail-guest')
        return
      }
      if (!STABLE_ADDRESS.test(data.recipient) || canonicalAddress(data.recipient) === key) {
        await sendError(address, 'mail-recipient-invalid')
        return
      }
      recipientLook = options.state.getKnownRecipient(data.recipient)
      if (!recipientLook || recipientLook.isGuest || !STABLE_ADDRESS.test(recipientLook.address)) {
        await sendError(address, 'mail-recipient-unknown')
        return
      }
    }

    const beforeLookTime = now()
    const previousPost = latestPostAt()
    if (previousPost !== null && beforeLookTime - previousPost < AUTHOR_COOLDOWN_SECONDS * 1000) {
      await sendError(address, 'post-rate-limited')
      return
    }

    const look = await waitForLook(address)
    if (!look) {
      if (isCurrentSession(address, generation)) await sendError(address, 'look-not-ready')
      return
    }
    if (!isCurrentSession(address, generation)) return
    if (look.isGuest) {
      await sendError(address, recipientLook ? 'mail-guest' : 'post-guest')
      return
    }
    if (recipientLook && (look.isGuest || !STABLE_ADDRESS.test(look.address))) {
      await sendError(address, 'mail-guest')
      return
    }
    const existingAfterSnapshot = options.state.getCharade(id)
    if (existingAfterSnapshot) {
      const stats = await options.state.getOrCreateStats(key, look.name, !look.isGuest)
      if (!isCurrentSession(address, generation)) return
      const replay = cacheGet(completedRequests, idempotencyKey)
      if (replay) {
        if (!replay.durable) {
          if (!(await checkpointOrError(address, generation))) return
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
      const request = { type: 'posted' as const, data: posted, durable: false }
      cacheSet(completedRequests, idempotencyKey, key, request)
      if (!(await checkpointOrError(address, generation))) return
      request.durable = true
      if (!isCurrentSession(address, generation)) return
      await sendTo(address, 'posted', posted)
      return
    }
    const currentTime = now()
    const lastPost = latestPostAt()
    if (lastPost !== null && currentTime - lastPost < AUTHOR_COOLDOWN_SECONDS * 1000) {
      await sendError(address, 'post-rate-limited')
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
      if (isCurrentSession(address, generation)) await sendError(address, 'storage-unavailable')
      return
    }
    if (!isCurrentSession(address, generation)) return

    const previousTitle = progressFor(stats).title
    try {
      if (!options.state.upsertCharade(charade)) {
        await sendError(address, 'server-busy')
        return
      }
    } catch (error) {
      if (!(error instanceof StorageCapacityError)) throw error
      await sendError(address, 'server-busy')
      return
    }
    let stampAwarded = false
    if (!recipientLook) {
      if (!stats.authored.includes(id)) {
        stats.authored.push(id)
        stats.authoredCount = Math.min(stats.authoredCount + 1, WIRE_INT_MAX)
      }
      stampAwarded = options.state.recordDailyAuthor(stats)
      options.state.advanceProgressRevision(stats)
    }
    options.state.saveStats(key, !look.isGuest)
    if (recipientStats && recipientLook) {
      recipientStats.pending.mail = Math.min(recipientStats.pending.mail + 1, WIRE_INT_MAX)
      options.state.saveStats(recipientLook.address)
    }
    lastPosts.set(key, currentTime)

    const progress = progressFor(stats)
    const titleUnlocked = progress.title !== previousTitle && progress.title !== ''
    const posted: PostedPayload = {
      requestId: data.requestId,
      charadeId: id,
      ...(recipientLook ? { recipient: recipientLook.address } : {}),
      daily: { ...options.state.getDaily(stats) },
      revision: stats.revision,
      stampAwarded,
      ...progress,
      titleUnlocked
    }
    const request = { type: 'posted' as const, data: posted, durable: false }
    cacheSet(completedRequests, idempotencyKey, key, request)
    if (!(await checkpointOrError(address, generation))) return
    request.durable = true
    if (!isCurrentSession(address, generation)) return
    await sendTo(address, 'posted', posted)
    if (!recipientLook && titleUnlocked) await broadcastTitleUnlock(address, progress.title)
    if (!recipientLook) await refreshBoards()
  }

  async function handleReact(data: ReactPayload, address: string) {
    await ready
    const generation = sessionGeneration(address)
    if (generation === null) {
      await sendError(address, 'protocol-required')
      return
    }
    if (!(await ensureWelcome(address, generation))) return
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
      withRequestAdmission(address, 'next-charade', data, () => handleNextCharade(data, address)),
    handleGuess: (data: GuessPayload, address: string) =>
      withRequestAdmission(address, 'guess', data, async () => {
        if (!validWireString(data.requestId)) return handleGuess(data, address)
        return serializeRequest(`${canonicalAddress(address)}:guess`, () => handleGuess(data, address))
      }),
    handleRoundGuess: (data: GuessPayload, address: string) =>
      withRequestAdmission(address, 'guess', data, async () => {
        if (!validWireString(data.requestId)) return handleGuess(data, address)
        return serializeRequest(`${canonicalAddress(address)}:guess`, () => handleGuess(data, address))
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
      completedRequests: completedRequests.size,
      nextRequests: nextRequests.size,
      outstandingRequests: [...outstandingRequests.values()].reduce((total, count) => total + count, 0),
      requestBuckets: requestBuckets.size
    })
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
