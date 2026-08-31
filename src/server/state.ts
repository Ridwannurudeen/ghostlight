import { AUDIENCE_SEATS, HYDRATION_DAYS, TITLES, WIRE_INT_MAX } from '../shared/config'
import type { PlayerTitle } from '../shared/config'
import { DECK, EMOTE_VOCABULARY, HOUSE_CHARADES } from '../shared/deck'
import type {
  Boards,
  Charade,
  CharadeReply,
  Color,
  DailyProgress,
  Look,
  PlaybillPerformer,
  PlayerProgress,
  PlayerStats,
  ShowSet
} from '../shared/types'
import { SHOW_SET_SIZE, STORAGE_SCHEMA_VERSION } from '../shared/types'
import {
  PLAYER_STATS_KEY,
  RECENT_VISITORS_KEY,
  boardsKey,
  charadeKey,
  decoderAggregateKey,
  indexKey,
  loadJSON,
  loadPlayerJSON,
  markDirty,
  markDirtyBatch,
  markPlayerDirty,
  saveJSONNow,
  flushNow,
  StorageCorruptError,
  StorageCapacityError,
  StorageUnavailableError,
  type StorageRepository
} from './storage'

export type RecentVisitor = Look & { lastSeenAt: number }

export const DURABLE_MUTATION_JOURNAL_KEY = 'gc:v1:mutationJournal'
export const MAX_DURABLE_COMPLETIONS = 64
export const MAX_DURABLE_JOURNAL_BYTES = 112 * 1024

export type DurableMutationFingerprint =
  | {
      kind: 'guess'
      charadeId: string
      answerIndex: number
      spotlight: boolean
      roundId: string | null
    }
  | {
      kind: 'post'
      phraseId: string
      emotes: [string, string, string]
      touringConsent: boolean
      replyTo?: string
      recipient?: string
    }

export type DurableMutationResponse = {
  type: 'reveal' | 'posted'
  data: Record<string, unknown>
}

export type DurableStatsPatch = {
  address: string
  persistent: boolean
  seenAdd?: string
  authoredAdd?: string
  stampedDayAdd?: string
  after: {
    name: string
    decoded: number
    correct: number
    authoredCount: number
    lastSeenAt: number
    pending: PlayerStats['pending']
    daily: DailyProgress
    revision: number
    title: PlayerTitle
    showSet?: ShowSet
  }
}

export type DurableMutation = {
  v: 1
  id: string
  owner: string
  requestId: string
  createdAt: number
  fingerprint: DurableMutationFingerprint
  response: DurableMutationResponse
  notifiedAuthor?: string
  charade?: Charade
  stats: DurableStatsPatch[]
  decoder?: { day: string; row: Boards['decoders'][number] }
  boards?: { day: string; value: Boards }
}

export type DurableCompletion = Pick<
  DurableMutation,
  'v' | 'id' | 'owner' | 'requestId' | 'createdAt' | 'fingerprint' | 'response'
> & { completedAt: number }

type DurableMutationJournal = {
  v: 1
  active: DurableMutation | null
  completed: DurableCompletion[]
}

type StateStorage = Pick<StorageRepository, 'loadJSON' | 'loadPlayerJSON' | 'markDirty' | 'markPlayerDirty'> &
  Partial<Pick<StorageRepository, 'markDirtyBatch' | 'saveJSONNow' | 'flushNow'>>

const defaultStorage: StateStorage = {
  loadJSON,
  loadPlayerJSON,
  markDirty,
  markDirtyBatch,
  markPlayerDirty,
  saveJSONNow,
  flushNow
}

const EMPTY_BOARDS: Boards = { decoders: [], hardest: [] }
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const MAX_CONCURRENT_READS = 8
const MAX_STAMPED_DAYS = 100
const MAX_AUTHORED_IDS = 200
const MAX_CACHED_PLAYER_STATS = 256
const MAX_TIMESTAMP = 8_640_000_000_000_000
const MAX_FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1000
const MAX_STORED_ID_BYTES = 128
const MAX_STORED_NAME_BYTES = 128
const MAX_STORED_URN_BYTES = 512
const MAX_REPLY_REQUEST_ID_BYTES = 64
const MAX_STORED_WEARABLES = 20
const MAX_RECENT_VISITOR_INPUTS = AUDIENCE_SEATS * 4
export const MAX_PLAYER_SEEN_IDS = 512
export const MAX_INDEX_IDS_PER_DAY = 128
export const MAX_LIVE_CHARADES = 512
export const MAX_DAILY_DECODERS = 256
const SUPPORTED_STORAGE_VERSIONS = new Set([0, 1, 2, STORAGE_SCHEMA_VERSION])
const HOUSE_CHARADE_IDS = new Set(HOUSE_CHARADES.map((charade) => charade.id))
const PHRASE_IDS = new Set(DECK.map((phrase) => phrase.id))
const VALID_EMOTES = new Set<string>(EMOTE_VOCABULARY)
const STABLE_ADDRESS = /^0x[a-f0-9]{40}$/iu
const ROUND_ID = /^[1-9][0-9]*$/u

export class UnsupportedStorageVersionError extends Error {
  constructor(readonly version: number) {
    super(`Unsupported storage schema version: ${version}`)
    this.name = 'UnsupportedStorageVersionError'
  }
}

function utf8Bytes(value: string) {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNonNegativeInt(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), WIRE_INT_MAX)
    : fallback
}

function asTimestamp(value: unknown, fallback: number | null = null) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? value
    : fallback
}

function asStringArray(value: unknown, limit: number, maxBytes = MAX_STORED_ID_BYTES) {
  if (!Array.isArray(value)) return []
  const strings: string[] = []
  for (let index = value.length - 1; index >= 0 && strings.length < limit; index -= 1) {
    const item = value[index]
    if (typeof item === 'string' && utf8Bytes(item) <= maxBytes) strings.push(item)
  }
  return strings.reverse()
}

function exactStrings(value: unknown, length: number, maxBytes: number) {
  if (!Array.isArray(value) || value.length !== length) return null
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || utf8Bytes(item) > maxBytes) return null
    strings.push(item)
  }
  return strings
}

function normalizeAuthored(value: unknown) {
  return [...new Set(asStringArray(value, MAX_AUTHORED_IDS).filter((id) => !HOUSE_CHARADE_IDS.has(id)))]
}

function authoredCountFrom(value: unknown) {
  if (!Array.isArray(value)) return 0
  const ids = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && utf8Bytes(item) <= MAX_STORED_ID_BYTES && !HOUSE_CHARADE_IDS.has(item)) {
      ids.add(item)
    }
  }
  return ids.size
}

function isDayKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && dayKey(timestamp) === value
}

function emptyDaily(day: string): DailyProgress {
  return { day, decoded: 0, authored: 0, stamped: false }
}

function migrateDaily(value: unknown, now: number): DailyProgress {
  const stored = asObject(value)
  const today = dayKey(now)
  if (!stored || typeof stored.day !== 'string' || !isDayKey(stored.day) || stored.day > today) {
    return emptyDaily(today)
  }
  return {
    day: stored.day,
    decoded: asNonNegativeInt(stored.decoded),
    authored: asNonNegativeInt(stored.authored),
    stamped: stored.stamped === true
  }
}

function migrateShowSet(value: unknown): ShowSet | undefined {
  const stored = asObject(value)
  if (!stored) return undefined
  const values = [stored.round, stored.score, stored.streak, stored.bestStreak, stored.understood]
  if (
    values.some(
      (entry) => typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0 || entry > WIRE_INT_MAX
    )
  ) {
    return undefined
  }
  const round = Math.min(stored.round as number, SHOW_SET_SIZE)
  const streak = Math.min(stored.streak as number, round)
  const migrated: ShowSet = {
    round,
    score: Math.min(stored.score as number, SHOW_SET_SIZE * 200),
    streak,
    bestStreak: Math.max(streak, Math.min(stored.bestStreak as number, round)),
    understood: Math.min(stored.understood as number, round)
  }
  if (
    typeof stored.showKey === 'string' &&
    stored.showKey.length > 0 &&
    utf8Bytes(stored.showKey) <= MAX_STORED_ID_BYTES
  ) {
    migrated.showKey = stored.showKey
  }
  return migrated
}

function clampProgress(value: number) {
  return Math.max(0, Math.min(1, value))
}

export function computeTitle(counts: { correct: number; authored: number; stamps: number }): PlayerTitle {
  if (counts.correct >= 25 && counts.stamps >= 3) return 'Ghostlight Legend'
  if (counts.correct >= 10 || counts.authored >= 5) return 'Scene Stealer'
  if (counts.authored >= 1) return 'Understudy'
  return ''
}

export function computeProgress(counts: { correct: number; authored: number; stamps: number }): PlayerProgress {
  const title = computeTitle(counts)
  if (title === 'Ghostlight Legend') {
    return { title, nextUnlock: { nextTitle: '', requirement: 'All titles unlocked', progress: 1 } }
  }
  if (title === 'Scene Stealer') {
    return {
      title,
      nextUnlock: {
        nextTitle: 'Ghostlight Legend',
        requirement: '3 daily stamps and 25 correct decodes',
        progress: clampProgress(Math.min(counts.stamps / 3, counts.correct / 25))
      }
    }
  }
  if (title === 'Understudy') {
    return {
      title,
      nextUnlock: {
        nextTitle: 'Scene Stealer',
        requirement: '10 correct decodes or 5 posts',
        progress: clampProgress(Math.max(counts.correct / 10, counts.authored / 5))
      }
    }
  }
  return {
    title,
    nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 }
  }
}

