import type { Phrase } from '../src/shared/deck'
import { DECK } from '../src/shared/deck'
import {
  STORAGE_SCHEMA_VERSION,
  type Boards,
  type Charade,
  type CharadeReply,
  type Look,
  type PlayerStats
} from '../src/shared/types'
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
  readonly getValuesErrors = new Set<string>()
  readonly playerGetValuesErrors = new Set<string>()

  sceneWriteOutcomes: WriteOutcome[] = []
  playerWriteOutcomes: WriteOutcome[] = []
  writeGate: Promise<void> | null = null
  readGate: Promise<void> | null = null
  activeWrites = 0
  maxActiveWrites = 0
  activeHostCalls = 0
  maxActiveHostCalls = 0

  readonly player = {
    get: async (address: string, key: string) =>
      this.performRead(async () => {
        this.playerGets.push({ address, key })
        if (this.playerGetErrors.has(`${address}:${key}`)) throw new Error('player get failed')
        return this.players.get(address)?.get(key) ?? null
      }),
    getValues: async (address: string, options?: { prefix?: string; limit?: number; offset?: number }) =>
      this.performRead(async () => {
        if (this.playerGetValuesErrors.has(address)) throw new Error('player get values failed')
        return this.valuesResult(this.players.get(address) ?? new Map(), options)
      }),
    set: async (address: string, key: string, value: unknown) => {
      return this.performWrite({ scope: 'player', address, key, value }, this.playerWriteOutcomes)
    }
  }

  async get(key: string) {
    return this.performRead(async () => {
      this.sceneGets.push(key)
      if (this.getErrors.has(key)) throw new Error('scene get failed')
      return this.scene.get(key) ?? null
    })
  }

  async getValues(options?: { prefix?: string; limit?: number; offset?: number }) {
    return this.performRead(async () => {
      if (this.getValuesErrors.has(options?.prefix ?? '')) throw new Error('scene get values failed')
      return this.valuesResult(this.scene, options)
    })
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

  private async performRead<T>(read: () => Promise<T>) {
    this.activeHostCalls += 1
    this.maxActiveHostCalls = Math.max(this.maxActiveHostCalls, this.activeHostCalls)
    try {
      if (this.readGate) await this.readGate
      return await read()
    } finally {
      this.activeHostCalls -= 1
    }
  }

  private valuesResult(values: Map<string, unknown>, options?: { prefix?: string; limit?: number; offset?: number }) {
    const offset = options?.offset ?? 0
    const matching = [...values.entries()].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
    const data = matching.slice(offset, offset + (options?.limit ?? matching.length)).map(([key, value]) => ({
      key,
      value
    }))
    return { data, pagination: { offset, total: matching.length } }
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

export function makeReply(address = 'replier', name = 'Replier', overrides: Partial<CharadeReply> = {}): CharadeReply {
  return {
    requestId: 'reply-request',
    address,
    name,
    look: makeLook(address, name),
    emotes: [...DECK[0].suggested],
    createdAt: FIXED_NOW,
    ...overrides
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
    touringConsent: false,
    ...fields
  }
}

export function makeStats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    v: STORAGE_SCHEMA_VERSION,
    revision: 0,
    name: 'Player',
    decoded: 0,
    correct: 0,
    seen: [],
    authored: [],
    authoredCount: 0,
    lastSeenAt: FIXED_NOW,
    pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 },
    daily: { day: '2026-08-23', decoded: 0, authored: 0, stamped: false },
    stampedDays: [],
    title: '',
    ...overrides
  }
}

export function emptyBoards(): Boards {
  return { decoders: [], hardest: [] }
}
