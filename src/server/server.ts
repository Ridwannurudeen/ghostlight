import { AvatarBase, AvatarEquippedData, PlayerIdentityData, engine } from '@dcl/sdk/ecs'
import { onEnterScene, onLeaveScene } from '@dcl/sdk/src/players'
import { AUTHOR_COOLDOWN_SECONDS, PROTOCOL_VERSION } from '../shared/config'
import { DECK, EMOTE_VOCABULARY, HOUSE_CHARADE } from '../shared/deck'
import { Messages, room } from '../shared/messages'
import { chooseCharadeFor, pickDecoys, shuffleSeeded } from '../shared/pick'
import type { Charade, Look } from '../shared/types'
import { STORAGE_SCHEMA_VERSION } from '../shared/types'
import { LiveRounds } from './rounds'
import { GhostCharadesState, gameState } from './state'
import { flushNow, startFlushLoop } from './storage'

type HelloPayload = { displayName: string; isGuest: boolean; protocolVersion: number }
type PingPayload = { seq: number }
type NextCharadePayload = { exclude: string[] }
type GuessPayload = { charadeId: string; answerIndex: number; requestId: string }
type PostPayload = { phraseId: string; emotes: string[]; requestId: string }
type ReactPayload = { kind: string }

type RevealPayload = {
  charadeId: string
  correct: boolean
  phrase: string
  stats: { total: number; correct: number }
  yourScore: number
}

export type ProtocolSend = (type: string, data: unknown, to?: string[]) => void | Promise<void>

export type ServerProtocolOptions = {
  state: GhostCharadesState
  send: ProtocolSend
  snapshotLook: (address: string) => Look | null | Promise<Look | null>
  ready?: Promise<void>
  flush?: () => Promise<unknown>
  now?: () => number
  instanceId?: string
  lookAttempts?: number
  lookRetryMilliseconds?: number
}

const REACTION_KINDS = new Set(['laugh', 'confused', 'genius'])
const EMOTES = new Set<string>(EMOTE_VOCABULARY)
const MAX_WEARABLE_URNS = 20

function canonicalAddress(address: string) {
  return address.toLowerCase()
}

function withoutLastSeen(look: Look) {
  return {
    address: look.address,
    name: look.name,
    isGuest: look.isGuest,
    bodyShape: look.bodyShape,
    skinColor: look.skinColor,
    hairColor: look.hairColor,
    eyeColor: look.eyeColor,
    wearables: look.wearables.slice(0, MAX_WEARABLE_URNS)
  }
}