function migrateColor(value: unknown): Color | null {
  const color = asObject(value)
  if (!color) return null
  if (
    typeof color.r !== 'number' ||
    typeof color.g !== 'number' ||
    typeof color.b !== 'number' ||
    !Number.isFinite(color.r) ||
    !Number.isFinite(color.g) ||
    !Number.isFinite(color.b) ||
    color.r < 0 ||
    color.r > 1 ||
    color.g < 0 ||
    color.g > 1 ||
    color.b < 0 ||
    color.b > 1
  ) {
    return null
  }
  return { r: color.r, g: color.g, b: color.b }
}

export function migrateLook(value: unknown): Look | null {
  const look = asObject(value)
  if (!look) return null
  const skinColor = migrateColor(look.skinColor)
  const hairColor = migrateColor(look.hairColor)
  const eyeColor = migrateColor(look.eyeColor)
  if (
    typeof look.address !== 'string' ||
    utf8Bytes(look.address) > MAX_STORED_ID_BYTES ||
    typeof look.name !== 'string' ||
    utf8Bytes(look.name) > MAX_STORED_NAME_BYTES ||
    typeof look.isGuest !== 'boolean' ||
    typeof look.bodyShape !== 'string' ||
    utf8Bytes(look.bodyShape) > MAX_STORED_URN_BYTES ||
    !skinColor ||
    !hairColor ||
    !eyeColor
  ) {
    return null
  }

  return {
    address: look.address,
    name: look.name,
    isGuest: look.isGuest,
    bodyShape: look.bodyShape,
    skinColor,
    hairColor,
    eyeColor,
    wearables: asStringArray(look.wearables, MAX_STORED_WEARABLES, MAX_STORED_URN_BYTES)
  }
}

export function migrateReply(value: unknown, legacy = false): CharadeReply | null {
  const stored = asObject(value)
  if (!stored) return null
  const look = migrateLook(stored.look)
  const emotes = exactStrings(stored.emotes, 3, 64)
  const requestId: string | null = legacy
    ? null
    : typeof stored.requestId === 'string' &&
        stored.requestId.length > 0 &&
        utf8Bytes(stored.requestId) <= MAX_REPLY_REQUEST_ID_BYTES
      ? stored.requestId
      : null
  if (
    (!legacy && requestId === null) ||
    typeof stored.address !== 'string' ||
    typeof stored.name !== 'string' ||
    !look ||
    stored.address.toLowerCase() !== look.address.toLowerCase() ||
    stored.name !== look.name ||
    !emotes ||
    emotes.some((emote) => !VALID_EMOTES.has(emote)) ||
    asTimestamp(stored.createdAt) === null
  ) {
    return null
  }
  return {
    requestId,
    address: stored.address,
    name: stored.name,
    look,
    emotes: [emotes[0], emotes[1], emotes[2]],
    createdAt: stored.createdAt as number
  }
}

export function migrateCharade(value: unknown, context: { expectedDay?: string; now?: number } = {}): Charade | null {
  const stored = asObject(value)
  if (!stored || typeof stored.v !== 'number' || !SUPPORTED_STORAGE_VERSIONS.has(stored.v)) return null
  const author = migrateLook(stored.author)
  const emotes = exactStrings(stored.emotes, 3, 64)
  const guesses = asObject(stored.guesses)
  if (
    !author ||
    typeof stored.id !== 'string' ||
    utf8Bytes(stored.id) > MAX_STORED_ID_BYTES ||
    typeof stored.phraseId !== 'string' ||
    !PHRASE_IDS.has(stored.phraseId) ||
    !emotes ||
    emotes.some((emote) => !VALID_EMOTES.has(emote)) ||
    asTimestamp(stored.createdAt) === null ||
    !guesses ||
    typeof stored.isHouse !== 'boolean'
  ) {
    return null
  }

  const createdAt = stored.createdAt as number
  const lastGuessAt = asTimestamp(stored.lastGuessAt, createdAt)!
  if (
    (context.expectedDay !== undefined && dayKey(createdAt) !== context.expectedDay) ||
    (context.now !== undefined &&
      (createdAt > context.now + MAX_FUTURE_SKEW_MILLISECONDS ||
        lastGuessAt > context.now + MAX_FUTURE_SKEW_MILLISECONDS))
  ) {
    return null
  }

  const total = asNonNegativeInt(guesses.total)
  const touringConsent =
    stored.v === STORAGE_SCHEMA_VERSION
      ? typeof stored.touringConsent === 'boolean'
        ? stored.touringConsent
        : null
      : false
  if (touringConsent === null || (stored.isHouse && touringConsent)) return null
  const migrated: Charade = {
    v: STORAGE_SCHEMA_VERSION,
    id: stored.id,
    author,
    phraseId: stored.phraseId,
    emotes: [emotes[0], emotes[1], emotes[2]],
    createdAt,
    guesses: {
      total,
      correct: Math.min(asNonNegativeInt(guesses.correct), total)
    },
    lastGuessAt,
    isHouse: stored.isHouse,
    touringConsent
  }
  if (stored.v >= 2 && stored.recipient !== undefined) {
    if (typeof stored.recipient !== 'string' || !STABLE_ADDRESS.test(stored.recipient)) return null
    if (touringConsent) return null
    migrated.recipient = stored.recipient
  }
  if (stored.v >= 2 && !stored.isHouse) {
    const reply = migrateReply(stored.reply, stored.v < STORAGE_SCHEMA_VERSION)
    if (reply) migrated.reply = reply
  }
  return migrated
}

export function migratePlayerStats(value: unknown, name: string, now: number): PlayerStats {
  const stored = asObject(value)
  if (stored && typeof stored.v === 'number' && !SUPPORTED_STORAGE_VERSIONS.has(stored.v)) {
    throw new UnsupportedStorageVersionError(stored.v)
  }
  if (!stored || typeof stored.v !== 'number' || !SUPPORTED_STORAGE_VERSIONS.has(stored.v)) {
    return {
      v: STORAGE_SCHEMA_VERSION,
      revision: 0,
      name,
      decoded: 0,
      correct: 0,
      seen: [],
      authored: [],
      authoredCount: 0,
      lastSeenAt: now,
      pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 },
      daily: emptyDaily(dayKey(now)),
      stampedDays: [],
      title: ''
    }
  }

  const pending = asObject(stored.pending)
  const decoded = asNonNegativeInt(stored.decoded)
  const daily = migrateDaily(stored.daily, now)
  const today = dayKey(now)
  const stampedDays = [
    ...new Set(asStringArray(stored.stampedDays, MAX_STAMPED_DAYS).filter((day) => isDayKey(day) && day <= today))
  ]
  if (daily.stamped && !stampedDays.includes(daily.day)) stampedDays.push(daily.day)
  const authored = normalizeAuthored(stored.authored)
  const authoredCount = Math.max(asNonNegativeInt(stored.authoredCount), authoredCountFrom(stored.authored))
  const correct = Math.min(asNonNegativeInt(stored.correct), decoded)
  const migrated: PlayerStats = {
    v: STORAGE_SCHEMA_VERSION,
    revision: asNonNegativeInt(stored.revision),
    name: typeof stored.name === 'string' && stored.name ? stored.name : name,
    decoded,
    correct,
    seen: [...new Set(asStringArray(stored.seen, MAX_PLAYER_SEEN_IDS))],
    authored,
    authoredCount,
    lastSeenAt: asTimestamp(stored.lastSeenAt, now)!,
    pending: {
      triedYou: asNonNegativeInt(pending?.triedYou),
      gotYou: asNonNegativeInt(pending?.gotYou),
      replies: asNonNegativeInt(pending?.replies),
      mail: asNonNegativeInt(pending?.mail)
    },
    daily,
    stampedDays: stampedDays.slice(-MAX_STAMPED_DAYS),
    title: computeTitle({ correct, authored: authoredCount, stamps: stampedDays.length })
  }
  const showSet = migrateShowSet(stored.showSet)
  if (showSet) migrated.showSet = showSet
  return migrated
}

function migrateBoards(value: unknown): Boards {
  const stored = asObject(value)
  if (!stored) return { ...EMPTY_BOARDS }

  const decoders: Boards['decoders'] = []
  if (Array.isArray(stored.decoders)) {
    for (let index = 0; index < stored.decoders.length && decoders.length < 10; index += 1) {
      const row = asObject(stored.decoders[index])
      if (
        !row ||
        typeof row.address !== 'string' ||
        !STABLE_ADDRESS.test(row.address) ||
        utf8Bytes(row.address) > MAX_STORED_ID_BYTES ||
        typeof row.name !== 'string' ||
        utf8Bytes(row.name) > MAX_STORED_NAME_BYTES
      ) {
        continue
      }
      const total = asNonNegativeInt(row.total)
      decoders.push({
        address: row.address,
        name: row.name,
        correct: Math.min(asNonNegativeInt(row.correct), total),
        total
      })
    }
  }

  const hardest: Boards['hardest'] = []
  if (Array.isArray(stored.hardest)) {
    for (let index = 0; index < stored.hardest.length && hardest.length < 10; index += 1) {
      const row = asObject(stored.hardest[index])
      if (
        !row ||
        typeof row.charadeId !== 'string' ||
        utf8Bytes(row.charadeId) > MAX_STORED_ID_BYTES ||
        typeof row.authorName !== 'string' ||
        utf8Bytes(row.authorName) > MAX_STORED_NAME_BYTES
      ) {
        continue
      }
      const total = asNonNegativeInt(row.total)
      hardest.push({
        charadeId: row.charadeId,
        authorName: row.authorName,
        total,
        correct: Math.min(asNonNegativeInt(row.correct), total)
      })
    }
  }

  return { decoders, hardest }
}

