import { AUDIENCE_SEATS, HYDRATION_DAYS, WIRE_INT_MAX } from '../shared/config'
import type { PlayerTitle } from '../shared/config'
import { HOUSE_CHARADE } from '../shared/deck'
import type {
  Boards,
  Charade,
  CharadeReply,
  Color,
  DailyProgress,
  Look,
  PlaybillPerformer,
  PlayerProgress,
  PlayerStats
} from '../shared/types'
import { STORAGE_SCHEMA_VERSION } from '../shared/types'
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
  markPlayerDirty,
  type StorageRepository
} from './storage'

export type RecentVisitor = Look & { lastSeenAt: number }

type StateStorage = Pick<StorageRepository, 'loadJSON' | 'loadPlayerJSON' | 'markDirty' | 'markPlayerDirty'>

const defaultStorage: StateStorage = {
  loadJSON,
  loadPlayerJSON,
  markDirty,
  markPlayerDirty
}

const EMPTY_BOARDS: Boards = { decoders: [], hardest: [] }
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const MAX_CONCURRENT_READS = 8
const MAX_STAMPED_DAYS = 100
const MAX_AUTHORED_IDS = 200
const MAX_CACHED_PLAYER_STATS = 256
const MAX_TIMESTAMP = 8_640_000_000_000_000
const SUPPORTED_STORAGE_VERSIONS = new Set([0, 1, STORAGE_SCHEMA_VERSION])

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

function asStringArray(value: unknown, limit?: number) {
  const strings = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return limit === undefined ? strings : strings.slice(-limit)
}

function normalizeAuthored(value: unknown) {
  return [...new Set(asStringArray(value).filter((id) => id !== HOUSE_CHARADE.id))].slice(-MAX_AUTHORED_IDS)
}

function authoredCountFrom(value: unknown) {
  return new Set(asStringArray(value).filter((id) => id !== HOUSE_CHARADE.id)).size
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
  if (!stored || typeof stored.day !== 'string' || !isDayKey(stored.day)) return emptyDaily(dayKey(now))
  return {
    day: stored.day,
    decoded: asNonNegativeInt(stored.decoded),
    authored: asNonNegativeInt(stored.authored),
    stamped: stored.stamped === true
  }
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
  if (typeof color.r !== 'number' || typeof color.g !== 'number' || typeof color.b !== 'number') return null
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
    typeof look.name !== 'string' ||
    typeof look.isGuest !== 'boolean' ||
    typeof look.bodyShape !== 'string' ||
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
    wearables: asStringArray(look.wearables)
  }
}

export function migrateReply(value: unknown): CharadeReply | null {
  const stored = asObject(value)
  if (!stored) return null
  const look = migrateLook(stored.look)
  const emotes = asStringArray(stored.emotes)
  if (
    typeof stored.address !== 'string' ||
    typeof stored.name !== 'string' ||
    !look ||
    stored.address.toLowerCase() !== look.address.toLowerCase() ||
    stored.name !== look.name ||
    emotes.length !== 3 ||
    emotes.some((emote) => emote.length > 64) ||
    asTimestamp(stored.createdAt) === null
  ) {
    return null
  }
  return {
    address: stored.address,
    name: stored.name,
    look,
    emotes: [emotes[0], emotes[1], emotes[2]],
    createdAt: stored.createdAt as number
  }
}

