import { AUDIENCE_SEATS, HYDRATION_DAYS } from '../shared/config'
import { HOUSE_CHARADE } from '../shared/deck'
import type { Boards, Charade, Color, DailyProgress, Look, PlayerStats } from '../shared/types'
import { STORAGE_SCHEMA_VERSION } from '../shared/types'
import {
  PLAYER_STATS_KEY,
  RECENT_VISITORS_KEY,
  boardsKey,
  charadeKey,
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

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNonNegativeInt(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function asStringArray(value: unknown, limit?: number) {
  const strings = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return limit === undefined ? strings : strings.slice(-limit)
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

export function migrateCharade(value: unknown): Charade | null {
  const stored = asObject(value)
  if (!stored || (stored.v !== 0 && stored.v !== STORAGE_SCHEMA_VERSION)) return null
  const author = migrateLook(stored.author)
  const emotes = asStringArray(stored.emotes)
  const guesses = asObject(stored.guesses)
  if (
    !author ||
    typeof stored.id !== 'string' ||
    typeof stored.phraseId !== 'string' ||
    emotes.length !== 3 ||
    typeof stored.createdAt !== 'number' ||
    !Number.isFinite(stored.createdAt) ||
    !guesses ||
    typeof stored.isHouse !== 'boolean'
  ) {
    return null
  }

  const total = asNonNegativeInt(guesses.total)
  return {
    v: STORAGE_SCHEMA_VERSION,
    id: stored.id,
    author,
    phraseId: stored.phraseId,
    emotes: [emotes[0], emotes[1], emotes[2]],
    createdAt: stored.createdAt,
    guesses: {
      total,
      correct: Math.min(asNonNegativeInt(guesses.correct), total)
    },
    lastGuessAt: asNonNegativeInt(stored.lastGuessAt, stored.createdAt),
    isHouse: stored.isHouse
  }
}

export function migratePlayerStats(value: unknown, name: string, now: number): PlayerStats {
  const stored = asObject(value)
  if (!stored || (stored.v !== 0 && stored.v !== STORAGE_SCHEMA_VERSION)) {
    return {
      v: STORAGE_SCHEMA_VERSION,
      name,
      decoded: 0,
      correct: 0,
      seen: [],
      authored: [],
      lastSeenAt: now,
      pending: { triedYou: 0, gotYou: 0 },
      daily: emptyDaily(dayKey(now)),
      stampedDays: []
    }
  }

  const pending = asObject(stored.pending)
  const decoded = asNonNegativeInt(stored.decoded)
  const daily = migrateDaily(stored.daily, now)
  const stampedDays = [...new Set(asStringArray(stored.stampedDays).filter(isDayKey))]
  if (daily.stamped && !stampedDays.includes(daily.day)) stampedDays.push(daily.day)
  return {
    v: STORAGE_SCHEMA_VERSION,
    name: typeof stored.name === 'string' && stored.name ? stored.name : name,
    decoded,
    correct: Math.min(asNonNegativeInt(stored.correct), decoded),
    seen: asStringArray(stored.seen, 200),
    authored: asStringArray(stored.authored),
    lastSeenAt: asNonNegativeInt(stored.lastSeenAt, now),
    pending: {
      triedYou: asNonNegativeInt(pending?.triedYou),
      gotYou: asNonNegativeInt(pending?.gotYou)
    },
    daily,
    stampedDays: stampedDays.slice(-MAX_STAMPED_DAYS)
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

function migrateRecentVisitors(value: unknown): RecentVisitor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const look = migrateLook(item)
    const stored = asObject(item)
    return look && stored ? [{ ...look, lastSeenAt: asNonNegativeInt(stored.lastSeenAt) }] : []
  })
}

function migrateIndex(value: unknown) {
  return [...new Set(asStringArray(value))]
}

export function dayKey(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export class GhostCharadesState {
  readonly charades = new Map<string, Charade>()
  readonly playerStats = new Map<string, PlayerStats>()
  recentVisitors: RecentVisitor[] = []
  boards: Boards = { decoders: [], hardest: [] }

  private readonly indexes = new Map<string, string[]>()
  private readonly dailyDecoders = new Map<string, Boards['decoders'][number]>()
  private readonly statsLoads = new Map<string, Promise<PlayerStats>>()
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
    const [visitorsValue, boardsValue] = await Promise.all([
      this.storage.loadJSON<unknown>(RECENT_VISITORS_KEY, []),
      this.storage.loadJSON<unknown>(boardsKey(today), EMPTY_BOARDS)
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
    this.boards.decoders.forEach((row) => this.dailyDecoders.set(row.address.toLowerCase(), row))

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

  recordGuess(charadeId: string, correct: boolean) {
    const current = this.charades.get(charadeId)
    if (!current || current.isHouse) return current ?? null

    const updated: Charade = {
      ...current,
      guesses: {
        total: current.guesses.total + 1,
        correct: current.guesses.correct + (correct ? 1 : 0)
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
      correct: current.correct + (correct ? 1 : 0),
      total: current.total + 1
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
    if (markForStorage) this.storage.markDirty(boardsKey(today), this.boards)
    return this.boards
  }

  private ensureDecoderDay(today = dayKey(this.now())) {
    if (this.decoderDay !== today) {
      this.dailyDecoders.clear()
      this.decoderDay = today
    }
    return today
  }

  async getOrCreateStats(address: string, name = 'Guest', persistent = true) {
    const key = address.toLowerCase()
    const cached = this.playerStats.get(key)
    if (cached) {
      if (name && cached.name !== name) cached.name = name
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
    stats.seen = [...new Set(stats.seen)].slice(-200)
    stats.stampedDays = [...new Set(stats.stampedDays)].slice(-MAX_STAMPED_DAYS)
    stats.lastSeenAt = this.now()
    if (persist) this.storage.markPlayerDirty(key, PLAYER_STATS_KEY, stats)
  }

  getDaily(stats: PlayerStats) {
    const today = dayKey(this.now())
    if (stats.daily.day !== today) stats.daily = emptyDaily(today)
    return stats.daily
  }

  recordDailyDecode(stats: PlayerStats) {
    const daily = this.getDaily(stats)
    daily.decoded += 1
    return this.awardDailyStamp(stats)
  }

  recordDailyAuthor(stats: PlayerStats) {
    const daily = this.getDaily(stats)
    daily.authored += 1
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
    if (!stats) return { triedYou: 0, gotYou: 0 }
    const pending = { ...stats.pending }
    stats.pending = { triedYou: 0, gotYou: 0 }
    this.saveStats(address, persist)
    return pending
  }
}

export const gameState = new GhostCharadesState()
