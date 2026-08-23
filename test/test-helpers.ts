import type { Phrase } from '../src/shared/deck'
import { DECK } from '../src/shared/deck'
import { STORAGE_SCHEMA_VERSION, type Boards, type Charade, type Look, type PlayerStats } from '../src/shared/types'
import type { StoragePort } from '../src/server/storage'

export const FIXED_NOW = Date.UTC(2026, 7, 23, 12)

export type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type WriteOutcome = boolean | Error

export type WriteCall = {
  scope: 'scene' | 'player'
  address?: string
  key: string
  value: unknown
}

export class FakeStorage implements StoragePort {
  readonly scene = new Map<string, unknown>()
  readonly players = new Map<string, Map<string, unknown>>()
  readonly writes: WriteCall[] = []
  readonly sceneGets: string[] = []
  readonly playerGets: Array<{ address: string; key: string }> = []
  readonly getErrors = new Set<string>()
  readonly playerGetErrors = new Set<string>()

  sceneWriteOutcomes: WriteOutcome[] = []
  playerWriteOutcomes: WriteOutcome[] = []
  writeGate: Promise<void> | null = null
  activeWrites = 0
  maxActiveWrites = 0

  readonly player = {
    get: async (address: string, key: string) => {
      this.playerGets.push({ address, key })
      if (this.playerGetErrors.has(`${address}:${key}`)) throw new Error('player get failed')
      return this.players.get(address)?.get(key) ?? null
    },
    set: async (address: string, key: string, value: unknown) => {
      return this.performWrite({ scope: 'player', address, key, value }, this.playerWriteOutcomes)
    }
  }

  async get(key: string) {
    this.sceneGets.push(key)
    if (this.getErrors.has(key)) throw new Error('scene get failed')
    return this.scene.get(key) ?? null
  }

  async set(key: string, value: unknown) {
    return this.performWrite({ scope: 'scene', key, value }, this.sceneWriteOutcomes)
  }

  putJSON(key: string, value: unknown) {
    this.scene.set(key, JSON.stringify(value))
  }

  putPlayerJSON(address: string, key: string, value: unknown) {
    const values = this.players.get(address) ?? new Map<string, unknown>()
    values.set(key, JSON.stringify(value))
    this.players.set(address, values)
  }

  readJSON<T>(key: string): T | null {
    const raw = this.scene.get(key)
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : null
  }

  readPlayerJSON<T>(address: string, key: string): T | null {
    const raw = this.players.get(address)?.get(key)
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : null
  }

  private async performWrite(call: WriteCall, outcomes: WriteOutcome[]) {
    this.writes.push(call)
    this.activeWrites += 1
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites)

    try {
      if (this.writeGate) await this.writeGate
      const outcome = outcomes.shift() ?? true
      if (outcome instanceof Error) throw outcome
      if (!outcome) return false

      if (call.scope === 'scene') {
        this.scene.set(call.key, call.value)
      } else {
        const values = this.players.get(call.address!) ?? new Map<string, unknown>()
        values.set(call.key, call.value)
        this.players.set(call.address!, values)
      }
      return true
    } finally {
      this.activeWrites -= 1
    }
  }
}

export function makeLook(address: string, name = address): Look {
  return {
    address,
    name,
    isGuest: false,
    bodyShape: 'urn:decentraland:off-chain:base-avatars:BaseFemale',
    skinColor: { r: 0.6, g: 0.5, b: 0.4 },
    hairColor: { r: 0.2, g: 0.1, b: 0.05 },
    eyeColor: { r: 0.1, g: 0.3, b: 0.5 },
    wearables: []
  }
}

export function makeCharade(
  id: string,
  overrides: Partial<Omit<Charade, 'guesses' | 'author'>> & {
    guesses?: Partial<Charade['guesses']>
    author?: Partial<Look>
  } = {}
): Charade {
  const { guesses, author, ...fields } = overrides
  const phrase: Phrase = DECK.find((candidate) => candidate.id === fields.phraseId) ?? DECK[0]
  const baseAuthor = makeLook(`0x${id}`, `Author ${id}`)

  return {
    v: STORAGE_SCHEMA_VERSION,
    id,
    author: { ...baseAuthor, ...author },
    phraseId: phrase.id,
    emotes: [...phrase.suggested],
    createdAt: FIXED_NOW,
    guesses: { total: 0, correct: 0, ...guesses },
    lastGuessAt: FIXED_NOW,
    isHouse: false,
    ...fields
  }
}

export function makeStats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    v: STORAGE_SCHEMA_VERSION,
    name: 'Player',
    decoded: 0,
    correct: 0,
    seen: [],
    authored: [],
    lastSeenAt: FIXED_NOW,
    pending: { triedYou: 0, gotYou: 0 },
    ...overrides
  }
}

export function emptyBoards(): Boards {
  return { decoders: [], hardest: [] }
}