function migrateDecoderAggregate(value: unknown): Boards['decoders'] {
  const stored = asObject(value)
  const values = Array.isArray(stored?.decoders) ? stored.decoders : Array.isArray(value) ? value : []
  const decoders: Boards['decoders'] = []
  for (let index = 0; index < values.length && decoders.length < MAX_DAILY_DECODERS; index += 1) {
    const row = asObject(values[index])
    if (
      !row ||
      typeof row.address !== 'string' ||
      !STABLE_ADDRESS.test(row.address) ||
      utf8Bytes(row.address) > MAX_STORED_ID_BYTES ||
      typeof row.name !== 'string' ||
      utf8Bytes(row.name) > MAX_STORED_NAME_BYTES
    ) {
      continue
    }
    const total = asNonNegativeInt(row.total)
    decoders.push({
      address: row.address,
      name: row.name,
      correct: Math.min(asNonNegativeInt(row.correct), total),
      total
    })
  }
  return decoders
}

function migrateRecentVisitors(value: unknown): RecentVisitor[] {
  if (!Array.isArray(value)) return []
  const visitors: RecentVisitor[] = []
  for (let index = 0; index < value.length && visitors.length < MAX_RECENT_VISITOR_INPUTS; index += 1) {
    const item = value[index]
    const look = migrateLook(item)
    const stored = asObject(item)
    const lastSeenAt = stored ? asTimestamp(stored.lastSeenAt) : null
    if (look && lastSeenAt !== null) visitors.push({ ...look, lastSeenAt })
  }
  return visitors
}

function migrateIndex(value: unknown) {
  return [...new Set(asStringArray(value, MAX_INDEX_IDS_PER_DAY))]
}

function isBoundedString(value: unknown, maxBytes = MAX_STORED_ID_BYTES): value is string {
  return typeof value === 'string' && value.length > 0 && utf8Bytes(value) <= maxBytes
}

function isExactNonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= WIRE_INT_MAX
}

function isSafeJournalJSON(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return utf8Bytes(value) <= MAX_DURABLE_JOURNAL_BYTES
  if (depth >= 12) return false
  if (Array.isArray(value)) return value.length <= 512 && value.every((entry) => isSafeJournalJSON(entry, depth + 1))
  const stored = asObject(value)
  if (!stored || Object.keys(stored).length > 256) return false
  return Object.entries(stored).every(
    ([key, entry]) => utf8Bytes(key) <= MAX_STORED_NAME_BYTES && isSafeJournalJSON(entry, depth + 1)
  )
}

function sameJournalJSON(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameJournalJSON(entry, right[index]))
    )
  }
  const leftObject = asObject(left)
  const rightObject = asObject(right)
  if (!leftObject || !rightObject) return false
  const leftKeys = Object.keys(leftObject).sort()
  const rightKeys = Object.keys(rightObject).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJournalJSON(leftObject[key], rightObject[key]))
  )
}

function migrateDurableFingerprint(value: unknown): DurableMutationFingerprint | null {
  const stored = asObject(value)
  if (!stored) return null
  if (stored.kind === 'guess') {
    if (
      !isBoundedString(stored.charadeId) ||
      !Number.isInteger(stored.answerIndex) ||
      (stored.answerIndex as number) < 0 ||
      (stored.answerIndex as number) > 2 ||
      typeof stored.spotlight !== 'boolean' ||
      (stored.roundId !== null &&
        (!isBoundedString(stored.roundId, 64) ||
          !ROUND_ID.test(stored.roundId) ||
          !Number.isSafeInteger(Number(stored.roundId))))
    ) {
      return null
    }
    const fingerprint: DurableMutationFingerprint = {
      kind: 'guess',
      charadeId: stored.charadeId,
      answerIndex: stored.answerIndex as number,
      spotlight: stored.spotlight,
      roundId: stored.roundId as string | null
    }
    return sameJournalJSON(fingerprint, value) ? fingerprint : null
  }
  if (stored.kind !== 'post') return null
  const emotes = exactStrings(stored.emotes, 3, 64)
  if (
    !isBoundedString(stored.phraseId) ||
    !PHRASE_IDS.has(stored.phraseId) ||
    !emotes ||
    emotes.some((emote) => !VALID_EMOTES.has(emote)) ||
    typeof stored.touringConsent !== 'boolean' ||
    (stored.replyTo !== undefined && !isBoundedString(stored.replyTo)) ||
    (stored.recipient !== undefined &&
      (!isBoundedString(stored.recipient) ||
        !STABLE_ADDRESS.test(stored.recipient) ||
        stored.recipient !== stored.recipient.toLowerCase())) ||
    (stored.replyTo !== undefined && stored.recipient !== undefined) ||
    ((stored.replyTo !== undefined || stored.recipient !== undefined) && stored.touringConsent)
  ) {
    return null
  }
  const fingerprint: DurableMutationFingerprint = {
    kind: 'post',
    phraseId: stored.phraseId,
    emotes: [emotes[0], emotes[1], emotes[2]],
    touringConsent: stored.touringConsent,
    ...(stored.replyTo === undefined ? {} : { replyTo: stored.replyTo as string }),
    ...(stored.recipient === undefined ? {} : { recipient: stored.recipient as string })
  }
  return sameJournalJSON(fingerprint, value) ? fingerprint : null
}

function migrateDurableDaily(value: unknown, createdAt: number) {
  const daily = migrateDaily(value, createdAt)
  return sameJournalJSON(daily, value) ? daily : null
}

function migrateDurableProgress(data: Record<string, unknown>) {
  const nextUnlock = asObject(data.nextUnlock)
  if (
    (data.title !== '' && !TITLES.includes(data.title as (typeof TITLES)[number])) ||
    !nextUnlock ||
    (nextUnlock.nextTitle !== '' && !TITLES.includes(nextUnlock.nextTitle as (typeof TITLES)[number])) ||
    !isBoundedString(nextUnlock.requirement, MAX_STORED_NAME_BYTES) ||
    typeof nextUnlock.progress !== 'number' ||
    !Number.isFinite(nextUnlock.progress) ||
    nextUnlock.progress < 0 ||
    nextUnlock.progress > 1
  ) {
    return null
  }
  return {
    title: data.title as PlayerTitle,
    nextUnlock: {
      nextTitle: nextUnlock.nextTitle as PlayerTitle,
      requirement: nextUnlock.requirement,
      progress: nextUnlock.progress
    }
  }
}

function migrateDurableResponse(
  value: unknown,
  fingerprint: DurableMutationFingerprint,
  requestId: string,
  createdAt: number
): DurableMutationResponse | null {
  const stored = asObject(value)
  const data = asObject(stored?.data)
  const expectedType = fingerprint.kind === 'guess' ? 'reveal' : 'posted'
  if (
    !stored ||
    stored.type !== expectedType ||
    !data ||
    data.requestId !== requestId ||
    !isBoundedString(data.charadeId) ||
    !isSafeJournalJSON(data)
  ) {
    return null
  }
  const daily = migrateDurableDaily(data.daily, createdAt)
  const progress = migrateDurableProgress(data)
  if (
    !daily ||
    !progress ||
    !isExactNonNegativeInt(data.revision) ||
    typeof data.stampAwarded !== 'boolean' ||
    typeof data.titleUnlocked !== 'boolean'
  ) {
    return null
  }
  if (fingerprint.kind === 'guess') {
    const phrase = DECK.find((candidate) => candidate.id === data.phraseId)
    const stats = asObject(data.stats)
    if (
      data.charadeId !== fingerprint.charadeId ||
      !phrase ||
      data.phrase !== phrase.text ||
      typeof data.correct !== 'boolean' ||
      !stats ||
      !isExactNonNegativeInt(stats.total) ||
      !isExactNonNegativeInt(stats.correct) ||
      stats.correct > stats.total ||
      !isExactNonNegativeInt(data.yourScore) ||
      (data.attempt !== 1 && data.attempt !== 2) ||
      typeof data.spotlight !== 'boolean' ||
      !Number.isSafeInteger(data.scoreDelta) ||
      ![-100, 0, 50, 100, 200].includes(data.scoreDelta as number) ||
      !isExactNonNegativeInt(data.setRound) ||
      data.setRound > SHOW_SET_SIZE ||
      data.setSize !== SHOW_SET_SIZE ||
      !isExactNonNegativeInt(data.setScore) ||
      data.setScore > SHOW_SET_SIZE * 200 ||
      !isExactNonNegativeInt(data.setStreak) ||
      data.setStreak > SHOW_SET_SIZE ||
      !isExactNonNegativeInt(data.setBestStreak) ||
      data.setBestStreak < data.setStreak ||
      data.setBestStreak > SHOW_SET_SIZE ||
      !isExactNonNegativeInt(data.setUnderstood) ||
      data.setUnderstood > SHOW_SET_SIZE ||
      typeof data.setComplete !== 'boolean' ||
      data.setComplete !== (data.setRound === SHOW_SET_SIZE) ||
      typeof data.isFinale !== 'boolean' ||
      data.isFinale !== data.setComplete
    ) {
      return null
    }
    const response: DurableMutationResponse = {
      type: 'reveal',
      data: {
        requestId,
        charadeId: fingerprint.charadeId,
        correct: data.correct,
        phraseId: phrase.id,
        phrase: phrase.text,
        stats: { total: stats.total, correct: stats.correct },
        yourScore: data.yourScore,
        daily,
        revision: data.revision,
        stampAwarded: data.stampAwarded,
        attempt: data.attempt,
        ...progress,
        titleUnlocked: data.titleUnlocked,
        spotlight: data.spotlight,
        scoreDelta: data.scoreDelta,
        setRound: data.setRound,
        setSize: SHOW_SET_SIZE,
        setScore: data.setScore,
        setStreak: data.setStreak,
        setBestStreak: data.setBestStreak,
        setUnderstood: data.setUnderstood,
        setComplete: data.setComplete,
        isFinale: data.isFinale
      }
    }
    return sameJournalJSON(response, value) ? response : null
  }
  if (
    (fingerprint.replyTo !== undefined &&
      (data.charadeId !== fingerprint.replyTo ||
        data.replyTo !== fingerprint.replyTo ||
        data.recipient !== undefined)) ||
    (fingerprint.replyTo === undefined && data.replyTo !== undefined) ||
    (fingerprint.recipient === undefined && data.recipient !== undefined) ||
    (fingerprint.recipient !== undefined &&
      (!isBoundedString(data.recipient) ||
        !STABLE_ADDRESS.test(data.recipient) ||
        data.recipient.toLowerCase() !== fingerprint.recipient))
  ) {
    return null
  }
  const response: DurableMutationResponse = {
    type: 'posted',
    data: {
      requestId,
      charadeId: data.charadeId,
      ...(fingerprint.replyTo === undefined ? {} : { replyTo: fingerprint.replyTo }),
      ...(fingerprint.recipient === undefined ? {} : { recipient: data.recipient as string }),
      daily,
      revision: data.revision,
      stampAwarded: data.stampAwarded,
      ...progress,
      titleUnlocked: data.titleUnlocked
    }
  }
  return sameJournalJSON(response, value) ? response : null
}