export function migrateCharade(value: unknown): Charade | null {
  const stored = asObject(value)
  if (!stored || typeof stored.v !== 'number' || !SUPPORTED_STORAGE_VERSIONS.has(stored.v)) return null
  const author = migrateLook(stored.author)
  const emotes = asStringArray(stored.emotes)
  const guesses = asObject(stored.guesses)
  if (
    !author ||
    typeof stored.id !== 'string' ||
    stored.id.length > 128 ||
    typeof stored.phraseId !== 'string' ||
    emotes.length !== 3 ||
    emotes.some((emote) => emote.length > 64) ||
    asTimestamp(stored.createdAt) === null ||
    !guesses ||
    typeof stored.isHouse !== 'boolean'
  ) {
    return null
  }

  const total = asNonNegativeInt(guesses.total)
  const migrated: Charade = {
    v: STORAGE_SCHEMA_VERSION,
    id: stored.id,
    author,
    phraseId: stored.phraseId,
    emotes: [emotes[0], emotes[1], emotes[2]],
    createdAt: stored.createdAt as number,
    guesses: {
      total,
      correct: Math.min(asNonNegativeInt(guesses.correct), total)
    },
    lastGuessAt: asTimestamp(stored.lastGuessAt, stored.createdAt as number)!,
    isHouse: stored.isHouse
  }
  if (stored.v === STORAGE_SCHEMA_VERSION && !stored.isHouse) {
    const reply = migrateReply(stored.reply)
    if (reply) migrated.reply = reply
  }
  return migrated
}

export function migratePlayerStats(value: unknown, name: string, now: number): PlayerStats {
  const stored = asObject(value)
  if (!stored || typeof stored.v !== 'number' || !SUPPORTED_STORAGE_VERSIONS.has(stored.v)) {
    return {
      v: STORAGE_SCHEMA_VERSION,
      name,
      decoded: 0,
      correct: 0,
      seen: [],
      authored: [],
      authoredCount: 0,
      lastSeenAt: now,
      pending: { triedYou: 0, gotYou: 0, replies: 0 },
      daily: emptyDaily(dayKey(now)),
      stampedDays: [],
      title: ''
    }
  }

  const pending = asObject(stored.pending)
  const decoded = asNonNegativeInt(stored.decoded)
  const daily = migrateDaily(stored.daily, now)
  const stampedDays = [...new Set(asStringArray(stored.stampedDays).filter(isDayKey))]
  if (daily.stamped && !stampedDays.includes(daily.day)) stampedDays.push(daily.day)
  const authored = normalizeAuthored(stored.authored)
  const authoredCount = Math.max(asNonNegativeInt(stored.authoredCount), authoredCountFrom(stored.authored))
  const correct = Math.min(asNonNegativeInt(stored.correct), decoded)
  return {
    v: STORAGE_SCHEMA_VERSION,
    name: typeof stored.name === 'string' && stored.name ? stored.name : name,
    decoded,
    correct,
    seen: [...new Set(asStringArray(stored.seen))],
    authored,
    authoredCount,
    lastSeenAt: asTimestamp(stored.lastSeenAt, now)!,
    pending: {
      triedYou: asNonNegativeInt(pending?.triedYou),
      gotYou: asNonNegativeInt(pending?.gotYou),
      replies: asNonNegativeInt(pending?.replies)
    },
    daily,
    stampedDays: stampedDays.slice(-MAX_STAMPED_DAYS),
    title: computeTitle({ correct, authored: authoredCount, stamps: stampedDays.length })
  }
}

function migrateBoards(value: unknown): Boards {
  const stored = asObject(value)
  if (!stored) return { ...EMPTY_BOARDS }

  const decoders = Array.isArray(stored.decoders)
    ? stored.decoders.flatMap((value) => {
        const row = asObject(value)
        if (!row || typeof row.address !== 'string' || typeof row.name !== 'string') return []
        const total = asNonNegativeInt(row.total)
        return [
          {
            address: row.address,
            name: row.name,
            correct: Math.min(asNonNegativeInt(row.correct), total),
            total
          }
        ]
      })
    : []

  const hardest = Array.isArray(stored.hardest)
    ? stored.hardest.flatMap((value) => {
        const row = asObject(value)
        if (!row || typeof row.charadeId !== 'string' || typeof row.authorName !== 'string') return []
        const total = asNonNegativeInt(row.total)
        return [
          {
            charadeId: row.charadeId,
            authorName: row.authorName,
            total,
            correct: Math.min(asNonNegativeInt(row.correct), total)
          }
        ]
      })
    : []

  return { decoders: decoders.slice(0, 10), hardest: hardest.slice(0, 10) }
}

