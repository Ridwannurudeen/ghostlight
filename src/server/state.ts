import { AUDIENCE_SEATS, HYDRATION_DAYS, WIRE_INT_MAX } from '../shared/config'
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
  StorageCorruptError,
  type StorageRepository
} from './storage'

export type RecentVisitor = Look & { lastSeenAt: number }

type StateStorage = Pick<StorageRepository, 'loadJSON' | 'loadPlayerJSON' | 'markDirty' | 'markPlayerDirty'> &
  Partial<Pick<StorageRepository, 'markDirtyBatch'>>

const defaultStorage: StateStorage = {
  loadJSON,
  loadPlayerJSON,
  markDirty,
  markDirtyBatch,
  markPlayerDirty
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
    this.indexes.clear()
    for (let offset = 0; offset < days.length; offset += MAX_CONCURRENT_READS) {
      const batch = days.slice(offset, offset + MAX_CONCURRENT_READS)
      const values = await Promise.all(batch.map((day) => loadFoundational<unknown>(indexKey(day), [])))
      values.forEach((value, index) => {
        const day = batch[index]
        const dayIndex = migrateIndex(value)
        this.indexes.set(day, dayIndex)
        dayIndex.forEach((id) => {
          if (ids.size < MAX_LIVE_CHARADES && !ids.has(id)) ids.set(id, day)
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

    this.recomputeBoards(false)
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
    if (this.storageReadOnly) return false
    if (charade.isHouse) {
      this.charades.set(charade.id, charade)
      return true
    }

    const day = dayKey(charade.createdAt)
    const currentIds = this.indexes.get(day) ?? []
    const isNew = !this.charades.has(charade.id)
    if (
      isNew &&
      (currentIds.length >= MAX_INDEX_IDS_PER_DAY ||
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
    const decoders = [...this.dailyDecoders.values()]
      .sort((a, b) => b.correct - a.correct || b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 10)
    const hardest = [...this.charades.values()]
      .filter(
        (charade) =>
          !charade.isHouse &&
          !charade.author.isGuest &&
          charade.recipient === undefined &&
          dayKey(charade.createdAt) === today &&
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

    this.boards = { decoders, hardest }
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