function migrateDurableStatsPatch(value: unknown): DurableStatsPatch | null {
  const stored = asObject(value)
  const after = asObject(stored?.after)
  const pending = asObject(after?.pending)
  if (
    !stored ||
    !after ||
    !pending ||
    !isBoundedString(stored.address) ||
    typeof stored.persistent !== 'boolean' ||
    (stored.seenAdd !== undefined && !isBoundedString(stored.seenAdd)) ||
    (stored.authoredAdd !== undefined && !isBoundedString(stored.authoredAdd)) ||
    (stored.stampedDayAdd !== undefined &&
      (typeof stored.stampedDayAdd !== 'string' || !isDayKey(stored.stampedDayAdd))) ||
    !isBoundedString(after.name, MAX_STORED_NAME_BYTES) ||
    !isExactNonNegativeInt(after.decoded) ||
    !isExactNonNegativeInt(after.correct) ||
    (after.correct as number) > (after.decoded as number) ||
    !isExactNonNegativeInt(after.authoredCount) ||
    asTimestamp(after.lastSeenAt) === null ||
    !isExactNonNegativeInt(pending.triedYou) ||
    !isExactNonNegativeInt(pending.gotYou) ||
    !isExactNonNegativeInt(pending.replies) ||
    !isExactNonNegativeInt(pending.mail) ||
    !isExactNonNegativeInt(after.revision) ||
    (after.title !== '' && !TITLES.includes(after.title as (typeof TITLES)[number]))
  ) {
    return null
  }
  const daily = migrateDaily(after.daily, after.lastSeenAt as number)
  if (!sameJournalJSON(daily, after.daily)) return null
  let showSet: ShowSet | undefined
  if (after.showSet !== undefined) {
    const storedShowSet = asObject(after.showSet)
    if (
      !storedShowSet ||
      !isExactNonNegativeInt(storedShowSet.round) ||
      storedShowSet.round > SHOW_SET_SIZE ||
      !isExactNonNegativeInt(storedShowSet.score) ||
      storedShowSet.score > SHOW_SET_SIZE * 200 ||
      !isExactNonNegativeInt(storedShowSet.streak) ||
      storedShowSet.streak > SHOW_SET_SIZE ||
      !isExactNonNegativeInt(storedShowSet.bestStreak) ||
      storedShowSet.bestStreak > SHOW_SET_SIZE ||
      !isExactNonNegativeInt(storedShowSet.understood) ||
      storedShowSet.understood > SHOW_SET_SIZE ||
      (storedShowSet.showKey !== undefined && !isBoundedString(storedShowSet.showKey))
    ) {
      return null
    }
    showSet = {
      ...(storedShowSet.showKey === undefined ? {} : { showKey: storedShowSet.showKey as string }),
      round: storedShowSet.round,
      score: storedShowSet.score,
      streak: storedShowSet.streak,
      bestStreak: storedShowSet.bestStreak,
      understood: storedShowSet.understood
    }
    if (!sameJournalJSON(showSet, after.showSet)) return null
  }
  return {
    address: stored.address,
    persistent: stored.persistent,
    ...(stored.seenAdd === undefined ? {} : { seenAdd: stored.seenAdd as string }),
    ...(stored.authoredAdd === undefined ? {} : { authoredAdd: stored.authoredAdd as string }),
    ...(stored.stampedDayAdd === undefined ? {} : { stampedDayAdd: stored.stampedDayAdd as string }),
    after: {
      name: after.name as string,
      decoded: after.decoded as number,
      correct: after.correct as number,
      authoredCount: after.authoredCount as number,
      lastSeenAt: after.lastSeenAt as number,
      pending: {
        triedYou: pending.triedYou as number,
        gotYou: pending.gotYou as number,
        replies: pending.replies as number,
        mail: pending.mail as number
      },
      daily,
      revision: after.revision as number,
      title: after.title as PlayerTitle,
      ...(showSet ? { showSet } : {})
    }
  }
}

function migrateDurableBoards(value: unknown): Boards | null {
  const stored = asObject(value)
  if (!stored || !Array.isArray(stored.decoders) || !Array.isArray(stored.hardest)) return null
  if (stored.decoders.length > 10 || stored.hardest.length > 10) return null
  const decoders: Boards['decoders'] = []
  for (const value of stored.decoders) {
    const row = asObject(value)
    if (
      !row ||
      !isBoundedString(row.address) ||
      !isBoundedString(row.name, MAX_STORED_NAME_BYTES) ||
      !isExactNonNegativeInt(row.correct) ||
      !isExactNonNegativeInt(row.total) ||
      row.correct > row.total
    ) {
      return null
    }
    decoders.push({ address: row.address, name: row.name, correct: row.correct, total: row.total })
  }
  const hardest: Boards['hardest'] = []
  for (const value of stored.hardest) {
    const row = asObject(value)
    if (
      !row ||
      !isBoundedString(row.charadeId) ||
      !isBoundedString(row.authorName, MAX_STORED_NAME_BYTES) ||
      !isExactNonNegativeInt(row.correct) ||
      !isExactNonNegativeInt(row.total) ||
      row.correct > row.total
    ) {
      return null
    }
    hardest.push({
      charadeId: row.charadeId,
      authorName: row.authorName,
      correct: row.correct,
      total: row.total
    })
  }
  return { decoders, hardest }
}