function hashText(value: string, salt: number) {
  let hash = (2166136261 ^ salt) >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash.toString(16).padStart(8, '0')
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
  const ready = options.ready ?? Promise.resolve()
  const checkpoint = options.flush ?? (async () => {})
  const instanceId = options.instanceId ?? String(now())
  const looks = new Map<string, Look>()
  const welcomed = new Set<string>()
  const welcomePromises = new Map<string, Promise<boolean>>()
  const answerIndexes = new Map<string, number>()
  const lastAuthors = new Map<string, string>()
  const lastPosts = new Map<string, number>()
  const completedRequests = new Map<
    string,
    { type: 'reveal' | 'posted'; data: RevealPayload | { charadeId: string } }
  >()
  const rounds = new LiveRounds((type, data) => options.send(type, data))

  async function sendTo(address: string, type: string, data: unknown) {
    await options.send(type, data, [address])
  }

  async function sendError(address: string, code: string) {
    await sendTo(address, 'error', { code })
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

  async function sendAudience(address: string, visitors = options.state.recentVisitors) {
    const wanted = canonicalAddress(address)
    const audience = visitors
      .filter((visitor) => canonicalAddress(visitor.address) !== wanted)
      .slice(0, 6)
      .map(withoutLastSeen)

    if (audience.length === 0) {
      await sendTo(address, 'audience', { looks: [] })
      return
    }
    for (let offset = 0; offset < audience.length; offset += 2) {
      await sendTo(address, 'audience', { looks: audience.slice(offset, offset + 2) })
    }
  }

  async function sendBoards(address: string) {
    await sendTo(address, 'boards', {
      topDecoders: options.state.boards.decoders,
      hardestGhosts: options.state.boards.hardest
    })
  }

  function selectRoundCharade() {
    const present = new Set([...looks.keys()])
    const previous = rounds.current?.charadeId
    const eligible = options.state
      .getPool()
      .filter(
        (charade) =>
          !present.has(canonicalAddress(charade.author.address)) &&
          charade.id !== previous &&
          ![...present].some((address) => options.state.playerStats.get(address)?.seen.includes(charade.id))
      )
      .sort(
        (left, right) =>
          left.guesses.total - right.guesses.total ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id)
      )
    return eligible[0] ?? HOUSE_CHARADE
  }

  function ensureRound() {
    if (!rounds.isLive) return null
    const current = rounds.current
    if (current && !rounds.isSettled) return options.state.getCharade(current.charadeId) ?? HOUSE_CHARADE
    const charade = selectRoundCharade()
    rounds.start(charade.id)
    return charade
  }

  async function runWelcome(address: string) {
    const key = canonicalAddress(address)
    const owner = welcomePromises.get(key)
    if (!owner) return false
    const look = await waitForLook(address)
    if (welcomePromises.get(key) !== owner) return false
    if (!look) return false

    const previousVisitors = [...options.state.recentVisitors]
    looks.set(key, look)
    rounds.enter({ address: look.address, name: look.name })
    options.state.touchVisitor(look)
    const stats = await options.state.getOrCreateStats(key, look.name, !look.isGuest)
    if (welcomePromises.get(key) !== owner) return false
    const rankIndex = options.state.boards.decoders.findIndex((row) => canonicalAddress(row.address) === key)
    const pending = { ...stats.pending }

    if (pending.triedYou > 0) {
      await sendTo(address, 'since', {
        triedYou: pending.triedYou,
        gotYou: pending.gotYou,
        rank: rankIndex < 0 ? 0 : rankIndex + 1
      })
      if (welcomePromises.get(key) !== owner) return false
    }
    options.state.consumePending(key, !look.isGuest)
    await sendAudience(address, previousVisitors)
    if (welcomePromises.get(key) !== owner) return false
    await sendBoards(address)
    if (welcomePromises.get(key) !== owner) return false
    welcomed.add(key)
    ensureRound()
    await checkpoint()
    if (welcomePromises.get(key) !== owner) return false
    return true
  }

  function welcome(address: string) {
    const key = canonicalAddress(address)
    if (welcomed.has(key)) return Promise.resolve(true)
    const active = welcomePromises.get(key)
    if (active) return active
    const pending = Promise.resolve()
      .then(() => runWelcome(address))
      .finally(() => {
        if (welcomePromises.get(key) === pending) welcomePromises.delete(key)
      })
    welcomePromises.set(key, pending)
    return pending
  }

  async function ensureWelcome(address: string) {
    const key = canonicalAddress(address)
    return welcomed.has(key) || (await welcome(address))
  }

  async function handleEnter(address: string) {
    await ready
    await sendTo(address, 'ready', { instanceId, serverTime: now() })
    if (!(await welcome(address))) await sendError(address, 'look-not-ready')
  }

  async function handleLeave(address: string) {
    await ready
    const key = canonicalAddress(address)
    welcomePromises.delete(key)
    const look = looks.get(key)
    if (look) {
      options.state.touchVisitor(look)
      options.state.saveStats(key, !look.isGuest)
    }
    looks.delete(key)
    welcomed.delete(key)
    lastAuthors.delete(key)
    lastPosts.delete(key)
    for (const answerKey of answerIndexes.keys()) {
      if (answerKey.startsWith(`${key}:`)) answerIndexes.delete(answerKey)
    }
    for (const request of completedRequests.keys()) {
      if (request.startsWith(`${key}:`)) completedRequests.delete(request)
    }
    rounds.leave(key)
    await checkpoint()
  }

  async function handleHello(data: HelloPayload, address: string) {
    await ready
    if (data.protocolVersion !== PROTOCOL_VERSION) {
      await sendError(address, 'protocol-version')
      return
    }
    await sendTo(address, 'ready', { instanceId, serverTime: now() })
    if (!(await welcome(address))) await sendError(address, 'look-not-ready')
  }

  async function handlePing(data: PingPayload, address: string) {
    await ready
    await sendTo(address, 'pong', { seq: data.seq })
    if (!welcomed.has(canonicalAddress(address))) await welcome(address)
  }

  function answerSet(charade: Charade) {
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)
    if (!phrase) return null
    const decoys = pickDecoys(phrase.id, DECK, charade.id)
    if (decoys.length !== 2) return null
    const answers = shuffleSeeded([phrase.text, decoys[0].text, decoys[1].text], `${charade.id}:answers`)
    return { phrase, answers, correctIndex: answers.indexOf(phrase.text) }
  }

  async function sendCharade(address: string, charade: Charade) {
    const answers = answerSet(charade)
    if (!answers) {
      await sendError(address, 'invalid-charade')
      return false
    }
    const key = `${canonicalAddress(address)}:${charade.id}`
    answerIndexes.set(key, answers.correctIndex)
    lastAuthors.set(canonicalAddress(address), charade.author.address)
    await sendTo(address, 'charade', {
      id: charade.id,
      authorName: charade.author.name,
      authorAddress: charade.author.address,
      look: withoutLastSeen(charade.author),
      emotes: [...charade.emotes],
      answers: answers.answers,
      createdAt: charade.createdAt,
      isHouse: charade.isHouse
    })
    return true
  }

  async function handleNextCharade(data: NextCharadePayload, address: string) {
    await ready
    if (!(await ensureWelcome(address))) {
      await sendError(address, 'look-not-ready')
      return
    }
    const key = canonicalAddress(address)
    const look = looks.get(key)
    const stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
    const liveCharade = ensureRound()
    const requesterGuessed = rounds.current?.guessed.includes(key) ?? false
    const selected =
      (requesterGuessed ? null : liveCharade) ??
      chooseCharadeFor(key, [...stats.seen, ...data.exclude], options.state.getPool(), lastAuthors.get(key)) ??
      HOUSE_CHARADE
    await sendCharade(address, selected)
  }

  function requestKey(address: string, kind: string, requestId: string) {
    return `${canonicalAddress(address)}:${kind}:${requestId}`
  }

  async function handleGuess(data: GuessPayload, address: string) {
    await ready
    if (!(await ensureWelcome(address))) {
      await sendError(address, 'look-not-ready')
      return
    }
    const key = canonicalAddress(address)
    const idempotencyKey = requestKey(key, 'guess', data.requestId)
    const completed = completedRequests.get(idempotencyKey)
    if (completed) {
      await sendTo(address, completed.type, completed.data)
      return
    }
    if (!data.requestId || !Number.isInteger(data.answerIndex) || data.answerIndex < 0 || data.answerIndex > 2) {
      await sendError(address, 'invalid-guess')
      return
    }

    const charade = options.state.getCharade(data.charadeId)
    const correctIndex = answerIndexes.get(`${key}:${data.charadeId}`)
    if (!charade || correctIndex === undefined) {
      await sendError(address, 'charade-not-served')
      return
    }
    const roundIsActive = rounds.current?.charadeId === charade.id && rounds.isLive

    const look = looks.get(key)
    const stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
    if (!charade.isHouse && stats.seen.includes(charade.id)) {
      await sendError(address, 'already-guessed')
      return
    }

    const correct = data.answerIndex === correctIndex
    if (roundIsActive) {
      const roundResult = rounds.guess(key, charade.id, correct)
      if (!roundResult.accepted) {
        await sendError(address, 'round-already-guessed')
        return
      }
    }

    if (!charade.isHouse) {
      stats.seen.push(charade.id)
      stats.decoded += 1
      stats.correct += correct ? 1 : 0
      options.state.recordGuess(charade.id, correct)
      options.state.recordDecoder(key, stats.name, correct)
      const authorStats = await options.state.getOrCreateStats(
        charade.author.address,
        charade.author.name,
        !charade.author.isGuest
      )
      authorStats.pending.triedYou += 1
      authorStats.pending.gotYou += correct ? 1 : 0
      options.state.saveStats(charade.author.address, !charade.author.isGuest)
    }
    options.state.saveStats(key, !(look?.isGuest ?? true))

    const updated = options.state.getCharade(charade.id) ?? charade
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)
    if (!phrase) {
      await sendError(address, 'invalid-charade')
      return
    }
    const reveal: RevealPayload = {
      charadeId: charade.id,
      correct,
      phrase: phrase.text,
      stats: { ...updated.guesses },
      yourScore: stats.correct
    }
    completedRequests.set(idempotencyKey, { type: 'reveal', data: reveal })
    await sendTo(address, 'reveal', reveal)
    await checkpoint()
  }

  async function handlePost(data: PostPayload, address: string) {
    await ready
    if (!(await ensureWelcome(address))) {
      await sendError(address, 'look-not-ready')
      return
    }
    const key = canonicalAddress(address)
    const idempotencyKey = requestKey(key, 'post', data.requestId)
    const completed = completedRequests.get(idempotencyKey)
    if (completed) {
      await sendTo(address, completed.type, completed.data)
      return
    }
    const phrase = DECK.find((candidate) => candidate.id === data.phraseId)
    if (!data.requestId || !phrase || data.emotes.length !== 3 || data.emotes.some((emote) => !EMOTES.has(emote))) {
      await sendError(address, 'invalid-post')
      return
    }

    const id = charadeId(key, data.requestId)
    if (options.state.getCharade(id)) {
      const posted = { charadeId: id }
      completedRequests.set(idempotencyKey, { type: 'posted', data: posted })
      await sendTo(address, 'posted', posted)
      return
    }

    function latestPostAt() {
      const persisted = options.state
        .getPool()
        .filter((charade) => canonicalAddress(charade.author.address) === key)
        .reduce<number | null>(
          (latest, charade) => (latest === null ? charade.createdAt : Math.max(latest, charade.createdAt)),
          null
        )
      const session = lastPosts.get(key)
      if (persisted === null) return session ?? null
      return session === undefined ? persisted : Math.max(session, persisted)
    }

    const beforeLookTime = now()
    const previousPost = latestPostAt()
    if (previousPost !== null && beforeLookTime - previousPost < AUTHOR_COOLDOWN_SECONDS * 1000) {
      await sendError(address, 'post-rate-limited')
      return
    }

    const look = await waitForLook(address)
    if (!look) {
      await sendError(address, 'look-not-ready')
      return
    }
    if (options.state.getCharade(id)) {
      const posted = { charadeId: id }
      completedRequests.set(idempotencyKey, { type: 'posted', data: posted })
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
      isHouse: false
    }
    options.state.upsertCharade(charade)
    const stats = await options.state.getOrCreateStats(key, look.name, !look.isGuest)
    stats.authored.push(id)
    options.state.saveStats(key, !look.isGuest)
    lastPosts.set(key, currentTime)

    const posted = { charadeId: id }
    completedRequests.set(idempotencyKey, { type: 'posted', data: posted })
    await sendTo(address, 'posted', posted)
    await checkpoint()
  }

  async function handleReact(data: ReactPayload, address: string) {
    await ready
    if (!REACTION_KINDS.has(data.kind)) {
      await sendError(address, 'invalid-reaction')
      return
    }
    const sender = canonicalAddress(address)
    const recipients = [...looks.values()]
      .filter((look) => canonicalAddress(look.address) !== sender)
      .map((look) => look.address)
    if (recipients.length > 0) await options.send('react', { kind: data.kind }, recipients)
  }

  return {
    rounds,
    handleEnter,
    handleLeave,
    handleHello,
    handlePing,
    handleNextCharade,
    handleGuess: (data: GuessPayload, address: string) => handleGuess(data, address),
    handleRoundGuess: (data: GuessPayload, address: string) => handleGuess(data, address),
    handlePost,
    handleReact
  }
}

const INSTANCE_ID = String(Date.now())

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
    if (address) void protocol.handleHello(data, address)
  })
  room.onMessage('ping', (data, context) => {
    const address = from(context)
    if (address) void protocol.handlePing(data, address)
  })
  room.onMessage('nextCharade', (data, context) => {
    const address = from(context)
    if (address) void protocol.handleNextCharade(data, address)
  })
  room.onMessage('guess', (data, context) => {
    const address = from(context)
    if (address) void protocol.handleGuess(data, address)
  })
  room.onMessage('post', (data, context) => {
    const address = from(context)
    if (address) void protocol.handlePost(data, address)
  })
  room.onMessage('roundGuess', (data, context) => {
    const address = from(context)
    if (address) void protocol.handleRoundGuess(data, address)
  })
  room.onMessage('react', (data, context) => {
    const address = from(context)
    if (address) void protocol.handleReact(data, address)
  })

  onEnterScene((player) => void protocol.handleEnter(player.userId))
  onLeaveScene((address) => void protocol.handleLeave(address))
}