function migrateDecoderAggregate(value: unknown): Boards['decoders'] {
  const stored = asObject(value)
  const values = Array.isArray(stored?.decoders) ? stored.decoders : Array.isArray(value) ? value : []
  return values.flatMap((value) => {
    const row = asObject(value)
    if (!row || typeof row.address !== 'string' || typeof row.name !== 'string') return []
    const total = asNonNegativeInt(row.total)
    return [{ address: row.address, name: row.name, correct: Math.min(asNonNegativeInt(row.correct), total), total }]
  })
}

function migrateRecentVisitors(value: unknown): RecentVisitor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const look = migrateLook(item)
    const stored = asObject(item)
    const lastSeenAt = stored ? asTimestamp(stored.lastSeenAt) : null
    return look && lastSeenAt !== null ? [{ ...look, lastSeenAt }] : []
  })
}

function migrateIndex(value: unknown) {
  return [...new Set(asStringArray(value))]
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

  constructor(
    private readonly storage: StateStorage = defaultStorage,
    private readonly now: () => number = Date.now
  ) {}

  async hydrate() {
    const now = this.now()
    const today = dayKey(now)
    const days = Array.from({ length: HYDRATION_DAYS }, (_, offset) => dayKey(now - offset * DAY_MILLISECONDS))
    const ids = new Set<string>()
    this.indexes.clear()
    for (let offset = 0; offset < days.length; offset += MAX_CONCURRENT_READS) {
      const batch = days.slice(offset, offset + MAX_CONCURRENT_READS)
      const values = await Promise.all(batch.map((day) => this.storage.loadJSON<unknown>(indexKey(day), [])))
      values.forEach((value, index) => {
        const day = batch[index]
        const dayIndex = migrateIndex(value)
        this.indexes.set(day, dayIndex)
        dayIndex.forEach((id) => ids.add(id))
      })
    }
    const [visitorsValue, boardsValue, decoderAggregateValue] = await Promise.all([
      this.storage.loadJSON<unknown>(RECENT_VISITORS_KEY, []),
      this.storage.loadJSON<unknown>(boardsKey(today), EMPTY_BOARDS),
      this.storage.loadJSON<unknown>(decoderAggregateKey(today), null)
    ])

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

    this.charades.clear()
    this.charades.set(HOUSE_CHARADE.id, HOUSE_CHARADE)
    const charadeIds = [...ids]
    for (let offset = 0; offset < charadeIds.length; offset += MAX_CONCURRENT_READS) {
      const batch = charadeIds.slice(offset, offset + MAX_CONCURRENT_READS)
      const values = await Promise.all(batch.map((id) => this.storage.loadJSON<unknown>(charadeKey(id), null)))
      values.forEach((value) => {
        const charade = migrateCharade(value)
        if (charade && !charade.isHouse) this.charades.set(charade.id, charade)
      })
    }

    this.recomputeBoards(false)
  }

  getCharade(id: string) {
    return this.charades.get(id) ?? null
  }

  getPool() {
    return [...this.charades.values()]
      .filter((charade) => !charade.isHouse)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  async getRecentPerformers(limit = 6): Promise<PlaybillPerformer[]> {
    const charades = this.getPool().slice(-limit).reverse()
    return Promise.all(
      charades.map(async (charade) => {
        const stats = await this.getOrCreateStats(charade.author.address, charade.author.name, !charade.author.isGuest)
        const progress = this.getPlayerProgress(stats)
        return {
          address: charade.author.address,
          name: charade.author.name,
          isGuest: charade.author.isGuest,
          title: progress.title,
          performedAt: charade.createdAt
        }
      })
    )
  }

  async getGhostOfNight() {
    this.recomputeBoards(false)
    const row = this.boards.hardest[0]
    if (!row) return null
    const charade = this.charades.get(row.charadeId)
    if (!charade || charade.isHouse) return null
    const stats = await this.getOrCreateStats(charade.author.address, charade.author.name, !charade.author.isGuest)
    return { charade, title: this.getPlayerProgress(stats).title }
  }

  upsertCharade(charade: Charade) {
    this.charades.set(charade.id, charade)
    if (charade.isHouse) return

    const day = dayKey(charade.createdAt)
    const ids = this.indexes.get(day) ?? []
    if (!ids.includes(charade.id)) {
      ids.push(charade.id)
      this.indexes.set(day, ids)
      this.storage.markDirty(indexKey(day), ids)
    }
    this.storage.markDirty(charadeKey(charade.id), charade)
    this.recomputeBoards()
  }

  attachReply(charadeId: string, reply: CharadeReply) {
    const current = this.charades.get(charadeId)
    if (!current || current.isHouse || current.reply) return false
    const updated: Charade = { ...current, reply }
    this.charades.set(charadeId, updated)
    this.storage.markDirty(charadeKey(charadeId), updated)
    return true
  }

  recordGuess(charadeId: string, correct: boolean) {
    const current = this.charades.get(charadeId)
    if (!current || current.isHouse) return current ?? null

    const updated: Charade = {
      ...current,
      guesses: {
        total: Math.min(current.guesses.total + 1, WIRE_INT_MAX),
        correct: Math.min(current.guesses.correct + (correct ? 1 : 0), WIRE_INT_MAX)
      },
      lastGuessAt: this.now()
    }
    this.charades.set(charadeId, updated)
    this.storage.markDirty(charadeKey(charadeId), updated)
    this.recomputeBoards()
    return updated
  }

  touchVisitor(look: Look) {
    const visitor: RecentVisitor = { ...look, lastSeenAt: this.now() }
    const address = look.address.toLowerCase()
    this.recentVisitors = [
      visitor,
      ...this.recentVisitors.filter((entry) => entry.address.toLowerCase() !== address)
    ].slice(0, AUDIENCE_SEATS)
    this.storage.markDirty(RECENT_VISITORS_KEY, this.recentVisitors)
    return visitor
  }

  recordDecoder(address: string, name: string, correct: boolean) {
    this.ensureDecoderDay()
    const key = address.toLowerCase()
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
      .filter((charade) => !charade.isHouse && dayKey(charade.createdAt) === today && charade.guesses.total > 0)
      .sort((a, b) => {
        const aRate = a.guesses.correct / a.guesses.total
        const bRate = b.guesses.correct / b.guesses.total
        return aRate - bRate || b.guesses.total - a.guesses.total || a.createdAt - b.createdAt
      })
      .slice(0, 10)
      .map((charade) => ({
        charadeId: charade.id,
        authorName: charade.author.name,
        total: charade.guesses.total,
        correct: charade.guesses.correct
      }))

    this.boards = { decoders, hardest }
    if (markForStorage) {
      this.storage.markDirty(boardsKey(today), this.boards)
      this.storage.markDirty(decoderAggregateKey(today), [...this.dailyDecoders.values()])
    }
    return this.boards
  }

  private ensureDecoderDay(today = dayKey(this.now())) {
    if (this.decoderDay !== today) {
      this.dailyDecoders.clear()
      this.decoderDay = today
    }
    return today
  }

  rollover(timestamp = this.now()) {
    const today = dayKey(timestamp)
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
    if (persist) this.storage.markPlayerDirty(key, PLAYER_STATS_KEY, stats)
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

  getDaily(stats: PlayerStats) {
    const today = dayKey(this.now())
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
    if (!stats) return { triedYou: 0, gotYou: 0, replies: 0 }
    const pending = { ...stats.pending }
    stats.pending = { triedYou: 0, gotYou: 0, replies: 0 }
    this.saveStats(address, persist)
    return pending
  }
}

export const gameState = new GhostlightState()