function migrateDurableMutation(value: unknown, targetsRequired = true): DurableMutation | null {
  const stored = asObject(value)
  if (
    !stored ||
    stored.v !== 1 ||
    !isBoundedString(stored.id, 256) ||
    !isBoundedString(stored.owner) ||
    !isBoundedString(stored.requestId, 64) ||
    asTimestamp(stored.createdAt) === null ||
    !Array.isArray(stored.stats) ||
    stored.stats.length > 3
  ) {
    return null
  }
  const fingerprint = migrateDurableFingerprint(stored.fingerprint)
  if (!fingerprint) return null
  const response = migrateDurableResponse(stored.response, fingerprint, stored.requestId, stored.createdAt as number)
  if (!response) return null
  let notifiedAuthor: string | undefined
  if (stored.notifiedAuthor !== undefined) {
    if (!isBoundedString(stored.notifiedAuthor) || stored.notifiedAuthor !== stored.notifiedAuthor.toLowerCase()) {
      return null
    }
    notifiedAuthor = stored.notifiedAuthor
  }
  const stats: DurableStatsPatch[] = []
  for (const value of stored.stats) {
    const patch = migrateDurableStatsPatch(value)
    if (!patch || stats.some((entry) => entry.address.toLowerCase() === patch.address.toLowerCase())) return null
    stats.push(patch)
  }
  let charade: Charade | undefined
  if (stored.charade !== undefined) {
    const migrated = migrateCharade(stored.charade)
    if (!migrated || !sameJournalJSON(migrated, stored.charade)) return null
    charade = migrated
  }
  let decoder: DurableMutation['decoder']
  if (stored.decoder !== undefined) {
    const decoderValue = asObject(stored.decoder)
    const row = asObject(decoderValue?.row)
    if (
      !decoderValue ||
      typeof decoderValue.day !== 'string' ||
      !isDayKey(decoderValue.day) ||
      !row ||
      !isBoundedString(row.address) ||
      !isBoundedString(row.name, MAX_STORED_NAME_BYTES) ||
      !isExactNonNegativeInt(row.correct) ||
      !isExactNonNegativeInt(row.total) ||
      (row.correct as number) > (row.total as number)
    ) {
      return null
    }
    decoder = {
      day: decoderValue.day,
      row: {
        address: row.address,
        name: row.name,
        correct: row.correct,
        total: row.total
      }
    }
  }
  let boards: DurableMutation['boards']
  if (stored.boards !== undefined) {
    const boardValue = asObject(stored.boards)
    if (!boardValue || typeof boardValue.day !== 'string' || !isDayKey(boardValue.day)) return null
    const migrated = migrateDurableBoards(boardValue.value)
    if (!migrated || !sameJournalJSON(migrated, boardValue.value)) return null
    boards = { day: boardValue.day, value: migrated }
  }
  const mutation: DurableMutation = {
    v: 1,
    id: stored.id,
    owner: stored.owner,
    requestId: stored.requestId,
    createdAt: stored.createdAt as number,
    fingerprint,
    response,
    ...(notifiedAuthor ? { notifiedAuthor } : {}),
    ...(charade ? { charade } : {}),
    stats,
    ...(decoder ? { decoder } : {}),
    ...(boards ? { boards } : {})
  }
  const ownerPatch = stats.find((patch) => patch.address === mutation.owner)
  const responseData = mutation.response.data
  if (
    mutation.owner !== mutation.owner.toLowerCase() ||
    mutation.id !== `${mutation.owner}:${mutation.fingerprint.kind}:${mutation.requestId}` ||
    stats.some(
      (patch) => patch.address !== patch.address.toLowerCase() || patch.after.lastSeenAt !== mutation.createdAt
    ) ||
    (mutation.notifiedAuthor !== undefined && mutation.fingerprint.kind !== 'guess') ||
    (mutation.decoder !== undefined && mutation.boards === undefined) ||
    (mutation.boards !== undefined && mutation.fingerprint.kind !== 'guess') ||
    (mutation.decoder !== undefined &&
      (mutation.fingerprint.kind !== 'guess' ||
        mutation.decoder.row.address !== mutation.owner ||
        mutation.boards?.day !== mutation.decoder.day))
  ) {
    return null
  }
  if (mutation.fingerprint.kind === 'guess') {
    const responseStats = asObject(responseData.stats)
    const notifiedPatch = mutation.notifiedAuthor
      ? stats.find((patch) => patch.address === mutation.notifiedAuthor)
      : undefined
    const mutationDay = dayKey(mutation.createdAt)
    if (
      responseData.charadeId !== mutation.fingerprint.charadeId ||
      (targetsRequired && !ownerPatch) ||
      (targetsRequired && stats.length !== 1 + (mutation.notifiedAuthor ? 1 : 0)) ||
      (targetsRequired && mutation.notifiedAuthor !== undefined && (!notifiedPatch || !notifiedPatch.persistent)) ||
      (targetsRequired && mutation.notifiedAuthor !== undefined && !ownerPatch?.persistent) ||
      stats.some((patch) => patch.authoredAdd !== undefined) ||
      (ownerPatch !== undefined &&
        ((ownerPatch.seenAdd !== undefined && ownerPatch.seenAdd !== mutation.fingerprint.charadeId) ||
          (ownerPatch.stampedDayAdd !== undefined && ownerPatch.stampedDayAdd !== mutationDay))) ||
      (notifiedPatch !== undefined &&
        (notifiedPatch.seenAdd !== undefined ||
          notifiedPatch.authoredAdd !== undefined ||
          notifiedPatch.stampedDayAdd !== undefined)) ||
      (targetsRequired && (mutation.charade === undefined) !== (mutation.boards === undefined)) ||
      (mutation.charade === undefined && mutation.decoder !== undefined) ||
      (mutation.charade !== undefined &&
        (mutation.charade.id !== mutation.fingerprint.charadeId ||
          mutation.notifiedAuthor !== mutation.charade.author.address.toLowerCase() ||
          mutation.charade.isHouse ||
          mutation.charade.recipient !== undefined ||
          mutation.charade.lastGuessAt !== mutation.createdAt ||
          mutation.boards?.day !== mutationDay ||
          mutation.charade.author.isGuest ||
          !ownerPatch?.persistent ||
          mutation.charade.phraseId !== responseData.phraseId ||
          !responseStats ||
          !sameJournalJSON(mutation.charade.guesses, responseStats))) ||
      (ownerPatch !== undefined &&
        (ownerPatch.after.correct !== responseData.yourScore ||
          ownerPatch.after.revision !== responseData.revision ||
          !sameJournalJSON(ownerPatch.after.daily, responseData.daily) ||
          ownerPatch.after.title !== responseData.title ||
          Boolean(ownerPatch.stampedDayAdd) !== responseData.stampAwarded ||
          !ownerPatch.after.showSet ||
          ownerPatch.after.showSet.round !== responseData.setRound ||
          ownerPatch.after.showSet.score !== responseData.setScore ||
          ownerPatch.after.showSet.streak !== responseData.setStreak ||
          ownerPatch.after.showSet.bestStreak !== responseData.setBestStreak ||
          ownerPatch.after.showSet.understood !== responseData.setUnderstood))
    ) {
      return null
    }
  } else {
    if (mutation.notifiedAuthor || mutation.decoder || mutation.boards || (targetsRequired && !mutation.charade)) {
      return null
    }
    if (mutation.charade) {
      const fingerprint = mutation.fingerprint
      if (fingerprint.replyTo !== undefined) {
        const reply = mutation.charade.reply
        const authorPatch = stats.find((patch) => patch.address === mutation.charade!.author.address.toLowerCase())
        if (
          mutation.charade.id !== fingerprint.replyTo ||
          mutation.charade.phraseId !== fingerprint.phraseId ||
          !reply ||
          reply.requestId !== mutation.requestId ||
          reply.address.toLowerCase() !== mutation.owner ||
          mutation.charade.author.address.toLowerCase() === mutation.owner ||
          (mutation.charade.recipient !== undefined && mutation.charade.recipient.toLowerCase() !== mutation.owner) ||
          !sameJournalJSON(reply.emotes, fingerprint.emotes) ||
          reply.createdAt !== mutation.createdAt ||
          responseData.charadeId !== mutation.charade.id ||
          responseData.replyTo !== mutation.charade.id ||
          responseData.stampAwarded !== false ||
          responseData.titleUnlocked !== false ||
          stats.length !== 1 ||
          !authorPatch ||
          authorPatch.seenAdd !== undefined ||
          authorPatch.authoredAdd !== undefined ||
          authorPatch.stampedDayAdd !== undefined ||
          authorPatch.persistent !== !mutation.charade.author.isGuest
        ) {
          return null
        }
      } else if (
        mutation.charade.id !== responseData.charadeId ||
        mutation.charade.author.address.toLowerCase() !== mutation.owner ||
        mutation.charade.author.isGuest ||
        mutation.charade.phraseId !== fingerprint.phraseId ||
        !sameJournalJSON(mutation.charade.emotes, fingerprint.emotes) ||
        mutation.charade.touringConsent !== fingerprint.touringConsent ||
        (mutation.charade.recipient?.toLowerCase() ?? undefined) !== fingerprint.recipient ||
        mutation.charade.createdAt !== mutation.createdAt ||
        mutation.charade.reply !== undefined ||
        mutation.charade.lastGuessAt !== 0 ||
        mutation.charade.guesses.total !== 0 ||
        mutation.charade.guesses.correct !== 0 ||
        mutation.charade.isHouse ||
        !ownerPatch ||
        !ownerPatch.persistent ||
        ownerPatch.seenAdd !== undefined ||
        (fingerprint.recipient === undefined && ownerPatch.authoredAdd !== mutation.charade.id) ||
        (fingerprint.recipient === undefined &&
          ownerPatch.stampedDayAdd !== undefined &&
          ownerPatch.stampedDayAdd !== dayKey(mutation.createdAt)) ||
        (fingerprint.recipient !== undefined &&
          (ownerPatch.authoredAdd !== undefined ||
            ownerPatch.stampedDayAdd !== undefined ||
            stats.some(
              (patch) =>
                patch.address === fingerprint.recipient &&
                (patch.seenAdd !== undefined || patch.authoredAdd !== undefined || patch.stampedDayAdd !== undefined)
            ))) ||
        stats.length !== (fingerprint.recipient === undefined ? 1 : 2) ||
        (fingerprint.recipient !== undefined &&
          !stats.some(
            (patch) => patch.address === fingerprint.recipient && patch.persistent && patch.address !== mutation.owner
          )) ||
        ownerPatch.after.revision !== responseData.revision ||
        !sameJournalJSON(ownerPatch.after.daily, responseData.daily) ||
        ownerPatch.after.title !== responseData.title ||
        Boolean(ownerPatch.stampedDayAdd) !== responseData.stampAwarded
      ) {
        return null
      }
    }
  }
  if (!targetsRequired && (mutation.charade || mutation.stats.length > 0 || mutation.decoder || mutation.boards))
    return null
  return sameJournalJSON(mutation, value) ? mutation : null
}

function migrateDurableCompletion(value: unknown): DurableCompletion | null {
  const stored = asObject(value)
  if (!stored || asTimestamp(stored.completedAt) === null) return null
  const mutation = migrateDurableMutation(
    {
      v: stored.v,
      id: stored.id,
      owner: stored.owner,
      requestId: stored.requestId,
      createdAt: stored.createdAt,
      fingerprint: stored.fingerprint,
      response: stored.response,
      stats: []
    },
    false
  )
  if (!mutation) return null
  if ((stored.completedAt as number) < mutation.createdAt) return null
  const completion: DurableCompletion = {
    v: 1,
    id: mutation.id,
    owner: mutation.owner,
    requestId: mutation.requestId,
    createdAt: mutation.createdAt,
    fingerprint: mutation.fingerprint,
    response: mutation.response,
    completedAt: stored.completedAt as number
  }
  return sameJournalJSON(completion, value) ? completion : null
}

function migrateDurableJournal(value: unknown): DurableMutationJournal | null {
  const stored = asObject(value)
  if (
    !stored ||
    stored.v !== 1 ||
    !Array.isArray(stored.completed) ||
    stored.completed.length > MAX_DURABLE_COMPLETIONS
  ) {
    return null
  }
  const active = stored.active === null ? null : migrateDurableMutation(stored.active)
  if (stored.active !== null && !active) return null
  const completed: DurableCompletion[] = []
  for (const value of stored.completed) {
    const entry = migrateDurableCompletion(value)
    if (!entry || completed.some((candidate) => candidate.id === entry.id)) return null
    completed.push(entry)
  }
  if (active && completed.some((entry) => entry.id === active.id)) return null
  const journal = { v: 1 as const, active, completed }
  return sameJournalJSON(journal, value) && utf8Bytes(JSON.stringify(journal)) <= MAX_DURABLE_JOURNAL_BYTES
    ? journal
    : null
}

function completionFor(mutation: DurableMutation, completedAt: number): DurableCompletion {
  return {
    v: 1,
    id: mutation.id,
    owner: mutation.owner,
    requestId: mutation.requestId,
    createdAt: mutation.createdAt,
    fingerprint: mutation.fingerprint,
    response: mutation.response,
    completedAt
  }
}

