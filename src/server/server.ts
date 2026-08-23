import { AvatarBase, AvatarEquippedData, PlayerIdentityData, engine } from '@dcl/sdk/ecs'
import { onEnterScene, onLeaveScene } from '@dcl/sdk/src/players'
import { AUTHOR_COOLDOWN_SECONDS, PROTOCOL_VERSION, themeForTimestamp } from '../shared/config'
import { DECK, EMOTE_VOCABULARY, HOUSE_CHARADE } from '../shared/deck'
import { Messages, room } from '../shared/messages'
import { chooseCharadeFor, pickDecoys, shuffleSeeded } from '../shared/pick'
import type { Charade, Look, PlayerProgress } from '../shared/types'
import { STORAGE_SCHEMA_VERSION } from '../shared/types'
import { LiveRounds } from './rounds'
import { GhostCharadesState, gameState } from './state'
import { flushNow, startFlushLoop } from './storage'

type HelloPayload = { displayName: string; isGuest: boolean; protocolVersion: number }
type PingPayload = { seq: number }
type NextCharadePayload = { exclude: string[] }
type GuessPayload = { charadeId: string; answerIndex: number; requestId: string }
type PostPayload = { phraseId: string; emotes: string[]; requestId: string; replyTo?: string }
type ReactPayload = { kind: string }

type RevealPayload = {
  charadeId: string
  correct: boolean
  phraseId: string
  phrase: string
  stats: { total: number; correct: number }
  yourScore: number
  daily: ReturnType<GhostCharadesState['getDaily']>
  stampAwarded: boolean
  title: PlayerProgress['title']
  nextUnlock: PlayerProgress['nextUnlock']
  titleUnlocked: boolean
}