function fitDurableJournal(journal: DurableMutationJournal) {
  while (
    journal.completed.length > 0 &&
    (journal.completed.length > MAX_DURABLE_COMPLETIONS ||
      utf8Bytes(JSON.stringify(journal)) > MAX_DURABLE_JOURNAL_BYTES)
  ) {
    journal.completed.shift()
  }
  if (utf8Bytes(JSON.stringify(journal)) > MAX_DURABLE_JOURNAL_BYTES) {
    throw new StorageCapacityError('Durable mutation journal capacity exceeded')
  }
  return journal
}

function computeBoardsFor(
  day: string,
  charades: Iterable<Charade>,
  decoders: Iterable<Boards['decoders'][number]>
): Boards {
  const decoderBoard = [...decoders]
    .sort((a, b) => b.correct - a.correct || b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, 10)
  const hardest = [...charades]
    .filter(
      (charade) =>
        !charade.isHouse &&
        !charade.author.isGuest &&
        charade.recipient === undefined &&
        dayKey(charade.createdAt) === day &&
        charade.guesses.total >= 3
    )
    .sort((a, b) => {
      const aDifference = BigInt(a.guesses.correct) * 5n - BigInt(a.guesses.total) * 3n
      const bDifference = BigInt(b.guesses.correct) * 5n - BigInt(b.guesses.total) * 3n
      const distanceComparison =
        (aDifference < 0n ? -aDifference : aDifference) * BigInt(b.guesses.total) -
        (bDifference < 0n ? -bDifference : bDifference) * BigInt(a.guesses.total)
      if (distanceComparison !== 0n) return distanceComparison < 0n ? -1 : 1
      return b.guesses.total - a.guesses.total || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    })
    .slice(0, 10)
    .map((charade) => ({
      charadeId: charade.id,
      authorName: charade.author.name,
      total: charade.guesses.total,
      correct: charade.guesses.correct
    }))
  return { decoders: decoderBoard, hardest }
}

export function dayKey(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export class GhostlightState {
  readonly charades = new Map<string, Charade>()
  readonly playerStats = new Map<string, PlayerStats>()
  recentVisitors: RecentVisitor[] = []
  boards: Boards = { decoders: [], hardest: [] }

  private readonly indexes = new Map<string, string[]>()
  private readonly dailyDecoders = new Map<string, Boards['decoders'][number]>()
  private readonly statsLoads = new Map<string, Promise<PlayerStats>>()
  private readonly statsAccess = new Map<string, number>()
  private accessSequence = 0
  private decoderDay: string | null = null
  private acceptedDay: string | null = null
  private storageReadOnly = false
  private durableJournal: DurableMutationJournal = { v: 1, active: null, completed: [] }

  constructor(
    private readonly storage: StateStorage = defaultStorage,
    private readonly now: () => number = Date.now
  ) {}

  get isReadOnly() {
    return this.storageReadOnly
  }

  async hydrate() {
    const now = this.now()
    const today = dayKey(now)
    const days = Array.from({ length: HYDRATION_DAYS }, (_, offset) => dayKey(now - offset * DAY_MILLISECONDS))
    const ids = new Map<string, string>()
    this.acceptedDay = today
    this.storageReadOnly = false
    this.durableJournal = { v: 1, active: null, completed: [] }
    this.charades.clear()
    HOUSE_CHARADES.forEach((charade) => this.charades.set(charade.id, charade))
    const loadFoundational = async <T>(key: string, fallback: T) => {
      try {
        return await this.storage.loadJSON<T>(key, fallback)
      } catch (error) {
        if (!(error instanceof StorageCorruptError)) throw error
        this.storageReadOnly = true
        return fallback
      }
    }
    let journalValue: unknown
    try {
      journalValue = await this.storage.loadJSON<unknown>(DURABLE_MUTATION_JOURNAL_KEY, {
        v: 1,
        active: null,
        completed: []
      })
    } catch (error) {
      if (!(error instanceof StorageCorruptError)) throw error
      this.storageReadOnly = true
      return
    }
    const durableJournal = migrateDurableJournal(journalValue)
    if (!durableJournal) {
      this.storageReadOnly = true
      return
    }
    this.durableJournal = durableJournal
    const activeTarget = durableJournal.active?.charade
    const activeTargetDay = activeTarget ? dayKey(activeTarget.createdAt) : null
    const activeTargetRetained = activeTargetDay !== null && days.includes(activeTargetDay)
    const indexDays = activeTargetDay && !days.includes(activeTargetDay) ? [...days, activeTargetDay] : days
    const repairedTargetIndexes: Array<{ day: string; ids: string[] }> = []
    this.indexes.clear()
    if (activeTarget && activeTargetDay && activeTargetRetained) ids.set(activeTarget.id, activeTargetDay)
    for (let offset = 0; offset < indexDays.length; offset += MAX_CONCURRENT_READS) {
      const batch = indexDays.slice(offset, offset + MAX_CONCURRENT_READS)
      const values = await Promise.all(batch.map((day) => loadFoundational<unknown>(indexKey(day), [])))
      values.forEach((value, index) => {
        const day = batch[index]
        let dayIndex = migrateIndex(value)
        if (activeTarget && day === activeTargetDay && !dayIndex.includes(activeTarget.id)) {
          if (dayIndex.length >= MAX_INDEX_IDS_PER_DAY) {
            this.storageReadOnly = true
          } else {
            dayIndex = [...dayIndex, activeTarget.id]
            repairedTargetIndexes.push({ day, ids: dayIndex })
          }
        }
        this.indexes.set(day, dayIndex)
        dayIndex.forEach((id) => {
          if (days.includes(day) && ids.size < MAX_LIVE_CHARADES && !ids.has(id)) ids.set(id, day)
        })
      })
    }
    const [visitorsValue, boardsValue, decoderAggregateValue] = await Promise.all([
      loadFoundational<unknown>(RECENT_VISITORS_KEY, []),
      loadFoundational<unknown>(boardsKey(today), EMPTY_BOARDS),
      loadFoundational<unknown>(decoderAggregateKey(today), null)
    ])

    if (this.storageReadOnly) {
      this.recentVisitors = []
      this.boards = { ...EMPTY_BOARDS }
      this.dailyDecoders.clear()
      this.decoderDay = today
      return
    }
    for (const repairedTargetIndex of repairedTargetIndexes) {
      this.storage.markDirty(indexKey(repairedTargetIndex.day), repairedTargetIndex.ids)
    }

    const visitorAddresses = new Set<string>()
    this.recentVisitors = migrateRecentVisitors(visitorsValue)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .filter((visitor) => {
        const address = visitor.address.toLowerCase()
        if (visitorAddresses.has(address)) return false
        visitorAddresses.add(address)
        return true
      })
      .slice(0, AUDIENCE_SEATS)
    this.boards = migrateBoards(boardsValue)
    this.dailyDecoders.clear()
    this.decoderDay = today
    const restoredDecoders = migrateDecoderAggregate(decoderAggregateValue ?? boardsValue)
    restoredDecoders.forEach((row) => this.dailyDecoders.set(row.address.toLowerCase(), row))

    const charadeIds = [...ids.entries()]
    for (let offset = 0; offset < charadeIds.length; offset += MAX_CONCURRENT_READS) {
      const batch = charadeIds.slice(offset, offset + MAX_CONCURRENT_READS)
      const values = await Promise.all(
        batch.map(async ([id, expectedDay]) => {
          try {
            return { id, expectedDay, value: await this.storage.loadJSON<unknown>(charadeKey(id), null) }
          } catch (error) {
            if (error instanceof StorageCorruptError) return { id, expectedDay, value: null }
            throw error
          }
        })
      )
      values.forEach(({ expectedDay, value }) => {
        const charade = migrateCharade(value, { expectedDay, now })
        if (charade && !charade.isHouse) this.charades.set(charade.id, charade)
      })
    }
    if (
      activeTarget &&
      durableJournal.active?.fingerprint.kind === 'post' &&
      durableJournal.active.fingerprint.replyTo !== undefined &&
      !this.charades.has(activeTarget.id)
    ) {
      this.charades.set(activeTarget.id, activeTarget)
    }

    this.recomputeBoards(false)
    if (this.durableJournal.active) {
      await this.recoverDurableMutation(this.durableJournal.active.id, this.now())
      if (activeTarget && !activeTargetRetained) {
        this.charades.delete(activeTarget.id)
        this.recomputeBoards(false)
      }
    }
  }

  getActiveDurableMutation(id?: string) {
    const active = this.durableJournal.active
    return active && (id === undefined || active.id === id) ? active : null
  }

  getDurableCompletion(owner: string, kind: DurableMutationFingerprint['kind'], requestId: string) {
    const wanted = owner.toLowerCase()
    return (
      this.durableJournal.completed
        .slice()
        .reverse()
        .find(
          (entry) =>
            entry.owner.toLowerCase() === wanted && entry.fingerprint.kind === kind && entry.requestId === requestId
        ) ?? null
    )
  }

  async beginDurableMutation(value: DurableMutation) {
    if (this.storageReadOnly || !this.storage.saveJSONNow) {
      throw new StorageUnavailableError([`scene:${DURABLE_MUTATION_JOURNAL_KEY}`])
    }
    const mutation = migrateDurableMutation(value)
    if (!mutation) throw new StorageCapacityError('Invalid durable mutation')
    const active = this.durableJournal.active
    if (active) {
      if (active.id === mutation.id && sameJournalJSON(active, mutation)) return active
      throw new StorageUnavailableError([`scene:${DURABLE_MUTATION_JOURNAL_KEY}`])
    }
    const next = fitDurableJournal({
      v: 1,
      active: mutation,
      completed: this.durableJournal.completed.filter((entry) => entry.id !== mutation.id)
    })
    await this.storage.saveJSONNow(DURABLE_MUTATION_JOURNAL_KEY, next)
    this.durableJournal = next
    return mutation
  }

  async completeDurableMutation(id: string, completedAt = this.now()) {
    if (this.storageReadOnly || !this.storage.saveJSONNow) {
      throw new StorageUnavailableError([`scene:${DURABLE_MUTATION_JOURNAL_KEY}`])
    }
    const active = this.durableJournal.active
    if (!active) {
      if (this.durableJournal.completed.some((entry) => entry.id === id)) return
      throw new StorageUnavailableError([`scene:${DURABLE_MUTATION_JOURNAL_KEY}`])
    }
    if (active.id !== id || asTimestamp(completedAt) === null) {
      throw new StorageUnavailableError([`scene:${DURABLE_MUTATION_JOURNAL_KEY}`])
    }
    const next = fitDurableJournal({
      v: 1,
      active: null,
      completed: [
        ...this.durableJournal.completed.filter((entry) => entry.id !== id),
        completionFor(active, Math.max(completedAt, active.createdAt))
      ]
    })
    await this.storage.saveJSONNow(DURABLE_MUTATION_JOURNAL_KEY, next)
    this.durableJournal = next
  }

  async recoverDurableMutation(id: string, completedAt = this.now()) {
    if (this.storageReadOnly || !this.storage.flushNow) {
      throw new StorageUnavailableError(['durable-mutation-recovery'])
    }
    const active = this.durableJournal.active
    if (!active || active.id !== id) {
      if (this.durableJournal.completed.some((entry) => entry.id === id)) return null
      throw new StorageUnavailableError([`scene:${DURABLE_MUTATION_JOURNAL_KEY}`])
    }
    await this.storage.flushNow()
    await this.applyDurableMutation(active)
    await this.storage.flushNow()
    await this.completeDurableMutation(active.id, completedAt)
    return active
  }

  async applyDurableMutation(mutation: DurableMutation) {
    if (this.storageReadOnly) throw new StorageUnavailableError(['durable-mutation-recovery'])
    if (mutation.charade) {
      if (mutation.fingerprint.kind === 'post' && mutation.fingerprint.replyTo !== undefined) {
        const current = this.charades.get(mutation.charade.id)
        if (!current || current.isHouse) throw new StorageCapacityError('Durable reply target missing')
        this.storage.markDirty(charadeKey(mutation.charade.id), mutation.charade)
        this.charades.set(mutation.charade.id, mutation.charade)
      } else if (!this.upsertCharade(mutation.charade)) {
        throw new StorageCapacityError('Durable charade capacity exceeded')
      }
    }
    for (const patch of mutation.stats) {
      const key = patch.address.toLowerCase()
      const stats = await this.getOrCreateStats(key, patch.after.name, patch.persistent)
      stats.name = patch.after.name
      stats.decoded = patch.after.decoded
      stats.correct = patch.after.correct
      if (patch.seenAdd && !stats.seen.includes(patch.seenAdd)) stats.seen.push(patch.seenAdd)
      if (patch.authoredAdd && !stats.authored.includes(patch.authoredAdd)) stats.authored.push(patch.authoredAdd)
      stats.seen = [...new Set(stats.seen)].filter((id) => {
        const charade = this.charades.get(id)
        return charade !== undefined && !charade.isHouse
      })
      stats.authored = normalizeAuthored(stats.authored)
      stats.authoredCount = Math.max(patch.after.authoredCount, stats.authored.length)
      stats.lastSeenAt = patch.after.lastSeenAt
      stats.pending = { ...patch.after.pending }
      stats.daily = { ...patch.after.daily }
      if (patch.stampedDayAdd && !stats.stampedDays.includes(patch.stampedDayAdd)) {
        stats.stampedDays.push(patch.stampedDayAdd)
      }
      stats.stampedDays = [...new Set(stats.stampedDays)].slice(-MAX_STAMPED_DAYS)
      stats.revision = patch.after.revision
      stats.title = patch.after.title
      if (patch.after.showSet) stats.showSet = { ...patch.after.showSet }
      else delete stats.showSet
      if (patch.persistent) this.storage.markPlayerDirty(key, PLAYER_STATS_KEY, stats)
    }
    if (mutation.decoder) {
      const key = mutation.decoder.row.address.toLowerCase()
      if (mutation.decoder.day === this.decoderDay) {
        this.dailyDecoders.set(key, { ...mutation.decoder.row })
        this.storage.markDirty(decoderAggregateKey(mutation.decoder.day), [...this.dailyDecoders.values()])
      } else {
        const stored = await this.storage.loadJSON<unknown>(decoderAggregateKey(mutation.decoder.day), [])
        const rows = migrateDecoderAggregate(stored)
        const index = rows.findIndex((row) => row.address.toLowerCase() === key)
        if (index >= 0) rows[index] = { ...mutation.decoder.row }
        else rows.push({ ...mutation.decoder.row })
        this.storage.markDirty(decoderAggregateKey(mutation.decoder.day), rows.slice(0, MAX_DAILY_DECODERS))
      }
    }
    if (mutation.boards) {
      const value = {
        decoders: mutation.boards.value.decoders.map((row) => ({ ...row })),
        hardest: mutation.boards.value.hardest.map((row) => ({ ...row }))
      }
      if (mutation.boards.day === this.decoderDay) this.boards = value
      this.storage.markDirty(boardsKey(mutation.boards.day), value)
    }
  }

  getCharade(id: string) {
    return this.charades.get(id) ?? null
  }

  getPool() {
    if (this.storageReadOnly) return []
    return [...this.charades.values()]
      .filter((charade) => !charade.isHouse && charade.recipient === undefined)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  getPlayerCharades() {
    if (this.storageReadOnly) return []
    return [...this.charades.values()]
      .filter((charade) => !charade.isHouse)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  canUpsertCharade(charade: Charade) {
    if (this.storageReadOnly) return false
    if (charade.isHouse || this.charades.has(charade.id)) return true
    const day = dayKey(charade.createdAt)
    const currentIds = this.indexes.get(day) ?? []
    return (
      (currentIds.includes(charade.id) || currentIds.length < MAX_INDEX_IDS_PER_DAY) &&
      [...this.charades.values()].filter((candidate) => !candidate.isHouse).length < MAX_LIVE_CHARADES
    )
  }

  previewRankedGuess(charade: Charade, address: string, name: string, correct: boolean) {
    const day = this.ensureDecoderDay()
    const key = address.toLowerCase()
    const decoders = new Map(this.dailyDecoders)
    let decoder: DurableMutation['decoder']
    if (decoders.has(key) || decoders.size < MAX_DAILY_DECODERS) {
      const current = decoders.get(key) ?? { address, name, correct: 0, total: 0 }
      const row = {
        address,
        name,
        correct: Math.min(current.correct + (correct ? 1 : 0), WIRE_INT_MAX),
        total: Math.min(current.total + 1, WIRE_INT_MAX)
      }
      decoders.set(key, row)
      decoder = { day, row }
    }
    const charades = new Map(this.charades)
    charades.set(charade.id, charade)
    return {
      decoder,
      boards: { day, value: computeBoardsFor(day, charades.values(), decoders.values()) }
    }
  }

  getMailForRecipient(
    address: string,
    seen: readonly string[],
    exclude: readonly string[] = [],
    allowedPrimaryPhraseIds?: ReadonlySet<string>
  ) {
    const wanted = address.toLowerCase()
    const skipped = new Set([...seen, ...exclude])
    return (
      this.getPlayerCharades().find(
        (charade) =>
          charade.recipient?.toLowerCase() === wanted &&
          !skipped.has(charade.id) &&
          (allowedPrimaryPhraseIds === undefined || allowedPrimaryPhraseIds.has(charade.phraseId))
      ) ?? null
    )
  }

  countMailForRecipient(address: string, seen: readonly string[], allowedPrimaryPhraseIds?: ReadonlySet<string>) {
    const wanted = address.toLowerCase()
    const seenIds = new Set(seen)
    return this.getPlayerCharades().filter(
      (charade) =>
        charade.recipient?.toLowerCase() === wanted &&
        !seenIds.has(charade.id) &&
        (allowedPrimaryPhraseIds === undefined || allowedPrimaryPhraseIds.has(charade.phraseId))
    ).length
  }

  getKnownRecipient(address: string) {
    const wanted = address.toLowerCase()
    const visitor = this.recentVisitors.find(
      (candidate) => candidate.address.toLowerCase() === wanted && !candidate.isGuest
    )
    if (visitor) return visitor
    return (
      this.getPool()
        .slice()
        .reverse()
        .find((charade) => charade.author.address.toLowerCase() === wanted && !charade.author.isGuest)?.author ?? null
    )
  }

  async getRecentPerformers(limit = 6): Promise<PlaybillPerformer[]> {
    const charades = this.getPool()
      .filter((charade) => !charade.author.isGuest)
      .slice(-limit)
      .reverse()
    return charades.map((charade) => {
      const stats = this.playerStats.get(charade.author.address.toLowerCase())
      return {
        address: charade.author.address,
        name: charade.author.name,
        isGuest: charade.author.isGuest,
        title: stats ? this.getPlayerProgress(stats).title : '',
        performedAt: charade.createdAt
      }
    })
  }

  async getGhostOfNight() {
    this.recomputeBoards(false)
    const row = this.boards.hardest[0]
    if (!row) return null
    const charade = this.charades.get(row.charadeId)
    if (!charade || charade.isHouse) return null
    const stats = this.playerStats.get(charade.author.address.toLowerCase())
    return { charade, title: stats ? this.getPlayerProgress(stats).title : '' }
  }

  upsertCharade(charade: Charade) {
    if (!this.canUpsertCharade(charade)) return false
    if (charade.isHouse) {
      this.charades.set(charade.id, charade)
      return true
    }

    const day = dayKey(charade.createdAt)
    const currentIds = this.indexes.get(day) ?? []
    const isNew = !this.charades.has(charade.id)
    const hasReservedIndexSlot = currentIds.includes(charade.id)
    if (
      isNew &&
      ((!hasReservedIndexSlot && currentIds.length >= MAX_INDEX_IDS_PER_DAY) ||
        [...this.charades.values()].filter((candidate) => !candidate.isHouse).length >= MAX_LIVE_CHARADES)
    ) {
      return false
    }
    const ids = currentIds.includes(charade.id) ? currentIds : [...currentIds, charade.id]
    const today = this.ensureDecoderDay()
    const reservedBoards: Boards = {
      decoders: this.boards.decoders,
      hardest:
        charade.recipient === undefined && !charade.author.isGuest && charade.guesses.total >= 3
          ? [
              ...this.boards.hardest,
              {
                charadeId: charade.id,
                authorName: charade.author.name,
                total: charade.guesses.total,
                correct: charade.guesses.correct
              }
            ].slice(0, 10)
          : this.boards.hardest
    }
    const entries = [
      { key: charadeKey(charade.id), value: charade },
      ...(ids === currentIds ? [] : [{ key: indexKey(day), value: ids }]),
      { key: boardsKey(today), value: reservedBoards },
      { key: decoderAggregateKey(today), value: [...this.dailyDecoders.values()] }
    ]
    if (this.storage.markDirtyBatch) this.storage.markDirtyBatch(entries)
    else entries.forEach((entry) => this.storage.markDirty(entry.key, entry.value))

    this.charades.set(charade.id, charade)
    if (ids !== currentIds) this.indexes.set(day, ids)
    this.recomputeBoards()
    return true
  }

  attachReply(charadeId: string, reply: CharadeReply) {
    if (this.storageReadOnly) return false
    const current = this.charades.get(charadeId)
    if (!current || current.isHouse || current.reply) return false
    const updated: Charade = { ...current, reply }
    this.storage.markDirty(charadeKey(charadeId), updated)
    this.charades.set(charadeId, updated)
    return true
  }

  recordGuess(charadeId: string, correct: boolean) {
    const current = this.charades.get(charadeId)
    if (!current || current.isHouse) return current ?? null
    if (this.storageReadOnly) return current

    const updated: Charade = {
      ...current,
      guesses: {
        total: Math.min(current.guesses.total + 1, WIRE_INT_MAX),
        correct: Math.min(current.guesses.correct + (correct ? 1 : 0), WIRE_INT_MAX)
      },
      lastGuessAt: this.now()
    }
    this.storage.markDirty(charadeKey(charadeId), updated)
    this.charades.set(charadeId, updated)
    this.recomputeBoards()
    return updated
  }

  touchVisitor(look: Look) {
    const visitor: RecentVisitor = { ...look, lastSeenAt: this.now() }
    const address = look.address.toLowerCase()
    const recentVisitors = [
      visitor,
      ...this.recentVisitors.filter((entry) => entry.address.toLowerCase() !== address)
    ].slice(0, AUDIENCE_SEATS)
    if (!this.storageReadOnly) this.storage.markDirty(RECENT_VISITORS_KEY, recentVisitors)
    this.recentVisitors = recentVisitors
    return visitor
  }

  recordDecoder(address: string, name: string, correct: boolean, ranked = true) {
    if (this.storageReadOnly) return this.boards
    this.ensureDecoderDay()
    if (!ranked) return this.boards
    const key = address.toLowerCase()
    if (!this.dailyDecoders.has(key) && this.dailyDecoders.size >= MAX_DAILY_DECODERS) return this.boards
    const current = this.dailyDecoders.get(key) ?? { address, name, correct: 0, total: 0 }
    this.dailyDecoders.set(key, {
      address,
      name,
      correct: Math.min(current.correct + (correct ? 1 : 0), WIRE_INT_MAX),
      total: Math.min(current.total + 1, WIRE_INT_MAX)
    })
    return this.recomputeBoards()
  }

  recomputeBoards(markForStorage = true) {
    const today = this.ensureDecoderDay()
    this.boards = computeBoardsFor(today, this.charades.values(), this.dailyDecoders.values())
    if (markForStorage && !this.storageReadOnly) {
      this.storage.markDirty(boardsKey(today), this.boards)
      this.storage.markDirty(decoderAggregateKey(today), [...this.dailyDecoders.values()])
    }
    return this.boards
  }

  private ensureDecoderDay(today = dayKey(this.now())) {
    const acceptedDay = this.acceptDay(today)
    if (this.decoderDay !== acceptedDay) {
      this.dailyDecoders.clear()
      this.decoderDay = acceptedDay
    }
    return acceptedDay
  }

  private acceptDay(day: string) {
    if (this.acceptedDay !== null && day < this.acceptedDay) return this.acceptedDay
    this.acceptedDay = day
    return day
  }

  rollover(timestamp = this.now()) {
    const today = dayKey(timestamp)
    const acceptedDay = this.acceptDay(today)
    if (acceptedDay !== today) return this.recomputeBoards()
    const retainedDays = new Set(
      Array.from({ length: HYDRATION_DAYS }, (_, offset) => dayKey(timestamp - offset * DAY_MILLISECONDS))
    )
    for (const [day] of this.indexes) {
      if (!retainedDays.has(day)) this.indexes.delete(day)
    }
    for (const [id, charade] of this.charades) {
      if (!charade.isHouse && !retainedDays.has(dayKey(charade.createdAt))) this.charades.delete(id)
    }
    this.ensureDecoderDay(today)
    return this.recomputeBoards()
  }

  async getOrCreateStats(address: string, name = 'Guest', persistent = true) {
    const key = address.toLowerCase()
    const cached = this.playerStats.get(key)
    if (cached) {
      if (name && cached.name !== name) cached.name = name
      this.statsAccess.set(key, ++this.accessSequence)
      return cached
    }

    const activeLoad = this.statsLoads.get(key)
    if (activeLoad) {
      const stats = await activeLoad
      if (name && stats.name !== name) stats.name = name
      return stats
    }

    const load = (async () => {
      const stored = persistent ? await this.storage.loadPlayerJSON<unknown>(key, PLAYER_STATS_KEY, null) : null
      const stats = migratePlayerStats(stored, name, this.now())
      stats.name = name || stats.name
      this.playerStats.set(key, stats)
      this.statsAccess.set(key, ++this.accessSequence)
      return stats
    })()
    this.statsLoads.set(key, load)
    try {
      return await load
    } finally {
      if (this.statsLoads.get(key) === load) this.statsLoads.delete(key)
    }
  }

  saveStats(address: string, persist = true) {
    const key = address.toLowerCase()
    const stats = this.playerStats.get(key)
    if (!stats) return
    stats.seen = [...new Set(stats.seen)].filter((id) => {
      const charade = this.charades.get(id)
      return charade !== undefined && !charade.isHouse
    })
    stats.authored = normalizeAuthored(stats.authored)
    stats.authoredCount = Math.max(stats.authoredCount, stats.authored.length)
    stats.stampedDays = [...new Set(stats.stampedDays)].slice(-MAX_STAMPED_DAYS)
    this.getPlayerProgress(stats)
    stats.lastSeenAt = this.now()
    if (persist && !this.storageReadOnly) this.storage.markPlayerDirty(key, PLAYER_STATS_KEY, stats)
  }

  evictInactiveStats(activeAddresses: ReadonlySet<string>) {
    const active = new Set([...activeAddresses].map((address) => address.toLowerCase()))
    const candidates = [...this.statsAccess.entries()]
      .filter(([address]) => !active.has(address))
      .sort((left, right) => left[1] - right[1])
    while (this.playerStats.size > MAX_CACHED_PLAYER_STATS && candidates.length > 0) {
      const [address] = candidates.shift()!
      this.playerStats.delete(address)
      this.statsAccess.delete(address)
    }
  }

  evictStats(address: string) {
    const key = address.toLowerCase()
    this.playerStats.delete(key)
    this.statsAccess.delete(key)
  }

  getPlayerProgress(stats: PlayerStats) {
    const progress = computeProgress({
      correct: stats.correct,
      authored: stats.authoredCount,
      stamps: stats.stampedDays.length
    })
    stats.title = progress.title
    return progress
  }

  advanceProgressRevision(stats: PlayerStats) {
    stats.revision = Math.min(stats.revision + 1, WIRE_INT_MAX)
    return stats.revision
  }

  getDaily(stats: PlayerStats) {
    const today = this.acceptDay(dayKey(this.now()))
    if (stats.daily.day !== today) stats.daily = emptyDaily(today)
    return stats.daily
  }

  recordDailyDecode(stats: PlayerStats) {
    const daily = this.getDaily(stats)
    daily.decoded = Math.min(daily.decoded + 1, WIRE_INT_MAX)
    return this.awardDailyStamp(stats)
  }

  recordDailyAuthor(stats: PlayerStats) {
    const daily = this.getDaily(stats)
    daily.authored = Math.min(daily.authored + 1, WIRE_INT_MAX)
    return this.awardDailyStamp(stats)
  }

  private awardDailyStamp(stats: PlayerStats) {
    const daily = this.getDaily(stats)
    if (daily.stamped || daily.decoded < 3 || daily.authored < 1) return false
    daily.stamped = true
    if (!stats.stampedDays.includes(daily.day)) stats.stampedDays.push(daily.day)
    return true
  }

  consumePending(address: string, persist = true) {
    const stats = this.playerStats.get(address.toLowerCase())
    if (!stats) return { triedYou: 0, gotYou: 0, replies: 0, mail: 0 }
    const pending = { ...stats.pending }
    stats.pending = { triedYou: 0, gotYou: 0, replies: 0, mail: 0 }
    this.saveStats(address, persist)
    return pending
  }
}

export const gameState = new GhostlightState()