type PostedPayload = {
  charadeId: string
  replyTo?: string
  daily: ReturnType<GhostCharadesState['getDaily']>
  stampAwarded: boolean
  title: PlayerProgress['title']
  nextUnlock: PlayerProgress['nextUnlock']
  titleUnlocked: boolean
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
const MAX_WIRE_ADDRESS_BYTES = 48
const MAX_WIRE_NAME_BYTES = 32
const MAX_WIRE_ID_BYTES = 64
const MAX_WIRE_URN_BYTES = 512
const MAX_WIRE_LOOK_BYTES = 2_800
const DEFAULT_BODY_SHAPE = 'urn:decentraland:off-chain:base-avatars:BaseMale'

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
    name: limitText(look.name, MAX_WIRE_NAME_BYTES),
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
  const cancelledWelcomePromises = new WeakSet<Promise<boolean>>()
  const answerIndexes = new Map<string, number>()
  const lastAuthors = new Map<string, string>()
  const lastPosts = new Map<string, number>()
  const completedRequests = new Map<
    string,
    {
      type: 'reveal' | 'posted'
      data: RevealPayload | PostedPayload
    }
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
    for (const look of audience) {
      await sendTo(address, 'audience', { looks: [look] })
    }
  }

  async function sendBoards(address: string) {
    const [playbill, ghostOfNight] = await Promise.all([
      options.state.getRecentPerformers(),
      options.state.getGhostOfNight()
    ])
    const topDecoders = options.state.boards.decoders.map((entry) => ({
      ...entry,
      address: limitText(entry.address, MAX_WIRE_ADDRESS_BYTES),
      name: limitText(entry.name, MAX_WIRE_NAME_BYTES)
    }))
    const hardestGhosts = options.state.boards.hardest.map((entry) => ({
      ...entry,
      charadeId: limitText(entry.charadeId, MAX_WIRE_ID_BYTES),
      authorName: limitText(entry.authorName, MAX_WIRE_NAME_BYTES)
    }))
    const wirePlaybill = playbill.map((entry) => ({
      ...entry,
      address: limitText(entry.address, MAX_WIRE_ADDRESS_BYTES),
      name: limitText(entry.name, MAX_WIRE_NAME_BYTES)
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
    await sendTo(address, 'boards', boardsPayload)
    if (ghostOfNight) {
      const ghostLook = withoutLastSeen(ghostOfNight.charade.author)
      await sendTo(address, 'ghostOfNight', {
        charadeId: limitText(ghostOfNight.charade.id, MAX_WIRE_ID_BYTES),
        address: ghostLook.address,
        name: ghostLook.name,
        title: ghostOfNight.title,
        look: ghostLook,
        total: ghostOfNight.charade.guesses.total,
        correct: ghostOfNight.charade.guesses.correct
      })
    }
  }

  async function refreshBoards() {
    await Promise.all([...looks.values()].map((look) => sendBoards(look.address)))
  }

  function progressFor(stats: Awaited<ReturnType<GhostCharadesState['getOrCreateStats']>>) {
    const progress = options.state.getPlayerProgress(stats)
    return { title: progress.title, nextUnlock: { ...progress.nextUnlock } }
  }

  async function sendVisibleTitles(address: string) {
    const key = canonicalAddress(address)
    for (const [visibleAddress, look] of looks) {
      const stats = options.state.playerStats.get(visibleAddress)
      if (!stats) continue
      await sendTo(address, 'playerTitle', { address: look.address, title: progressFor(stats).title })
    }
    const ownStats = options.state.playerStats.get(key)
    if (!ownStats) return
    const recipients = [...looks.entries()]
      .filter(([visibleAddress]) => visibleAddress !== key)
      .map(([, look]) => look.address)
    if (recipients.length > 0) {
      await options.send('playerTitle', { address, title: progressFor(ownStats).title }, recipients)
    }
  }

  async function broadcastTitleUnlock(address: string, title: PlayerProgress['title']) {
    const recipients = [...looks.values()].map((look) => look.address)
    if (recipients.length > 0) await options.send('playerTitle', { address, title }, recipients)
  }

  function readyPayload() {
    const timestamp = now()
    const theme = themeForTimestamp(timestamp)
    return { instanceId, serverTime: timestamp, theme: theme.id, themeLabel: theme.label }
  }

  function selectRoundCharade() {
    const present = new Set([...looks.keys()])
    const previous = rounds.current?.charadeId
    const theme = themeForTimestamp(now()).id
    const eligible = options.state
      .getPool()
      .filter(
        (charade) =>
          !present.has(canonicalAddress(charade.author.address)) &&
          charade.id !== previous &&
          ![...present].some((address) => options.state.playerStats.get(address)?.seen.includes(charade.id))
      )
      .sort((left, right) => {
        const leftPreferred = DECK.find((phrase) => phrase.id === left.phraseId)?.theme === theme ? 0 : 1
        const rightPreferred = DECK.find((phrase) => phrase.id === right.phraseId)?.theme === theme ? 0 : 1
        return (
          leftPreferred - rightPreferred ||
          left.guesses.total - right.guesses.total ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id)
        )
      })
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
    const progress = progressFor(stats)

    await sendTo(address, 'progress', { daily: { ...options.state.getDaily(stats) }, ...progress })
    if (welcomePromises.get(key) !== owner) return false
    if (pending.triedYou > 0 || pending.replies > 0) {
      await sendTo(address, 'since', {
        triedYou: pending.triedYou,
        gotYou: pending.gotYou,
        replies: pending.replies,
        rank: rankIndex < 0 ? 0 : rankIndex + 1,
        daily: { ...options.state.getDaily(stats) },
        ...progress
      })
      if (welcomePromises.get(key) !== owner) return false
    }
    options.state.consumePending(key, !look.isGuest)
    await sendVisibleTitles(address)
    if (welcomePromises.get(key) !== owner) return false
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
    await sendTo(address, 'ready', readyPayload())
    const pendingWelcome = welcome(address)
    if (!(await pendingWelcome) && !cancelledWelcomePromises.has(pendingWelcome)) {
      await sendError(address, 'look-not-ready')
    }
  }

  async function handleLeave(address: string) {
    await ready
    const key = canonicalAddress(address)
    const pendingWelcome = welcomePromises.get(key)
    if (pendingWelcome) cancelledWelcomePromises.add(pendingWelcome)
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
    await sendTo(address, 'ready', readyPayload())
    const pendingWelcome = welcome(address)
    if (!(await pendingWelcome) && !cancelledWelcomePromises.has(pendingWelcome)) {
      await sendError(address, 'look-not-ready')
    }
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
    const authorTitle = charade.isHouse
      ? ''
      : progressFor(
          await options.state.getOrCreateStats(charade.author.address, charade.author.name, !charade.author.isGuest)
        ).title
    const authorLook = withoutLastSeen(charade.author)
    await sendTo(address, 'charade', {
      id: charade.id,
      authorName: authorLook.name,
      authorAddress: authorLook.address,
      look: authorLook,
      emotes: [...charade.emotes],
      answers: answers.answers,
      createdAt: charade.createdAt,
      isHouse: charade.isHouse,
      authorTitle
    })
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
    if (!(await ensureWelcome(address))) {
      await sendError(address, 'look-not-ready')
      return
    }
    const key = canonicalAddress(address)
    const look = looks.get(key)
    const stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
    const liveCharade = ensureRound()
    if (
      liveCharade &&
      !liveCharade.isHouse &&
      (stats.seen.includes(liveCharade.id) || canonicalAddress(liveCharade.author.address) === key)
    ) {
      rounds.guess(key, liveCharade.id, false)
    }
    const requesterGuessed = rounds.current?.guessed.includes(key) ?? false
    const selected =
      (requesterGuessed ? null : liveCharade) ??
      chooseCharadeFor(
        key,
        [...stats.seen, ...data.exclude],
        options.state.getPool(),
        lastAuthors.get(key),
        themeForTimestamp(now()).id
      ) ??
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
    const previousTitle = progressFor(stats).title
    if (!charade.isHouse && stats.seen.includes(charade.id)) {
      await sendError(address, 'already-guessed')
      return
    }

    const correct = data.answerIndex === correctIndex
    if (roundIsActive) rounds.guess(key, charade.id, correct)

    let stampAwarded = false
    if (!charade.isHouse) {
      stats.seen.push(charade.id)
      stats.decoded += 1
      stats.correct += correct ? 1 : 0
      stampAwarded = options.state.recordDailyDecode(stats)
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
    const progress = progressFor(stats)
    const titleUnlocked = progress.title !== previousTitle && progress.title !== ''

    const updated = options.state.getCharade(charade.id) ?? charade
    const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)
    if (!phrase) {
      await sendError(address, 'invalid-charade')
      return
    }
    const reveal: RevealPayload = {
      charadeId: charade.id,
      correct,
      phraseId: phrase.id,
      phrase: phrase.text,
      stats: { ...updated.guesses },
      yourScore: stats.correct,
      daily: { ...options.state.getDaily(stats) },
      stampAwarded,
      ...progress,
      titleUnlocked
    }
    completedRequests.set(idempotencyKey, { type: 'reveal', data: reveal })
    await sendTo(address, 'reveal', reveal)
    if (titleUnlocked) await broadcastTitleUnlock(address, progress.title)
    if (!charade.isHouse) await refreshBoards()
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
    if (data.replyTo !== undefined) {
      if (
        !data.requestId ||
        !data.replyTo ||
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
      if (
        !target ||
        target.isHouse ||
        canonicalAddress(target.author.address) === key ||
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
          charadeId: target.id,
          replyTo: target.id,
          daily: { ...options.state.getDaily(stats) },
          stampAwarded: false,
          ...progressFor(stats),
          titleUnlocked: false
        }
        completedRequests.set(idempotencyKey, { type: 'posted', data: posted })
        await sendTo(address, 'posted', posted)
        return
      }
      const replyLook = await waitForLook(address)
      if (!replyLook) {
        await sendError(address, 'look-not-ready')
        return
      }
      const authorStats = await options.state.getOrCreateStats(
        target.author.address,
        target.author.name,
        !target.author.isGuest
      )
      const attached = options.state.attachReply(target.id, {
        address: replyLook.address,
        name: replyLook.name,
        look: replyLook,
        emotes: [data.emotes[0], data.emotes[1], data.emotes[2]],
        createdAt: now()
      })
      if (!attached) {
        const winner = options.state.getCharade(target.id)?.reply
        if (!winner || canonicalAddress(winner.address) !== key) {
          await sendError(address, 'reply-taken')
          return
        }
      } else {
        authorStats.pending.replies += 1
        options.state.saveStats(target.author.address, !target.author.isGuest)
      }
      const posted: PostedPayload = {
        charadeId: target.id,
        replyTo: target.id,
        daily: { ...options.state.getDaily(stats) },
        stampAwarded: false,
        ...progressFor(stats),
        titleUnlocked: false
      }
      completedRequests.set(idempotencyKey, { type: 'posted', data: posted })
      await sendTo(address, 'posted', posted)
      await checkpoint()
      return
    }
    const phrase = DECK.find((candidate) => candidate.id === data.phraseId)
    if (!data.requestId || !phrase || data.emotes.length !== 3 || data.emotes.some((emote) => !EMOTES.has(emote))) {
      await sendError(address, 'invalid-post')
      return
    }

    const id = charadeId(key, data.requestId)
    if (options.state.getCharade(id)) {
      const look = looks.get(key)
      const stats = await options.state.getOrCreateStats(key, playerName(key), !(look?.isGuest ?? true))
      const posted: PostedPayload = {
        charadeId: id,
        daily: { ...options.state.getDaily(stats) },
        stampAwarded: false,
        ...progressFor(stats),
        titleUnlocked: false
      }
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
      const stats = await options.state.getOrCreateStats(key, look.name, !look.isGuest)
      const replay = completedRequests.get(idempotencyKey)
      if (replay) {
        await sendTo(address, replay.type, replay.data)
        return
      }
      const posted: PostedPayload = {
        charadeId: id,
        daily: { ...options.state.getDaily(stats) },
        stampAwarded: false,
        ...progressFor(stats),
        titleUnlocked: false
      }
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
    const previousTitle = progressFor(stats).title
    stats.authored.push(id)
    const stampAwarded = options.state.recordDailyAuthor(stats)
    options.state.saveStats(key, !look.isGuest)
    lastPosts.set(key, currentTime)

    const progress = progressFor(stats)
    const titleUnlocked = progress.title !== previousTitle && progress.title !== ''
    const posted: PostedPayload = {
      charadeId: id,
      daily: { ...options.state.getDaily(stats) },
      stampAwarded,
      ...progress,
      titleUnlocked
    }
    completedRequests.set(idempotencyKey, { type: 'posted', data: posted })
    await sendTo(address, 'posted', posted)
    if (titleUnlocked) await broadcastTitleUnlock(address, progress.title)
    await refreshBoards()
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
