import { describe, expect, it, vi } from 'vitest'
import { AUDIENCE_SEATS, HYDRATION_DAYS } from '../src/shared/config'
import { DECK, HOUSE_CHARADE, HOUSE_CHARADES } from '../src/shared/deck'
import { STORAGE_SCHEMA_VERSION } from '../src/shared/types'
import {
  DURABLE_MUTATION_JOURNAL_KEY,
  GhostlightState,
  MAX_DURABLE_COMPLETIONS,
  MAX_DURABLE_JOURNAL_BYTES,
  MAX_DAILY_DECODERS,
  MAX_INDEX_IDS_PER_DAY,
  MAX_PLAYER_SEEN_IDS,
  UnsupportedStorageVersionError,
  computeProgress,
  computeTitle,
  dayKey,
  migrateCharade,
  migrateLook,
  migratePlayerStats
} from '../src/server/state'
import type { DurableMutation } from '../src/server/state'
import {
  MAX_DIRTY_ENTRIES,
  PLAYER_STATS_KEY,
  RECENT_VISITORS_KEY,
  StorageCapacityError,
  StorageUnavailableError,
  boardsKey,
  charadeKey,
  createStorageRepository,
  decoderAggregateKey,
  indexKey
} from '../src/server/storage'
import {
  FIXED_NOW,
  FakeStorage,
  deferred,
  emptyBoards,
  makeCharade,
  makeLook,
  makeReply,
  makeStats
} from './test-helpers'

vi.mock('@dcl/sdk/server', () => ({
  Storage: {
    get: async () => null,
    set: async () => true,
    player: {
      get: async () => null,
      set: async () => true
    }
  }
}))

function setup(now = FIXED_NOW) {
  const storage = new FakeStorage()
  const repository = createStorageRepository(storage)
  const state = new GhostlightState(repository, () => now)
  return { storage, repository, state }
}

function setupRecovery() {
  let timestamp = FIXED_NOW
  let mode: 'unavailable' | 'rejected' | 'pending' | 'available' = 'unavailable'
  let pending: Promise<void> | null = null
  const attemptTimes: number[] = []
  const storage = {
    loadJSON: async <T>(key: string, fallback: T) => {
      if (key === DURABLE_MUTATION_JOURNAL_KEY) {
        attemptTimes.push(timestamp)
        if (mode === 'unavailable') throw new StorageUnavailableError([`scene:${key}`])
        if (mode === 'rejected') throw new Error('hydrate rejected')
        if (mode === 'pending') await pending
      }
      return fallback
    },
    loadPlayerJSON: async <T>(_address: string, _key: string, fallback: T) => fallback,
    markDirty: vi.fn(),
    markDirtyBatch: vi.fn(),
    markPlayerDirty: vi.fn(),
    saveJSONNow: vi.fn(async () => undefined),
    flushNow: vi.fn(async () => undefined)
  }
  const state = new GhostlightState(storage, () => timestamp)
  return {
    state,
    attemptTimes,
    advance: (milliseconds: number) => {
      timestamp += milliseconds
    },
    setMode: (next: typeof mode, wait: Promise<void> | null = null) => {
      mode = next
      pending = wait
    }
  }
}

function makeDurableMutation(overrides: Partial<DurableMutation> = {}): DurableMutation {
  const owner = overrides.owner ?? 'player'
  const requestId = overrides.requestId ?? 'request'
  const fingerprint =
    overrides.fingerprint ??
    ({
      kind: 'guess',
      charadeId: 'journal-charade',
      answerIndex: 1,
      spotlight: false,
      roundId: null
    } satisfies DurableMutation['fingerprint'])
  if (fingerprint.kind !== 'guess') throw new Error('State journal fixture expects a guess mutation')
  const stats = overrides.stats ?? [
    {
      address: owner,
      persistent: true,
      after: {
        name: 'Player',
        decoded: 0,
        correct: 0,
        authoredCount: 0,
        lastSeenAt: FIXED_NOW,
        pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 },
        daily: { day: dayKey(FIXED_NOW), decoded: 0, authored: 0, stamped: false },
        revision: 0,
        title: '' as const,
        showSet: {
          showKey: `daily:${dayKey(FIXED_NOW)}`,
          round: 1,
          score: 100,
          streak: 1,
          bestStreak: 1,
          understood: 1
        }
      }
    }
  ]
  const ownerPatch = stats.find((patch) => patch.address.toLowerCase() === owner.toLowerCase())
  const showSet = ownerPatch?.after.showSet
  const phraseId = overrides.charade?.phraseId ?? HOUSE_CHARADE.phraseId
  const phrase = DECK.find((candidate) => candidate.id === phraseId)!
  const response =
    overrides.response ??
    ({
      type: 'reveal',
      data: {
        requestId,
        charadeId: fingerprint.charadeId,
        correct: true,
        phraseId,
        phrase: phrase.text,
        stats: { ...(overrides.charade?.guesses ?? { total: 0, correct: 0 }) },
        yourScore: ownerPatch?.after.correct ?? 0,
        daily: { ...(ownerPatch?.after.daily ?? { day: dayKey(FIXED_NOW), decoded: 0, authored: 0, stamped: false }) },
        revision: ownerPatch?.after.revision ?? 0,
        stampAwarded: ownerPatch?.stampedDayAdd !== undefined,
        attempt: 1,
        title: ownerPatch?.after.title ?? '',
        nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 },
        titleUnlocked: false,
        spotlight: false,
        scoreDelta: 100,
        setRound: showSet?.round ?? 1,
        setSize: 5,
        setScore: showSet?.score ?? 100,
        setStreak: showSet?.streak ?? 1,
        setBestStreak: showSet?.bestStreak ?? 1,
        setUnderstood: showSet?.understood ?? 1,
        setComplete: (showSet?.round ?? 1) === 5,
        isFinale: (showSet?.round ?? 1) === 5
      }
    } satisfies DurableMutation['response'])
  return {
    v: 1,
    id: overrides.id ?? `${owner}:guess:${requestId}`,
    owner,
    requestId,
    createdAt: FIXED_NOW,
    fingerprint,
    response,
    stats,
    ...overrides
  }
}

describe('state migrations', () => {
  it('accepts a complete look and rejects malformed boundaries', () => {
    const look = makeLook('0xlook', 'Look')
    expect(migrateLook(look)).toEqual(look)
    expect(migrateLook(null)).toBeNull()
    expect(migrateLook({ ...look, address: 4 })).toBeNull()
    expect(migrateLook({ ...look, skinColor: { r: 1, g: 1 } })).toBeNull()
    expect(migrateLook({ ...look, skinColor: { r: Number.POSITIVE_INFINITY, g: 0, b: 0 } })).toBeNull()
    expect(migrateLook({ ...look, eyeColor: { r: -1, g: 0, b: 0 } })).toBeNull()
    expect(migrateLook({ ...look, hairColor: { r: 0, g: 0, b: 1.01 } })).toBeNull()
  })

  it('migrates v0 through v2 charades without consent and rejects unsupported or malformed records', () => {
    const legacy = { ...makeCharade('legacy'), v: 0, lastGuessAt: undefined, touringConsent: true }
    expect(migrateCharade(legacy)).toMatchObject({
      v: STORAGE_SCHEMA_VERSION,
      id: 'legacy',
      lastGuessAt: FIXED_NOW,
      touringConsent: false
    })
    const v1 = { ...makeCharade('v1'), v: 1, touringConsent: true }
    expect(migrateCharade(v1)).toEqual({ ...v1, v: STORAGE_SCHEMA_VERSION, touringConsent: false })
    expect(migrateCharade(v1)?.reply).toBeUndefined()
    expect(migrateCharade({ ...makeCharade('v2'), v: 2, touringConsent: true })).toMatchObject({
      v: STORAGE_SCHEMA_VERSION,
      touringConsent: false
    })
    expect(migrateCharade({ ...legacy, v: 99 })).toBeNull()
    expect(migrateCharade({ ...legacy, emotes: ['wave', 'clap'] })).toBeNull()
    expect(migrateCharade({ ...legacy, emotes: ['wave', 'wave', 'wave'] })?.emotes).toEqual(['wave', 'wave', 'wave'])
    expect(migrateCharade({ ...legacy, emotes: ['wave', 'clap', 'not-an-emote'] })).toBeNull()
    expect(migrateCharade('{bad json')).toBeNull()
  })

  it('requires exact v3 touring consent and forbids touring House or mail records', () => {
    const ordinary = makeCharade('ordinary', { touringConsent: true })
    const { touringConsent: _touringConsent, ...missingConsent } = ordinary
    const recipient = `0x${'a'.repeat(40)}`

    expect(migrateCharade(ordinary)).toEqual(ordinary)
    expect(migrateCharade({ ...ordinary, touringConsent: false })).toMatchObject({ touringConsent: false })
    expect(migrateCharade(missingConsent)).toBeNull()
    expect(migrateCharade({ ...ordinary, touringConsent: 'yes' })).toBeNull()
    expect(migrateCharade({ ...ordinary, isHouse: true })).toBeNull()
    expect(migrateCharade({ ...ordinary, recipient })).toBeNull()
  })

  it('requires reply request identity in v3 while safely preserving legacy v2 replies', () => {
    const reply = makeReply('replier', 'Replier')
    const charade = makeCharade('with-reply', { reply })

    expect(migrateCharade(charade)?.reply).toEqual(reply)
    const { requestId: _requestId, ...missingRequestId } = reply
    expect(migrateCharade({ ...charade, reply: missingRequestId })?.reply).toBeUndefined()
    expect(migrateCharade({ ...charade, reply: { ...reply, requestId: null } })?.reply).toBeUndefined()
    expect(migrateCharade({ ...charade, reply: { ...reply, requestId: '' } })?.reply).toBeUndefined()
    expect(migrateCharade({ ...charade, reply: { ...reply, requestId: 'x'.repeat(65) } })?.reply).toBeUndefined()
    const migrated = migrateCharade({
      ...charade,
      reply: { ...reply, emotes: ['wave', 'clap'] }
    })
    expect(migrated).toMatchObject({ id: charade.id, v: STORAGE_SCHEMA_VERSION })
    expect(migrated?.reply).toBeUndefined()
    expect(migrateCharade({ ...charade, reply: { ...reply, address: 'different-player' } })?.reply).toBeUndefined()
    expect(migrateCharade({ ...charade, reply: { ...reply, name: 'Different name' } })?.reply).toBeUndefined()

    const legacy = migrateCharade({ ...charade, v: 2, reply: missingRequestId })
    expect(legacy?.reply).toMatchObject({ address: reply.address, emotes: reply.emotes })
    expect(legacy?.reply?.requestId).toBeNull()
  })

  it('restores a valid v2 mail recipient while leaving v1 records intact', () => {
    const recipient = `0x${'a'.repeat(40)}`
    const mailed = makeCharade('mailed', { recipient })
    const v1 = { ...mailed, v: 1 }

    expect(migrateCharade(mailed)?.recipient).toBe(recipient)
    expect(migrateCharade(v1)?.recipient).toBeUndefined()
    expect(migrateCharade({ ...mailed, recipient: 'not-an-address' })).toBeNull()
  })

  it('migrates exact seen accounting beyond the former 200-id cap while defaulting garbage', () => {
    const seen = Array.from({ length: 205 }, (_, index) => `seen-${index}`)
    expect(migratePlayerStats({ ...makeStats({ seen }), v: 0 }, 'Fresh name', FIXED_NOW)).toMatchObject({
      v: STORAGE_SCHEMA_VERSION,
      name: 'Player',
      seen
    })

    expect(migratePlayerStats({ v: 'bad' }, 'Fresh name', FIXED_NOW)).toEqual(makeStats({ name: 'Fresh name' }))
  })

  it('defaults the additive reply notification count when loading v1 player stats', () => {
    const v1 = {
      ...makeStats(),
      v: 1,
      pending: { triedYou: 2, gotYou: 1 }
    }

    expect(migratePlayerStats(v1, 'Player', FIXED_NOW).pending).toEqual({
      triedYou: 2,
      gotYou: 1,
      replies: 0,
      mail: 0
    })
  })

  it('restores a valid optional Show Set while leaving old and malformed records safe', () => {
    const showKey = 'é'.repeat(64)
    expect(migratePlayerStats(makeStats(), 'Player', FIXED_NOW).showSet).toBeUndefined()
    expect(
      migratePlayerStats(
        {
          ...makeStats(),
          showSet: { showKey, round: 4, score: 600, streak: 2, bestStreak: 3, understood: 3 }
        },
        'Player',
        FIXED_NOW
      ).showSet
    ).toEqual({ showKey, round: 4, score: 600, streak: 2, bestStreak: 3, understood: 3 })
    expect(
      migratePlayerStats(
        {
          ...makeStats(),
          showSet: { round: 4, score: 600, streak: 2, bestStreak: 3, understood: 3 }
        },
        'Player',
        FIXED_NOW
      ).showSet
    ).toEqual({ round: 4, score: 600, streak: 2, bestStreak: 3, understood: 3 })
    for (const invalidKey of ['', 7, 'é'.repeat(65)]) {
      expect(
        migratePlayerStats(
          {
            ...makeStats(),
            showSet: { showKey: invalidKey, round: 4, score: 600, streak: 2, bestStreak: 3, understood: 3 }
          },
          'Player',
          FIXED_NOW
        ).showSet
      ).toEqual({ round: 4, score: 600, streak: 2, bestStreak: 3, understood: 3 })
    }
    expect(
      migratePlayerStats(
        {
          ...makeStats(),
          showSet: { round: 'four', score: -100, streak: true, bestStreak: null, understood: [] }
        },
        'Player',
        FIXED_NOW
      ).showSet
    ).toBeUndefined()
  })

  it('rejects invalid daily keys and keeps only valid stamped UTC days', () => {
    const migrated = migratePlayerStats(
      makeStats({
        daily: { day: '2026-02-30', decoded: 99, authored: 99, stamped: true },
        stampedDays: ['2026-08-20', 'not-a-day', '2026-02-30', '2026-08-20']
      }),
      'Player',
      FIXED_NOW
    )

    expect(migrated.daily).toEqual({ day: '2026-08-23', decoded: 0, authored: 0, stamped: false })
    expect(migrated.stampedDays).toEqual(['2026-08-20'])
  })

  it('recomputes titles from verified participation and excludes duplicate and house authored ids', () => {
    const migrated = migratePlayerStats(
      makeStats({
        authored: [...HOUSE_CHARADES.map((charade) => charade.id), 'player-charade', 'player-charade'],
        title: 'Ghostlight Legend'
      }),
      'Player',
      FIXED_NOW
    )

    expect(migrated.authored).toEqual(['player-charade'])
    expect(migrated.title).toBe('Understudy')
  })

  it('keeps an exact authored count while bounding the stored idempotency history', () => {
    const authored = Array.from({ length: 205 }, (_, index) => `authored-${index}`)
    const migrated = migratePlayerStats(makeStats({ authored, authoredCount: 0 }), 'Player', FIXED_NOW)

    expect(migrated.authored).toEqual(authored.slice(-200))
    expect(migrated.authoredCount).toBe(205)
    expect(migrated.title).toBe('Scene Stealer')
  })

  it('saturates wire counters and rejects unsafe or fractional timestamps', () => {
    const migrated = migratePlayerStats(
      makeStats({ decoded: Number.MAX_SAFE_INTEGER, correct: Number.MAX_SAFE_INTEGER }),
      'Player',
      FIXED_NOW
    )
    expect(migrated.decoded).toBe(2_147_483_647)
    expect(migrated.correct).toBe(2_147_483_647)
    expect(migrateCharade({ ...makeCharade('fractional'), createdAt: 1.5 })).toBeNull()
    expect(migrateCharade({ ...makeCharade('unsafe'), createdAt: Number.MAX_VALUE })).toBeNull()
  })

  it('rejects unknown phrases and timestamps outside their expected shard or future-skew window', () => {
    const today = dayKey(FIXED_NOW)
    expect(migrateCharade({ ...makeCharade('removed'), phraseId: 'removed-phrase' })).toBeNull()
    expect(
      migrateCharade(makeCharade('wrong-shard', { createdAt: FIXED_NOW - 86_400_000 }), {
        expectedDay: today,
        now: FIXED_NOW
      })
    ).toBeNull()
    expect(
      migrateCharade(makeCharade('future', { createdAt: FIXED_NOW + 10 * 60_000 }), {
        expectedDay: today,
        now: FIXED_NOW
      })
    ).toBeNull()
  })

  it('bounds stored histories, rejects future reward days, and preserves a monotonic revision', () => {
    const seen = Array.from({ length: MAX_PLAYER_SEEN_IDS + 20 }, (_, index) => `seen-${index}`)
    const migrated = migratePlayerStats(
      makeStats({
        revision: Number.MAX_SAFE_INTEGER,
        seen,
        stampedDays: ['2026-08-22', '2026-08-24'],
        daily: { day: '2026-08-24', decoded: 3, authored: 1, stamped: true }
      }),
      'Player',
      FIXED_NOW
    )

    expect(migrated.revision).toBe(2_147_483_647)
    expect(migrated.seen).toEqual(seen.slice(-MAX_PLAYER_SEEN_IDS))
    expect(migrated.stampedDays).toEqual(['2026-08-22'])
    expect(migrated.daily).toEqual({ day: '2026-08-23', decoded: 0, authored: 0, stamped: false })
  })

  it('refuses to reinterpret future player schemas as empty writable stats', () => {
    expect(() => migratePlayerStats({ ...makeStats(), v: STORAGE_SCHEMA_VERSION + 1 }, 'Player', FIXED_NOW)).toThrow(
      UnsupportedStorageVersionError
    )
  })
})

describe('title progression', () => {
  it('uses the exact verified thresholds and reports progress toward the next title', () => {
    expect(computeTitle({ correct: 0, authored: 0, stamps: 0 })).toBe('')
    expect(computeTitle({ correct: 0, authored: 1, stamps: 0 })).toBe('Understudy')
    expect(computeTitle({ correct: 10, authored: 1, stamps: 0 })).toBe('Scene Stealer')
    expect(computeTitle({ correct: 0, authored: 5, stamps: 0 })).toBe('Scene Stealer')
    expect(computeTitle({ correct: 25, authored: 5, stamps: 2 })).toBe('Scene Stealer')
    expect(computeTitle({ correct: 24, authored: 5, stamps: 3 })).toBe('Scene Stealer')
    expect(computeTitle({ correct: 25, authored: 5, stamps: 3 })).toBe('Ghostlight Legend')

    expect(computeProgress({ correct: 4, authored: 2, stamps: 0 })).toEqual({
      title: 'Understudy',
      nextUnlock: {
        nextTitle: 'Scene Stealer',
        requirement: '10 correct decodes or 5 posts',
        progress: 0.4
      }
    })
    expect(computeProgress({ correct: 20, authored: 5, stamps: 2 })).toMatchObject({
      title: 'Scene Stealer',
      nextUnlock: { nextTitle: 'Ghostlight Legend', progress: 2 / 3 }
    })
  })
})

describe('state hydration', () => {
  it('loads today and yesterday, skips garbage and stored house records, and installs every house fallback', async () => {
    const { storage, state } = setup()
    const today = dayKey(FIXED_NOW)
    const yesterday = dayKey(FIXED_NOW - 24 * 60 * 60 * 1000)
    const todayCharade = makeCharade('today')
    const yesterdayCharade = makeCharade('yesterday', { createdAt: FIXED_NOW - 24 * 60 * 60 * 1000 })
    storage.putJSON(indexKey(today), ['today', 'stored-house', 'today'])
    storage.putJSON(indexKey(yesterday), ['yesterday'])
    storage.putJSON(charadeKey('today'), todayCharade)
    storage.putJSON(charadeKey('yesterday'), { ...yesterdayCharade, v: 0 })
    storage.putJSON(charadeKey('stored-house'), { ...HOUSE_CHARADE, id: 'stored-house' })
    storage.putJSON(RECENT_VISITORS_KEY, 'not-an-array')

    await state.hydrate()

    expect(HOUSE_CHARADES.every((charade) => state.getCharade(charade.id) === charade)).toBe(true)
    expect(
      state
        .getPool()
        .map((charade) => charade.id)
        .sort()
    ).toEqual(['today', 'yesterday'])
    expect(state.recentVisitors).toEqual([])
    expect(state.boards).toEqual(emptyBoards())
    expect(storage.sceneGets.filter((key) => key === charadeKey('today'))).toHaveLength(1)
  })

  it('quarantines one corrupt indexed charade while retaining house fallback availability', async () => {
    const { storage, state } = setup()
    const today = dayKey(FIXED_NOW)
    storage.putJSON(indexKey(today), ['corrupt'])
    storage.scene.set(charadeKey('corrupt'), '{')

    await expect(state.hydrate()).resolves.toBeUndefined()
    expect(state.getPool()).toEqual([])
    expect(HOUSE_CHARADES.every((charade) => state.getCharade(charade.id) === charade)).toBe(true)
  })

  it('enters house-only read-only mode when an indexed charade is unavailable rather than hanging startup', async () => {
    const { storage, repository, state } = setup()
    const today = dayKey(FIXED_NOW)
    const available = makeCharade('available-before-outage')
    storage.putJSON(indexKey(today), [available.id, 'unavailable'])
    storage.putJSON(charadeKey(available.id), available)
    storage.getErrors.add(charadeKey('unavailable'))
    storage.getValuesErrors.add(charadeKey('unavailable'))

    await expect(state.hydrate()).resolves.toBeUndefined()
    expect(state.isReadOnly).toBe(true)
    expect(state.getPool()).toEqual([])
    expect(state.getCharade(available.id)).toBeNull()
    expect(HOUSE_CHARADES.every((charade) => state.getCharade(charade.id) === charade)).toBe(true)
    expect(repository.getDirtyKeys()).toEqual([])
  })

  it('recovers from transient read-only hydration and resumes durable writes without duplicating them', async () => {
    const { storage, repository, state } = setup()
    const today = dayKey(FIXED_NOW)
    const restored = makeCharade('restored')
    storage.putJSON(indexKey(today), [restored.id])
    storage.putJSON(charadeKey(restored.id), restored)
    storage.getErrors.add(charadeKey(restored.id))
    storage.getValuesErrors.add(charadeKey(restored.id))

    await state.hydrate()

    expect(state.isReadOnly).toBe(true)
    expect(state.upsertCharade(makeCharade('blocked-during-outage'))).toBe(false)
    expect(repository.getDirtyKeys()).toEqual([])

    storage.getErrors.clear()
    storage.getValuesErrors.clear()
    await expect(state.recoverStorage()).resolves.toBe(true)

    expect(state.isReadOnly).toBe(false)
    expect(state.getPool()).toEqual([restored])
    const resumed = makeCharade('resumed')
    expect(state.upsertCharade(resumed)).toBe(true)
    await repository.flushNow()

    expect(storage.readJSON(charadeKey(resumed.id))).toEqual(resumed)
    expect(storage.writes.filter((write) => write.key === charadeKey(resumed.id))).toHaveLength(1)
    await expect(state.recoverStorage()).resolves.toBe(false)
    expect(storage.writes.filter((write) => write.key === charadeKey(resumed.id))).toHaveLength(1)
  })

  it('backs off global storage recovery by exactly 2s, 4s, 8s, 16s, then 30s capped', async () => {
    const { state, attemptTimes, advance } = setupRecovery()
    await state.hydrate()
    attemptTimes.length = 0

    await expect(state.recoverStorage()).resolves.toBe(false)
    expect(attemptTimes).toEqual([FIXED_NOW])

    let elapsed = 0
    for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const attemptsBeforeDeadline = attemptTimes.length
      await expect(state.recoverStorage()).resolves.toBe(false)
      expect(attemptTimes).toHaveLength(attemptsBeforeDeadline)
      advance(delay - 1)
      await expect(state.recoverStorage()).resolves.toBe(false)
      expect(attemptTimes).toHaveLength(attemptsBeforeDeadline)
      advance(1)
      elapsed += delay
      await expect(state.recoverStorage()).resolves.toBe(false)
      expect(attemptTimes.at(-1)).toBe(FIXED_NOW + elapsed)
    }

    expect(attemptTimes).toEqual([
      FIXED_NOW,
      FIXED_NOW + 2_000,
      FIXED_NOW + 6_000,
      FIXED_NOW + 14_000,
      FIXED_NOW + 30_000,
      FIXED_NOW + 60_000,
      FIXED_NOW + 90_000
    ])
  })

  it('coalesces concurrent storage recovery into one hydration attempt', async () => {
    const { state, attemptTimes, setMode } = setupRecovery()
    await state.hydrate()
    attemptTimes.length = 0
    const gate = deferred<void>()
    setMode('pending', gate.promise)

    const first = state.recoverStorage()
    const second = state.recoverStorage()

    expect(second).toBe(first)
    await vi.waitFor(() => expect(attemptTimes).toEqual([FIXED_NOW]))
    gate.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(attemptTimes).toEqual([FIXED_NOW])
  })

  it('advances recovery backoff when hydration rejects', async () => {
    const { state, attemptTimes, advance, setMode } = setupRecovery()
    await state.hydrate()
    attemptTimes.length = 0
    setMode('rejected')

    await expect(state.recoverStorage()).rejects.toThrow('hydrate rejected')
    await expect(state.recoverStorage()).resolves.toBe(false)
    expect(attemptTimes).toEqual([FIXED_NOW])

    advance(2_000)
    await expect(state.recoverStorage()).rejects.toThrow('hydrate rejected')
    expect(attemptTimes).toEqual([FIXED_NOW, FIXED_NOW + 2_000])
  })

  it('resets recovery backoff after a successful rehydrate', async () => {
    const { state, attemptTimes, advance, setMode } = setupRecovery()
    await state.hydrate()
    attemptTimes.length = 0

    await expect(state.recoverStorage()).resolves.toBe(false)
    advance(2_000)
    setMode('available')
    await expect(state.recoverStorage()).resolves.toBe(true)

    setMode('unavailable')
    await state.hydrate()
    attemptTimes.length = 0
    await expect(state.recoverStorage()).resolves.toBe(false)
    advance(1_999)
    await expect(state.recoverStorage()).resolves.toBe(false)
    expect(attemptTimes).toEqual([FIXED_NOW + 2_000])
    advance(1)
    await expect(state.recoverStorage()).resolves.toBe(false)
    expect(attemptTimes).toEqual([FIXED_NOW + 2_000, FIXED_NOW + 4_000])
  })

  it('enters house-only read-only mode for a corrupt foundational index', async () => {
    const { storage, state } = setup()
    storage.scene.set(indexKey(dayKey(FIXED_NOW)), '{')

    await expect(state.hydrate()).resolves.toBeUndefined()

    expect(state.isReadOnly).toBe(true)
    expect(state.getPool()).toEqual([])
    expect(HOUSE_CHARADES.every((charade) => state.getCharade(charade.id) === charade)).toBe(true)
    expect(state.upsertCharade(makeCharade('blocked'))).toBe(false)
    expect(state.getCharade('blocked')).toBeNull()
  })

  it('tolerates missing and throwing storage reads', async () => {
    const { storage, state } = setup()
    storage.getErrors.add(indexKey(dayKey(FIXED_NOW)))
    storage.getErrors.add(RECENT_VISITORS_KEY)

    await expect(state.hydrate()).resolves.toBeUndefined()
    expect(state.getPool()).toEqual([])
    expect(HOUSE_CHARADES.every((charade) => state.getCharade(charade.id) === charade)).toBe(true)
  })

  it('hydrates a charade indexed ten days ago and keeps the pool ordered by creation time', async () => {
    const { storage, state } = setup()
    const tenDaysAgo = FIXED_NOW - 10 * 24 * 60 * 60 * 1000
    const yesterday = FIXED_NOW - 24 * 60 * 60 * 1000
    storage.putJSON(indexKey(dayKey(tenDaysAgo)), ['old-charade', 'old-charade'])
    storage.putJSON(indexKey(dayKey(yesterday)), ['new-charade'])
    storage.putJSON(charadeKey('old-charade'), makeCharade('old-charade', { createdAt: tenDaysAgo }))
    storage.putJSON(charadeKey('new-charade'), makeCharade('new-charade', { createdAt: yesterday }))

    await state.hydrate()

    expect(state.getPool().map((charade) => charade.id)).toEqual(['old-charade', 'new-charade'])
    expect(
      Array.from({ length: HYDRATION_DAYS }, (_, offset) => indexKey(dayKey(FIXED_NOW - offset * 86_400_000))).every(
        (key) => storage.sceneGets.includes(key)
      )
    ).toBe(true)
    expect(storage.sceneGets.filter((key) => key === charadeKey('old-charade'))).toHaveLength(1)
  })

  it('keeps only the six most recent distinct visitors when persisted data contains duplicates', async () => {
    const { storage, state } = setup()
    const visitors = [
      { ...makeLook('a', 'new a'), lastSeenAt: 8 },
      { ...makeLook('a', 'old a'), lastSeenAt: 7 },
      { ...makeLook('b'), lastSeenAt: 6 },
      { ...makeLook('c'), lastSeenAt: 5 },
      { ...makeLook('d'), lastSeenAt: 4 },
      { ...makeLook('e'), lastSeenAt: 3 },
      { ...makeLook('f'), lastSeenAt: 2 },
      { ...makeLook('g'), lastSeenAt: 1 }
    ]
    storage.putJSON(RECENT_VISITORS_KEY, visitors)

    await state.hydrate()

    expect(state.recentVisitors).toHaveLength(AUDIENCE_SEATS)
    expect(state.recentVisitors.map((visitor) => visitor.address)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(new Set(state.recentVisitors.map((visitor) => visitor.address)).size).toBe(AUDIENCE_SEATS)
    expect(state.recentVisitors[0].name).toBe('new a')
  })

  it('caps each hydrated index before issuing record reads and skips removed phrases', async () => {
    const { storage, state } = setup()
    const today = dayKey(FIXED_NOW)
    const ids = Array.from({ length: MAX_INDEX_IDS_PER_DAY + 5 }, (_, index) => `indexed-${index}`)
    storage.putJSON(indexKey(today), [...ids, 'removed-phrase'])
    ids.forEach((id) => storage.putJSON(charadeKey(id), makeCharade(id)))
    storage.putJSON(charadeKey('removed-phrase'), makeCharade('removed-phrase', { phraseId: 'no-longer-in-deck' }))

    await state.hydrate()

    expect(state.getPool()).toHaveLength(MAX_INDEX_IDS_PER_DAY - 1)
    expect(storage.sceneGets.filter((key) => key.startsWith('gc:v1:charade:'))).toHaveLength(MAX_INDEX_IDS_PER_DAY)
    expect(state.getCharade('removed-phrase')).toBeNull()
  })
})

describe('durable mutation journal', () => {
  it('recovers an active mutation before becoming ready and commits every derived target exactly once', async () => {
    const owner = `0x${'1'.repeat(40)}`
    const author = `0x${'2'.repeat(40)}`
    const { storage, repository, state } = setup()
    await state.hydrate()
    storage.putPlayerJSON(owner, PLAYER_STATS_KEY, makeStats({ name: 'Decoder' }))
    const charade = makeCharade('journal-charade', {
      author: makeLook(author, 'Author'),
      guesses: { total: 1, correct: 1 },
      lastGuessAt: FIXED_NOW
    })
    const day = dayKey(FIXED_NOW)
    const decoder = { address: owner, name: 'Decoder', correct: 1, total: 1 }
    const active = makeDurableMutation({
      owner,
      notifiedAuthor: author,
      charade,
      stats: [
        {
          address: owner,
          persistent: true,
          seenAdd: charade.id,
          stampedDayAdd: day,
          after: {
            name: 'Decoder',
            decoded: 1,
            correct: 1,
            authoredCount: 0,
            lastSeenAt: FIXED_NOW,
            pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 },
            daily: { day, decoded: 1, authored: 1, stamped: true },
            revision: 1,
            title: '',
            showSet: { showKey: `daily:${day}`, round: 1, score: 100, streak: 1, bestStreak: 1, understood: 1 }
          }
        },
        {
          address: author,
          persistent: true,
          after: {
            name: 'Author',
            decoded: 0,
            correct: 0,
            authoredCount: 0,
            lastSeenAt: FIXED_NOW,
            pending: { triedYou: 1, gotYou: 1, replies: 0, mail: 0 },
            daily: { day, decoded: 0, authored: 0, stamped: false },
            revision: 0,
            title: ''
          }
        }
      ],
      decoder: { day, row: decoder },
      boards: { day, value: { decoders: [decoder], hardest: [] } }
    })
    await state.beginDurableMutation(active)

    const restartedRepository = createStorageRepository(storage)
    const restarted = new GhostlightState(restartedRepository, () => FIXED_NOW)
    await restarted.hydrate()

    expect(restarted.getCharade(charade.id)).toEqual(charade)
    expect(restarted.playerStats.get(owner)).toMatchObject({
      decoded: 1,
      correct: 1,
      seen: [charade.id],
      stampedDays: [day],
      revision: 1,
      showSet: { round: 1, score: 100 }
    })
    expect(restarted.boards).toEqual({ decoders: [decoder], hardest: [] })
    expect(storage.readJSON(indexKey(day))).toEqual([charade.id])
    expect(storage.readJSON(charadeKey(charade.id))).toEqual(charade)
    expect(storage.readPlayerJSON(owner, PLAYER_STATS_KEY)).toMatchObject({ decoded: 1, correct: 1 })
    expect(storage.readJSON(DURABLE_MUTATION_JOURNAL_KEY)).toMatchObject({
      v: 1,
      active: null,
      completed: [expect.objectContaining({ id: active.id, response: active.response })]
    })
    expect(restarted.getDurableCompletion(owner, 'guess', active.requestId)).toMatchObject({ id: active.id })
    expect(restartedRepository.getDirtyKeys()).toEqual([])
  })

  it.each([
    { label: 'active record only', scene: [false, false, false, false], players: [false, false] },
    { label: 'charade before index', scene: [true, false, false, false], players: [false, false] },
    { label: 'index before charade', scene: [false, true, false, false], players: [false, false] },
    { label: 'boards and decoder aggregate first', scene: [false, false, true, true], players: [false, false] },
    { label: 'decoder stats before author stats', scene: [false, false, false, false], players: [true, false] },
    { label: 'author stats before decoder stats', scene: [false, false, false, false], players: [false, true] },
    { label: 'mixed scene and player subset', scene: [true, false, true, false], players: [true, false] },
    { label: 'all targets before completion marker', scene: [true, true, true, true], players: [true, true] }
  ])('reconciles $label after a crash cut without duplicating effects', async ({ scene, players }) => {
    const owner = `0x${'1'.repeat(40)}`
    const author = `0x${'2'.repeat(40)}`
    const day = dayKey(FIXED_NOW)
    const charade = makeCharade('journal-cut-charade', {
      author: makeLook(author, 'Author'),
      guesses: { total: 1, correct: 0 },
      lastGuessAt: FIXED_NOW
    })
    const decoder = { address: owner, name: 'Player', correct: 0, total: 1 }
    const mutation = makeDurableMutation({
      owner,
      fingerprint: {
        kind: 'guess',
        charadeId: charade.id,
        answerIndex: 1,
        spotlight: false,
        roundId: null
      },
      notifiedAuthor: author,
      charade,
      decoder: { day, row: decoder },
      boards: { day, value: { decoders: [decoder], hardest: [] } }
    })
    mutation.stats[0].seenAdd = charade.id
    mutation.stats.push({
      address: author,
      persistent: true,
      after: {
        name: 'Author',
        decoded: 0,
        correct: 0,
        authoredCount: 0,
        lastSeenAt: FIXED_NOW,
        pending: { triedYou: 1, gotYou: 0, replies: 0, mail: 0 },
        daily: { day, decoded: 0, authored: 0, stamped: false },
        revision: 0,
        title: ''
      }
    })
    const { storage, repository, state } = setup()
    await state.hydrate()
    await state.beginDurableMutation(mutation)
    await state.applyDurableMutation(mutation)
    storage.sceneWriteOutcomes = [...scene]
    storage.playerWriteOutcomes = [...players]
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await repository.flush()

    logSpy.mockRestore()
    const restartedRepository = createStorageRepository(storage)
    const restarted = new GhostlightState(restartedRepository, () => FIXED_NOW)
    await restarted.hydrate()

    expect(storage.readJSON(charadeKey(charade.id))).toEqual(charade)
    expect(storage.readJSON(indexKey(day))).toEqual([charade.id])
    expect(storage.readJSON(boardsKey(day))).toEqual({ decoders: [decoder], hardest: [] })
    expect(storage.readJSON(decoderAggregateKey(day))).toEqual([decoder])
    expect(storage.readPlayerJSON(owner, PLAYER_STATS_KEY)).toMatchObject({
      seen: [charade.id],
      decoded: 0,
      correct: 0
    })
    expect(storage.readPlayerJSON(author, PLAYER_STATS_KEY)).toMatchObject({
      pending: { triedYou: 1, gotYou: 0, replies: 0, mail: 0 }
    })
    expect(storage.readJSON(DURABLE_MUTATION_JOURNAL_KEY)).toMatchObject({
      active: null,
      completed: [expect.objectContaining({ id: mutation.id })]
    })
    expect(restartedRepository.getDirtyKeys()).toEqual([])

    const replayRepository = createStorageRepository(storage)
    const replayed = new GhostlightState(replayRepository, () => FIXED_NOW)
    await replayed.hydrate()
    const replayedStats = await replayed.getOrCreateStats(owner, 'Player')
    const replayedAuthorStats = await replayed.getOrCreateStats(author, 'Author')

    expect(replayed.getCharade(charade.id)?.guesses).toEqual({ total: 1, correct: 0 })
    expect(replayedStats.seen).toEqual([charade.id])
    expect(replayedAuthorStats.pending).toEqual({ triedYou: 1, gotYou: 0, replies: 0, mail: 0 })
    expect(replayed.boards).toEqual({ decoders: [decoder], hardest: [] })
    expect(replayRepository.getDirtyKeys()).toEqual([])
  })

  it('recovers an index-first crash cut when the new charade already reserved the 128th daily slot', async () => {
    const owner = `0x${'6'.repeat(40)}`
    const day = dayKey(FIXED_NOW)
    const existingIds = Array.from({ length: MAX_INDEX_IDS_PER_DAY - 1 }, (_, index) => `reserved-${index}`)
    const { storage, repository, state } = setup()
    storage.putJSON(indexKey(day), existingIds)
    existingIds.forEach((id) => storage.putJSON(charadeKey(id), makeCharade(id)))
    await state.hydrate()

    const requestId = 'reserved-final-slot'
    const charade = makeCharade('reserved-127', {
      author: makeLook(owner, 'Poster'),
      createdAt: FIXED_NOW,
      lastGuessAt: 0
    })
    const ownerPatch = {
      address: owner,
      persistent: true,
      authoredAdd: charade.id,
      after: {
        name: 'Poster',
        decoded: 0,
        correct: 0,
        authoredCount: 1,
        lastSeenAt: FIXED_NOW,
        pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 },
        daily: { day, decoded: 0, authored: 1, stamped: false },
        revision: 1,
        title: '' as const
      }
    }
    const mutation: DurableMutation = {
      v: 1,
      id: `${owner}:post:${requestId}`,
      owner,
      requestId,
      createdAt: FIXED_NOW,
      fingerprint: {
        kind: 'post',
        phraseId: charade.phraseId,
        emotes: [...charade.emotes],
        touringConsent: false
      },
      response: {
        type: 'posted',
        data: {
          requestId,
          charadeId: charade.id,
          daily: { ...ownerPatch.after.daily },
          revision: 1,
          stampAwarded: false,
          title: '',
          nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 1 },
          titleUnlocked: true
        }
      },
      charade,
      stats: [ownerPatch]
    }
    await state.beginDurableMutation(mutation)
    await state.applyDurableMutation(mutation)
    storage.sceneWriteOutcomes = [false, true, false, false]
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await repository.flush()
    logSpy.mockRestore()

    expect(storage.readJSON<string[]>(indexKey(day))).toEqual([...existingIds, charade.id])
    expect(storage.readJSON(charadeKey(charade.id))).toBeNull()

    const restartedRepository = createStorageRepository(storage)
    const restarted = new GhostlightState(restartedRepository, () => FIXED_NOW)
    await restarted.hydrate()

    expect(restarted.getCharade(charade.id)).toEqual(charade)
    expect(storage.readJSON<string[]>(indexKey(day))).toHaveLength(MAX_INDEX_IDS_PER_DAY)
    expect(storage.readJSON(charadeKey(charade.id))).toEqual(charade)
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toBeNull()
    expect(restartedRepository.getDirtyKeys()).toEqual([])
  })

  it('recovers an active reply after its target ages beyond the ordinary hydration window', async () => {
    const owner = `0x${'7'.repeat(40)}`
    const author = `0x${'8'.repeat(40)}`
    const targetDay = FIXED_NOW - (HYDRATION_DAYS - 1) * 86_400_000
    const day = dayKey(FIXED_NOW)
    const requestId = 'aged-reply-request'
    const { storage, repository, state } = setup()
    await state.hydrate()
    const target = makeCharade('aged-reply-target', {
      author: makeLook(author, 'Author'),
      createdAt: targetDay,
      touringConsent: true
    })
    state.upsertCharade(target)
    await repository.flushNow()
    const updated = {
      ...target,
      reply: makeReply(owner, 'Replier', { requestId, createdAt: FIXED_NOW })
    }
    const mutation: DurableMutation = {
      v: 1,
      id: `${owner}:post:${requestId}`,
      owner,
      requestId,
      createdAt: FIXED_NOW,
      fingerprint: {
        kind: 'post',
        phraseId: target.phraseId,
        emotes: [...updated.reply.emotes],
        touringConsent: false,
        replyTo: target.id
      },
      response: {
        type: 'posted',
        data: {
          requestId,
          charadeId: target.id,
          replyTo: target.id,
          daily: { day, decoded: 0, authored: 0, stamped: false },
          revision: 0,
          stampAwarded: false,
          title: '',
          nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 },
          titleUnlocked: false
        }
      },
      charade: updated,
      stats: [
        {
          address: author,
          persistent: true,
          after: {
            name: 'Author',
            decoded: 0,
            correct: 0,
            authoredCount: 0,
            lastSeenAt: FIXED_NOW,
            pending: { triedYou: 0, gotYou: 0, replies: 1, mail: 0 },
            daily: { day, decoded: 0, authored: 0, stamped: false },
            revision: 0,
            title: ''
          }
        }
      ]
    }
    await state.beginDurableMutation(mutation)

    const restartedRepository = createStorageRepository(storage)
    const restarted = new GhostlightState(restartedRepository, () => FIXED_NOW + 86_400_000)
    await restarted.hydrate()

    expect(restarted.getCharade(target.id)).toBeNull()
    expect(restarted.getPool().some((charade) => charade.id === target.id)).toBe(false)
    expect(storage.readJSON(charadeKey(target.id))).toEqual(updated)
    expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toBeNull()
    expect(restartedRepository.getDirtyKeys()).toEqual([])
  })

  it.each(['direct post', 'countable guess'] as const)(
    'preserves the historical index and excludes an expired $kind target after recovery',
    async (kind) => {
      const owner = `0x${'9'.repeat(40)}`
      const author = `0x${'a'.repeat(40)}`
      const day = dayKey(FIXED_NOW)
      const target = makeCharade(`aged-${kind.replace(' ', '-')}`, {
        author: makeLook(kind === 'direct post' ? owner : author, kind === 'direct post' ? 'Poster' : 'Author'),
        createdAt: FIXED_NOW,
        lastGuessAt: kind === 'direct post' ? 0 : FIXED_NOW,
        guesses: kind === 'direct post' ? { total: 0, correct: 0 } : { total: 1, correct: 1 }
      })
      const siblings = ['historical-sibling-a', 'historical-sibling-b']
      const { storage, state } = setup()
      storage.putJSON(indexKey(day), [...siblings, ...(kind === 'countable guess' ? [target.id] : [])])
      siblings.forEach((id) => storage.putJSON(charadeKey(id), makeCharade(id)))
      if (kind === 'countable guess')
        storage.putJSON(charadeKey(target.id), { ...target, guesses: { total: 0, correct: 0 } })
      await state.hydrate()

      let mutation: DurableMutation
      if (kind === 'direct post') {
        const ownerPatch = {
          address: owner,
          persistent: true,
          authoredAdd: target.id,
          after: {
            name: 'Poster',
            decoded: 0,
            correct: 0,
            authoredCount: 1,
            lastSeenAt: FIXED_NOW,
            pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 },
            daily: { day, decoded: 0, authored: 1, stamped: false },
            revision: 1,
            title: '' as const
          }
        }
        mutation = {
          v: 1,
          id: `${owner}:post:aged-post-request`,
          owner,
          requestId: 'aged-post-request',
          createdAt: FIXED_NOW,
          fingerprint: {
            kind: 'post',
            phraseId: target.phraseId,
            emotes: [...target.emotes],
            touringConsent: false
          },
          response: {
            type: 'posted',
            data: {
              requestId: 'aged-post-request',
              charadeId: target.id,
              daily: { ...ownerPatch.after.daily },
              revision: 1,
              stampAwarded: false,
              title: '',
              nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 1 },
              titleUnlocked: true
            }
          },
          charade: target,
          stats: [ownerPatch]
        }
      } else {
        const decoder = { address: owner, name: 'Decoder', correct: 1, total: 1 }
        mutation = makeDurableMutation({
          owner,
          requestId: 'aged-guess-request',
          id: `${owner}:guess:aged-guess-request`,
          fingerprint: {
            kind: 'guess',
            charadeId: target.id,
            answerIndex: 1,
            spotlight: false,
            roundId: null
          },
          notifiedAuthor: author,
          charade: target,
          stats: [
            {
              address: owner,
              persistent: true,
              seenAdd: target.id,
              after: {
                name: 'Decoder',
                decoded: 1,
                correct: 1,
                authoredCount: 0,
                lastSeenAt: FIXED_NOW,
                pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 },
                daily: { day, decoded: 1, authored: 0, stamped: false },
                revision: 1,
                title: '',
                showSet: {
                  showKey: `daily:${day}`,
                  round: 1,
                  score: 100,
                  streak: 1,
                  bestStreak: 1,
                  understood: 1
                }
              }
            },
            {
              address: author,
              persistent: true,
              after: {
                name: 'Author',
                decoded: 0,
                correct: 0,
                authoredCount: 0,
                lastSeenAt: FIXED_NOW,
                pending: { triedYou: 1, gotYou: 1, replies: 0, mail: 0 },
                daily: { day, decoded: 0, authored: 0, stamped: false },
                revision: 0,
                title: ''
              }
            }
          ],
          decoder: { day, row: decoder },
          boards: { day, value: { decoders: [decoder], hardest: [] } }
        })
      }
      await state.beginDurableMutation(mutation)

      const restartedRepository = createStorageRepository(storage)
      const restarted = new GhostlightState(restartedRepository, () => FIXED_NOW + HYDRATION_DAYS * 86_400_000)
      await restarted.hydrate()

      expect(storage.readJSON<string[]>(indexKey(day))).toEqual([...siblings, target.id])
      expect(storage.readJSON(charadeKey(target.id))).toEqual(target)
      expect(restarted.getCharade(target.id)).toBeNull()
      expect(restarted.getPool().some((charade) => charade.id === target.id)).toBe(false)
      expect(storage.readJSON<{ active: DurableMutation | null }>(DURABLE_MUTATION_JOURNAL_KEY)?.active).toBeNull()
      expect(restartedRepository.getDirtyKeys()).toEqual([])
    }
  )

  it('fails closed without overwriting a malformed active record', async () => {
    const { storage, repository, state } = setup()
    const malformed = { v: 1, active: { id: 'incomplete' }, completed: [] }
    storage.putJSON(DURABLE_MUTATION_JOURNAL_KEY, malformed)

    await state.hydrate()

    expect(state.isReadOnly).toBe(true)
    expect(storage.readJSON(DURABLE_MUTATION_JOURNAL_KEY)).toEqual(malformed)
    expect(repository.getDirtyKeys()).toEqual([])
  })

  it('fails closed on cross-field corruption in active guess and reply mutations', async () => {
    const day = dayKey(FIXED_NOW)
    const guessCharade = makeCharade('journal-charade', {
      guesses: { total: 1, correct: 1 },
      lastGuessAt: FIXED_NOW
    })
    const decoder = { address: 'player', name: 'Player', correct: 0, total: 1 }
    const guess = makeDurableMutation({
      notifiedAuthor: guessCharade.author.address.toLowerCase(),
      charade: guessCharade,
      decoder: { day, row: decoder },
      boards: { day, value: { decoders: [decoder], hardest: [] } }
    })
    guess.stats.push({
      address: guessCharade.author.address.toLowerCase(),
      persistent: true,
      after: {
        name: guessCharade.author.name,
        decoded: 0,
        correct: 0,
        authoredCount: 0,
        lastSeenAt: FIXED_NOW,
        pending: { triedYou: 1, gotYou: 1, replies: 0, mail: 0 },
        daily: { day, decoded: 0, authored: 0, stamped: false },
        revision: 0,
        title: ''
      }
    })
    const replyOwner = 'replier'
    const replyRequestId = 'reply-request'
    const replyTarget = makeCharade('reply-target', {
      reply: makeReply(replyOwner, 'Replier', { requestId: replyRequestId, createdAt: FIXED_NOW })
    })
    const reply: DurableMutation = {
      v: 1,
      id: `${replyOwner}:post:${replyRequestId}`,
      owner: replyOwner,
      requestId: replyRequestId,
      createdAt: FIXED_NOW,
      fingerprint: {
        kind: 'post',
        phraseId: replyTarget.phraseId,
        emotes: [...replyTarget.reply!.emotes],
        touringConsent: false,
        replyTo: replyTarget.id
      },
      response: {
        type: 'posted',
        data: {
          requestId: replyRequestId,
          charadeId: replyTarget.id,
          replyTo: replyTarget.id,
          daily: { day, decoded: 0, authored: 0, stamped: false },
          revision: 0,
          stampAwarded: false,
          title: '',
          nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 },
          titleUnlocked: false
        }
      },
      charade: replyTarget,
      stats: [
        {
          address: replyTarget.author.address.toLowerCase(),
          persistent: true,
          after: {
            name: replyTarget.author.name,
            decoded: 0,
            correct: 0,
            authoredCount: 0,
            lastSeenAt: FIXED_NOW,
            pending: { triedYou: 0, gotYou: 0, replies: 1, mail: 0 },
            daily: { day, decoded: 0, authored: 0, stamped: false },
            revision: 0,
            title: ''
          }
        }
      ]
    }
    const corruptions: Array<{ label: string; mutation: DurableMutation }> = []
    const wrongGuessResponse = structuredClone(guess)
    wrongGuessResponse.response.data.charadeId = 'different-charade'
    corruptions.push({ label: 'guess response target', mutation: wrongGuessResponse })
    const wrongGuessId = structuredClone(guess)
    wrongGuessId.id = 'different-owner:guess:request'
    corruptions.push({ label: 'owner/request identity', mutation: wrongGuessId })
    const malformedRoundId = structuredClone(guess)
    if (malformedRoundId.fingerprint.kind === 'guess') malformedRoundId.fingerprint.roundId = '01'
    corruptions.push({ label: 'non-canonical round identity', mutation: malformedRoundId })
    const wrongGuessAuthor = structuredClone(guess)
    wrongGuessAuthor.stats[1].address = 'different-author'
    corruptions.push({ label: 'guess author stats target', mutation: wrongGuessAuthor })
    const malformedReveal = structuredClone(guess)
    delete malformedReveal.response.data.stats
    corruptions.push({ label: 'typed reveal payload', mutation: malformedReveal })
    const wrongReplyResponse = structuredClone(reply)
    wrongReplyResponse.response.data.charadeId = 'different-charade'
    corruptions.push({ label: 'reply response target', mutation: wrongReplyResponse })
    const wrongReplyAuthor = structuredClone(reply)
    wrongReplyAuthor.stats[0].address = 'different-author'
    corruptions.push({ label: 'reply author stats target', mutation: wrongReplyAuthor })
    const extraGuessStats = makeDurableMutation()
    extraGuessStats.stats.push({
      ...structuredClone(extraGuessStats.stats[0]),
      address: 'unrelated-player'
    })
    corruptions.push({ label: 'unrelated guess stats target', mutation: extraGuessStats })

    const mailOwner = `0x${'3'.repeat(40)}`
    const mailRecipient = `0x${'4'.repeat(40)}`
    const mailRequestId = 'mail-request'
    const mailCharade = makeCharade('mail-charade', {
      author: makeLook(mailOwner, 'Mailer'),
      recipient: mailRecipient,
      createdAt: FIXED_NOW,
      lastGuessAt: 0
    })
    const mailOwnerPatch = {
      address: mailOwner,
      persistent: true,
      after: {
        name: 'Mailer',
        decoded: 0,
        correct: 0,
        authoredCount: 0,
        lastSeenAt: FIXED_NOW,
        pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 },
        daily: { day, decoded: 0, authored: 0, stamped: false },
        revision: 0,
        title: '' as const
      }
    }
    const mailRecipientPatch = {
      address: mailRecipient,
      persistent: true,
      after: {
        name: 'Recipient',
        decoded: 0,
        correct: 0,
        authoredCount: 0,
        lastSeenAt: FIXED_NOW,
        pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 1 },
        daily: { day, decoded: 0, authored: 0, stamped: false },
        revision: 0,
        title: '' as const
      }
    }
    const mail: DurableMutation = {
      v: 1,
      id: `${mailOwner}:post:${mailRequestId}`,
      owner: mailOwner,
      requestId: mailRequestId,
      createdAt: FIXED_NOW,
      fingerprint: {
        kind: 'post',
        phraseId: mailCharade.phraseId,
        emotes: [...mailCharade.emotes],
        touringConsent: false,
        recipient: mailRecipient
      },
      response: {
        type: 'posted',
        data: {
          requestId: mailRequestId,
          charadeId: mailCharade.id,
          recipient: mailRecipient,
          daily: { ...mailOwnerPatch.after.daily },
          revision: 0,
          stampAwarded: false,
          title: '',
          nextUnlock: { nextTitle: 'Understudy', requirement: 'Post your first charade', progress: 0 },
          titleUnlocked: false
        }
      },
      charade: mailCharade,
      stats: [mailOwnerPatch, mailRecipientPatch]
    }
    const missingMailRecipient = structuredClone(mail)
    missingMailRecipient.stats.pop()
    corruptions.push({ label: 'missing mail recipient stats target', mutation: missingMailRecipient })
    const wrongMailRecipient = structuredClone(mail)
    wrongMailRecipient.stats[1].address = `0x${'5'.repeat(40)}`
    corruptions.push({ label: 'wrong mail recipient stats target', mutation: wrongMailRecipient })

    for (const { label, mutation } of corruptions) {
      const { storage, repository, state } = setup()
      const raw = { v: 1, active: mutation, completed: [] }
      storage.putJSON(DURABLE_MUTATION_JOURNAL_KEY, raw)

      await state.hydrate()

      expect(state.isReadOnly, label).toBe(true)
      expect(storage.readJSON(DURABLE_MUTATION_JOURNAL_KEY), label).toEqual(raw)
      expect(repository.getDirtyKeys(), label).toEqual([])
    }
  })

  it('fails closed on a completed replay whose response no longer matches its fingerprint', async () => {
    const mutation = makeDurableMutation()
    const completion = {
      v: mutation.v,
      id: mutation.id,
      owner: mutation.owner,
      requestId: mutation.requestId,
      createdAt: mutation.createdAt,
      fingerprint: mutation.fingerprint,
      response: structuredClone(mutation.response),
      completedAt: FIXED_NOW
    }
    completion.response.data.charadeId = 'different-charade'
    const raw = { v: 1, active: null, completed: [completion] }
    const { storage, repository, state } = setup()
    storage.putJSON(DURABLE_MUTATION_JOURNAL_KEY, raw)

    await state.hydrate()

    expect(state.isReadOnly).toBe(true)
    expect(storage.readJSON(DURABLE_MUTATION_JOURNAL_KEY)).toEqual(raw)
    expect(repository.getDirtyKeys()).toEqual([])
  })

  it('fails closed when journal completion chronology or active identity is contradictory', async () => {
    const mutation = makeDurableMutation()
    const completion = {
      v: mutation.v,
      id: mutation.id,
      owner: mutation.owner,
      requestId: mutation.requestId,
      createdAt: mutation.createdAt,
      fingerprint: mutation.fingerprint,
      response: mutation.response,
      completedAt: mutation.createdAt + 1
    }
    const corruptions = [
      {
        label: 'completion predates mutation',
        raw: { v: 1, active: null, completed: [{ ...completion, completedAt: mutation.createdAt - 1 }] }
      },
      {
        label: 'same mutation is active and completed',
        raw: { v: 1, active: mutation, completed: [completion] }
      },
      {
        label: 'unknown journal field',
        raw: { v: 1, active: null, completed: [], unexpected: true }
      }
    ]

    for (const { label, raw } of corruptions) {
      const { storage, repository, state } = setup()
      storage.putJSON(DURABLE_MUTATION_JOURNAL_KEY, raw)

      await state.hydrate()

      expect(state.isReadOnly, label).toBe(true)
      expect(storage.readJSON(DURABLE_MUTATION_JOURNAL_KEY), label).toEqual(raw)
      expect(repository.getDirtyKeys(), label).toEqual([])
    }
  })

  it('clamps a completion timestamp so a backward clock cannot persist a self-corrupting journal', async () => {
    const { storage, state } = setup()
    await state.hydrate()
    const mutation = makeDurableMutation()
    await state.beginDurableMutation(mutation)

    await state.completeDurableMutation(mutation.id, mutation.createdAt - 1)

    expect(
      storage.readJSON<{ completed: Array<{ completedAt: number }> }>(DURABLE_MUTATION_JOURNAL_KEY)?.completed[0]
    ).toMatchObject({ completedAt: mutation.createdAt })
    const restarted = new GhostlightState(createStorageRepository(storage), () => FIXED_NOW)
    await restarted.hydrate()
    expect(restarted.isReadOnly).toBe(false)
  })

  it('bounds completed history by count and serialized bytes below the host value ceiling', async () => {
    const { storage, state } = setup()
    await state.hydrate()

    for (let index = 0; index < MAX_DURABLE_COMPLETIONS + 8; index += 1) {
      const requestId = `bounded-${index}`
      const mutation = makeDurableMutation({
        id: `player:guess:${requestId}`,
        requestId,
        fingerprint: {
          kind: 'guess',
          charadeId: 'journal-charade',
          answerIndex: 1,
          spotlight: false,
          roundId: null
        }
      })
      await state.beginDurableMutation(mutation)
      await state.completeDurableMutation(mutation.id, FIXED_NOW + index)
    }

    const serialized = storage.scene.get(DURABLE_MUTATION_JOURNAL_KEY)
    expect(typeof serialized).toBe('string')
    const journal = JSON.parse(serialized as string) as { active: unknown; completed: unknown[] }
    expect(journal.active).toBeNull()
    expect(journal.completed.length).toBeLessThanOrEqual(MAX_DURABLE_COMPLETIONS)
    expect(new TextEncoder().encode(serialized as string).byteLength).toBeLessThanOrEqual(MAX_DURABLE_JOURNAL_BYTES)
    expect(journal.completed).toHaveLength(MAX_DURABLE_COMPLETIONS)
  })
})

describe('state mutations', () => {
  it('upserts charades into the daily index without duplicates and records guesses', async () => {
    const { storage, repository, state } = setup()
    const value = makeCharade('posted')
    state.upsertCharade(value)
    state.upsertCharade(value)

    expect(state.recordGuess('posted', true)).toMatchObject({ guesses: { total: 1, correct: 1 } })
    expect(state.recordGuess('missing', true)).toBeNull()
    expect(state.recordGuess(HOUSE_CHARADE.id, true)).toBeNull()
    await repository.flush()

    expect(storage.readJSON(indexKey(dayKey(FIXED_NOW)))).toEqual(['posted'])
    expect(storage.readJSON<typeof value>(charadeKey('posted'))).toMatchObject({
      id: 'posted',
      guesses: { total: 1, correct: 1 },
      lastGuessAt: FIXED_NOW
    })
  })

  it('attaches exactly one reply atomically and persists the winning reply', async () => {
    const { storage, repository, state } = setup()
    const charade = makeCharade('reply-target', { touringConsent: true })
    const first = makeReply('first', 'First')
    const second = makeReply('second', 'Second')
    state.upsertCharade(charade)

    expect(state.attachReply(charade.id, first)).toBe(true)
    expect(state.attachReply(charade.id, second)).toBe(false)
    expect(state.attachReply(HOUSE_CHARADE.id, first)).toBe(false)
    expect(state.attachReply('missing', first)).toBe(false)
    expect(state.getCharade(charade.id)?.reply).toEqual(first)
    expect(state.getCharade(charade.id)?.touringConsent).toBe(true)
    await repository.flushNow()

    expect(storage.readJSON<typeof charade>(charadeKey(charade.id))?.reply).toEqual(first)
  })

  it('moves a returning visitor to the front and caps the audience at six distinct addresses', () => {
    const { state } = setup()
    for (let index = 0; index < 7; index += 1) state.touchVisitor(makeLook(`address-${index}`))
    state.touchVisitor(makeLook('address-3', 'Returned'))

    expect(state.recentVisitors).toHaveLength(AUDIENCE_SEATS)
    expect(state.recentVisitors[0]).toMatchObject({ address: 'address-3', name: 'Returned' })
    expect(new Set(state.recentVisitors.map((visitor) => visitor.address)).size).toBe(AUDIENCE_SEATS)
    expect(state.recentVisitors.some((visitor) => visitor.address === 'address-0')).toBe(false)
  })

  it('ranks eligible Crowd Pleasers by distance from a 60% solve rate, then audience size', () => {
    const { state } = setup()
    state.upsertCharade(makeCharade('exact-small', { guesses: { total: 5, correct: 3 } }))
    state.upsertCharade(makeCharade('exact-large', { guesses: { total: 10, correct: 6 } }))
    state.upsertCharade(makeCharade('near', { guesses: { total: 3, correct: 2 } }))
    state.upsertCharade(makeCharade('far', { guesses: { total: 4, correct: 1 } }))
    state.upsertCharade(makeCharade('under-threshold', { guesses: { total: 2, correct: 1 } }))
    state.upsertCharade(
      makeCharade('yesterday', {
        createdAt: FIXED_NOW - 24 * 60 * 60 * 1000,
        guesses: { total: 10, correct: 6 }
      })
    )
    HOUSE_CHARADES.forEach((charade) => state.upsertCharade(charade))
    state.recordDecoder('alice', 'Alice', true)
    state.recordDecoder('alice', 'Alice', false)
    state.recordDecoder('bob', 'Bob', true)

    expect(state.boards.decoders).toEqual([
      { address: 'alice', name: 'Alice', correct: 1, total: 2 },
      { address: 'bob', name: 'Bob', correct: 1, total: 1 }
    ])
    expect(state.boards.hardest.map((row) => row.charadeId)).toEqual(['exact-large', 'exact-small', 'near', 'far'])
    expect(state.getPool().some((charade) => charade.isHouse)).toBe(false)
  })

  it('breaks mathematically equal solve-rate distances by the larger audience exactly', () => {
    const { state } = setup()
    state.upsertCharade(makeCharade('forty-percent', { guesses: { total: 5, correct: 2 } }))
    state.upsertCharade(makeCharade('eighty-percent', { guesses: { total: 10, correct: 8 } }))

    expect(state.boards.hardest.map((row) => row.charadeId)).toEqual(['eighty-percent', 'forty-percent'])
  })

  it('has no Crowd Pleaser or Ghost of the Night before a performance receives three guesses', async () => {
    const { state } = setup()
    state.upsertCharade(makeCharade('not-ready', { guesses: { total: 2, correct: 1 } }))
    state.upsertCharade(makeCharade('guest-ready', { author: { isGuest: true }, guesses: { total: 3, correct: 2 } }))
    state.upsertCharade(
      makeCharade('private-ready', { recipient: `0x${'a'.repeat(40)}`, guesses: { total: 5, correct: 3 } })
    )

    expect(state.boards.hardest).toEqual([])
    await expect(state.getGhostOfNight()).resolves.toBeNull()
  })

  it('resets decoder standings when the UTC day changes', () => {
    let now = FIXED_NOW
    const changingState = new GhostlightState(
      {
        loadJSON: async (_key, fallback) => fallback,
        loadPlayerJSON: async (_address, _key, fallback) => fallback,
        markDirty: vi.fn(),
        markPlayerDirty: vi.fn()
      },
      () => now
    )
    changingState.recordDecoder('alice', 'Alice', true)
    now += 24 * 60 * 60 * 1000

    changingState.recordDecoder('bob', 'Bob', false)

    expect(changingState.boards.decoders).toEqual([{ address: 'bob', name: 'Bob', correct: 0, total: 1 }])
  })

  it('prunes charades outside the live fourteen-day window during rollover', () => {
    const { state } = setup()
    state.upsertCharade(makeCharade('expired', { createdAt: FIXED_NOW - 14 * 86_400_000 }))
    state.upsertCharade(makeCharade('retained', { createdAt: FIXED_NOW - 13 * 86_400_000 }))

    state.rollover(FIXED_NOW)

    expect(state.getPool().map((charade) => charade.id)).toEqual(['retained'])
  })

  it('does not prune newer state or reset decoder standings when the clock moves backward', () => {
    let now = FIXED_NOW
    const state = new GhostlightState(
      {
        loadJSON: async (_key, fallback) => fallback,
        loadPlayerJSON: async (_address, _key, fallback) => fallback,
        markDirty: vi.fn(),
        markDirtyBatch: vi.fn(),
        markPlayerDirty: vi.fn()
      },
      () => now
    )
    state.upsertCharade(makeCharade('newer'))
    state.recordDecoder('alice', 'Alice', true)
    const stats = makeStats({ daily: { day: dayKey(FIXED_NOW), decoded: 1, authored: 0, stamped: false } })

    now -= 86_400_000
    state.rollover()

    expect(state.getCharade('newer')).not.toBeNull()
    expect(state.boards.decoders).toEqual([{ address: 'alice', name: 'Alice', correct: 1, total: 1 }])
    expect(state.getDaily(stats)).toEqual({ day: dayKey(FIXED_NOW), decoded: 1, authored: 0, stamped: false })
  })

  it('rejects new charades before mutation when the daily durable budget is full', () => {
    const markDirtyBatch = vi.fn()
    const state = new GhostlightState(
      {
        loadJSON: async (_key, fallback) => fallback,
        loadPlayerJSON: async (_address, _key, fallback) => fallback,
        markDirty: vi.fn(),
        markDirtyBatch,
        markPlayerDirty: vi.fn()
      },
      () => FIXED_NOW
    )
    for (let index = 0; index < MAX_INDEX_IDS_PER_DAY; index += 1) {
      expect(state.upsertCharade(makeCharade(`bounded-${index}`))).toBe(true)
    }

    expect(state.upsertCharade(makeCharade('over-budget'))).toBe(false)
    expect(state.getCharade('over-budget')).toBeNull()
    expect(markDirtyBatch).toHaveBeenCalledTimes(MAX_INDEX_IDS_PER_DAY)
  })

  it('admits every write required by a post before mutating state', () => {
    const { repository, state } = setup()
    for (let index = 0; index < MAX_DIRTY_ENTRIES - 3; index += 1) {
      repository.markDirty(`occupied-${index}`, { index })
    }

    expect(() => state.upsertCharade(makeCharade('no-partial-post'))).toThrow(StorageCapacityError)
    expect(state.getCharade('no-partial-post')).toBeNull()
    expect(repository.getDirtyKeys().some((key) => key.includes('no-partial-post'))).toBe(false)
  })

  it('caps decoder retention and excludes guest performances from competitive surfaces', async () => {
    const dirtyWrites: Array<{ key: string; value: unknown }> = []
    const state = new GhostlightState(
      {
        loadJSON: async (_key, fallback) => fallback,
        loadPlayerJSON: async (_address, _key, fallback) => fallback,
        markDirty: (key, value) => dirtyWrites.push({ key, value }),
        markDirtyBatch: vi.fn(),
        markPlayerDirty: vi.fn()
      },
      () => FIXED_NOW
    )
    state.upsertCharade(makeCharade('guest-show', { author: { isGuest: true }, guesses: { total: 5, correct: 0 } }))
    state.upsertCharade(makeCharade('wallet-show', { guesses: { total: 3, correct: 2 } }))
    for (let index = 0; index < MAX_DAILY_DECODERS + 5; index += 1) {
      state.recordDecoder(`decoder-${index}`, `Decoder ${index}`, index % 2 === 0)
    }

    const decoderWrite = dirtyWrites.filter((write) => write.key === decoderAggregateKey(dayKey(FIXED_NOW))).at(-1)
    expect(decoderWrite?.value).toHaveLength(MAX_DAILY_DECODERS)
    expect(state.boards.hardest.map((row) => row.charadeId)).toEqual(['wallet-show'])
    expect((await state.getRecentPerformers()).map((performer) => performer.address)).toEqual([
      makeCharade('wallet-show').author.address
    ])
  })

  it('restores decoder aggregates below tenth place after a server restart', async () => {
    const storage = new FakeStorage()
    const firstRepository = createStorageRepository(storage)
    const firstState = new GhostlightState(firstRepository, () => FIXED_NOW)
    for (let player = 0; player < 11; player += 1) {
      const address = `0x${(player + 1).toString(16).padStart(40, '0')}`
      firstState.recordDecoder(address, `Player ${player}`, false)
      for (let correct = 0; correct < player; correct += 1) {
        firstState.recordDecoder(address, `Player ${player}`, true)
      }
    }
    firstState.recordDecoder('guest-session', 'Guest', true)
    await firstRepository.flushNow()
    expect(storage.readJSON<unknown[]>(decoderAggregateKey(dayKey(FIXED_NOW)))).toHaveLength(12)

    const secondRepository = createStorageRepository(storage)
    const secondState = new GhostlightState(secondRepository, () => FIXED_NOW)
    await secondState.hydrate()
    const firstAddress = `0x${'1'.padStart(40, '0')}`
    secondState.recordDecoder(firstAddress, 'Player 0', true)
    secondState.recordDecoder(firstAddress, 'Player 0', true)

    expect(secondState.boards.decoders).toContainEqual({
      address: firstAddress,
      name: 'Player 0',
      correct: 2,
      total: 3
    })
    expect(secondState.boards.decoders.some((row) => row.address === 'guest-session')).toBe(false)
  })

  it('builds the playbill from the latest six real performances and selects its Crowd Pleaser as Ghost of the Night', async () => {
    const { state } = setup()
    for (let index = 0; index < 7; index += 1) {
      state.upsertCharade(
        makeCharade(`show-${index}`, {
          createdAt: FIXED_NOW - (7 - index) * 1_000,
          guesses: { total: index + 1, correct: index === 0 ? 0 : index },
          author: { address: `performer-${index}`, name: `Performer ${index}` }
        })
      )
    }
    HOUSE_CHARADES.forEach((charade) => state.upsertCharade(charade))
    const latestStats = await state.getOrCreateStats('performer-6', 'Performer 6')
    latestStats.authored.push('show-6')
    latestStats.authoredCount = 1

    const playbill = await state.getRecentPerformers()
    const ghost = await state.getGhostOfNight()

    expect(playbill.map((performer) => performer.name)).toEqual([
      'Performer 6',
      'Performer 5',
      'Performer 4',
      'Performer 3',
      'Performer 2',
      'Performer 1'
    ])
    expect(playbill[0].title).toBe('Understudy')
    expect(playbill.some((performer) => performer.name === 'House')).toBe(false)
    expect(ghost).toMatchObject({ charade: { id: 'show-2', isHouse: false }, title: '' })
  })

  it('keeps mailed charades private while retaining bounded recipient delivery state', async () => {
    const { state } = setup()
    const recipient = `0x${'a'.repeat(40)}`
    const sender = `0x${'b'.repeat(40)}`
    const publicCharade = makeCharade('public', {
      author: { address: recipient, name: 'Recipient' },
      createdAt: FIXED_NOW - 1,
      guesses: { total: 3, correct: 2 }
    })
    const mailed = makeCharade('private-mail', {
      author: { address: sender, name: 'Sender' },
      recipient,
      guesses: { total: 5, correct: 0 }
    })
    state.upsertCharade(publicCharade)
    state.upsertCharade(mailed)

    expect(state.getPool().map((charade) => charade.id)).toEqual([publicCharade.id])
    expect(state.getPlayerCharades().map((charade) => charade.id)).toEqual([publicCharade.id, mailed.id])
    expect(state.getMailForRecipient(recipient, [])?.id).toBe(mailed.id)
    expect(state.countMailForRecipient(recipient, [])).toBe(1)
    expect(state.countMailForRecipient(recipient, [mailed.id])).toBe(0)
    expect(state.boards.hardest.map((row) => row.charadeId)).toEqual([publicCharade.id])
    expect((await state.getRecentPerformers()).map((performer) => performer.address)).toEqual([recipient])
    expect(state.getKnownRecipient(recipient)).toMatchObject({ address: recipient, isGuest: false })
  })

  it('keeps off-policy mail stored and private until its phrase becomes allowed across a restart', async () => {
    const storage = new FakeStorage()
    const firstRepository = createStorageRepository(storage)
    const firstState = new GhostlightState(firstRepository, () => FIXED_NOW)
    const recipient = `0x${'a'.repeat(40)}`
    const offPolicy = makeCharade('off-policy-mail', {
      phraseId: 'food-burn-the-toast',
      recipient,
      createdAt: FIXED_NOW - 2
    })
    const allowed = makeCharade('allowed-mail', {
      phraseId: 'everyday-wake-up-late',
      recipient,
      createdAt: FIXED_NOW - 1
    })
    const seen = ['already-seen']
    const exclude = ['excluded']
    const currentPolicy = new Set<string>([allowed.phraseId])

    firstState.upsertCharade(offPolicy)
    firstState.upsertCharade(allowed)

    expect(firstState.countMailForRecipient(recipient, seen, currentPolicy)).toBe(1)
    expect(firstState.getMailForRecipient(recipient, seen, exclude, currentPolicy)?.id).toBe(allowed.id)
    expect(firstState.countMailForRecipient(recipient, seen, new Set())).toBe(0)
    expect(firstState.getMailForRecipient(recipient, seen, exclude, new Set())).toBeNull()
    expect(firstState.getCharade(offPolicy.id)).toEqual(offPolicy)
    expect(firstState.getPlayerCharades().map((charade) => charade.id)).toEqual([offPolicy.id, allowed.id])
    expect(firstState.getPool()).toEqual([])
    expect(firstState.boards.hardest).toEqual([])
    await expect(firstState.getRecentPerformers()).resolves.toEqual([])
    expect(seen).toEqual(['already-seen'])
    expect(exclude).toEqual(['excluded'])
    await firstRepository.flushNow()

    const secondState = new GhostlightState(createStorageRepository(storage), () => FIXED_NOW)
    await secondState.hydrate()
    const expandedPolicy = new Set<string>([allowed.phraseId, offPolicy.phraseId])

    expect(secondState.countMailForRecipient(recipient, seen, currentPolicy)).toBe(1)
    expect(secondState.getMailForRecipient(recipient, seen, exclude, currentPolicy)?.id).toBe(allowed.id)
    expect(secondState.countMailForRecipient(recipient, seen, expandedPolicy)).toBe(2)
    expect(secondState.getMailForRecipient(recipient, seen, exclude, expandedPolicy)?.id).toBe(offPolicy.id)
    expect(secondState.getMailForRecipient(recipient, [offPolicy.id], exclude, expandedPolicy)?.id).toBe(allowed.id)
    expect(secondState.getMailForRecipient(recipient, seen, [offPolicy.id], expandedPolicy)?.id).toBe(allowed.id)
    expect(secondState.getPool()).toEqual([])
    expect(secondState.boards.hardest).toEqual([])
    await expect(secondState.getRecentPerformers()).resolves.toEqual([])
    expect(seen).toEqual(['already-seen'])
    expect(exclude).toEqual(['excluded'])
  })

  it('round-trips ordinary touring consent across server sleep without changing pool eligibility', async () => {
    const storage = new FakeStorage()
    const firstRepository = createStorageRepository(storage)
    const firstState = new GhostlightState(firstRepository, () => FIXED_NOW)
    const optedIn = makeCharade('touring-opt-in', { touringConsent: true })
    const optedOut = makeCharade('touring-opt-out', { touringConsent: false, createdAt: FIXED_NOW + 1 })
    firstState.upsertCharade(optedIn)
    firstState.upsertCharade(optedOut)
    await firstRepository.flushNow()

    const restored = new GhostlightState(createStorageRepository(storage), () => FIXED_NOW + 1)
    await restored.hydrate()

    expect(restored.getPool()).toEqual([optedIn, optedOut])
    expect(restored.getCharade(optedIn.id)?.touringConsent).toBe(true)
    expect(restored.getCharade(optedOut.id)?.touringConsent).toBe(false)
  })
})

describe('player stats', () => {
  it('loads once, retains exact active-pool seen ids, consumes pending counts, and persists the reset', async () => {
    const { storage, repository, state } = setup()
    const seen = Array.from({ length: 205 }, (_, index) => `seen-${index}`)
    storage.putPlayerJSON(
      'player',
      PLAYER_STATS_KEY,
      makeStats({ seen, pending: { triedYou: 5, gotYou: 2, replies: 3, mail: 2 } })
    )
    seen.forEach((id, index) => {
      state.upsertCharade(makeCharade(id, { createdAt: FIXED_NOW - Math.floor(index / 103) * 86_400_000 }))
    })

    const stats = await state.getOrCreateStats('player', 'Current name')
    expect(stats.seen).toEqual(seen)
    expect(await state.getOrCreateStats('player', 'Renamed')).toBe(stats)
    expect(storage.playerGets).toHaveLength(1)
    state.upsertCharade(makeCharade('seen-205'))
    stats.seen.push('seen-100', 'seen-205')

    expect(state.consumePending('player')).toEqual({ triedYou: 5, gotYou: 2, replies: 3, mail: 2 })
    expect(stats.pending).toEqual({ triedYou: 0, gotYou: 0, replies: 0, mail: 0 })
    expect(stats.seen).toHaveLength(206)
    expect(new Set(stats.seen).size).toBe(206)
    expect(stats.seen.at(-1)).toBe('seen-205')
    await repository.flushNow()

    expect(storage.readPlayerJSON<typeof stats>('player', PLAYER_STATS_KEY)).toMatchObject({
      name: 'Renamed',
      pending: { triedYou: 0, gotYou: 0, replies: 0, mail: 0 },
      seen: stats.seen,
      lastSeenAt: FIXED_NOW
    })
  })

  it('keeps guest stats in memory without reading or writing player storage', async () => {
    const { storage, repository, state } = setup()
    const guest = await state.getOrCreateStats('guest-session', 'Guest', false)
    guest.decoded = 1
    state.saveStats('guest-session', false)
    await repository.flush()

    expect(storage.playerGets).toEqual([])
    expect(storage.writes).toEqual([])
  })

  it('evicts the least-recent inactive stats after durable checkpoints can run', async () => {
    const { state } = setup()
    for (let index = 0; index < 257; index += 1) {
      await state.getOrCreateStats(`guest-${index}`, `Guest ${index}`, false)
    }

    state.evictInactiveStats(new Set())

    expect(state.playerStats.size).toBe(256)
    expect(state.playerStats.has('guest-0')).toBe(false)
    expect(state.playerStats.has('guest-256')).toBe(true)
  })

  it('awards one daily stamp at three decodes and one authored charade and restores it after server sleep', async () => {
    const storage = new FakeStorage()
    const firstRepository = createStorageRepository(storage)
    const firstState = new GhostlightState(firstRepository, () => FIXED_NOW)
    const stats = await firstState.getOrCreateStats('player', 'Player')

    expect(firstState.recordDailyAuthor(stats)).toBe(false)
    expect(firstState.recordDailyDecode(stats)).toBe(false)
    expect(firstState.recordDailyDecode(stats)).toBe(false)
    expect(firstState.recordDailyDecode(stats)).toBe(true)
    expect(firstState.recordDailyDecode(stats)).toBe(false)
    firstState.saveStats('player')
    await firstRepository.flushNow()

    const secondRepository = createStorageRepository(storage)
    const secondState = new GhostlightState(secondRepository, () => FIXED_NOW)
    const restored = await secondState.getOrCreateStats('player', 'Player')

    expect(restored.daily).toEqual({ day: '2026-08-23', decoded: 4, authored: 1, stamped: true })
    expect(restored.stampedDays).toEqual(['2026-08-23'])
  })

  it('preserves an exact Show Set key across a server restart without adding one to a legacy set', async () => {
    const storage = new FakeStorage()
    const firstRepository = createStorageRepository(storage)
    const firstState = new GhostlightState(firstRepository, () => FIXED_NOW)
    const keyed = await firstState.getOrCreateStats('keyed-player', 'Keyed Player')
    const legacy = await firstState.getOrCreateStats('legacy-player', 'Legacy Player')
    keyed.showSet = {
      showKey: 'season-zero:first-impressions',
      round: 3,
      score: 400,
      streak: 2,
      bestStreak: 2,
      understood: 2
    }
    legacy.showSet = { round: 2, score: 150, streak: 1, bestStreak: 1, understood: 1 }
    firstState.saveStats('keyed-player')
    firstState.saveStats('legacy-player')
    await firstRepository.flushNow()

    const secondState = new GhostlightState(createStorageRepository(storage), () => FIXED_NOW)

    await expect(secondState.getOrCreateStats('keyed-player', 'Keyed Player')).resolves.toMatchObject({
      showSet: {
        showKey: 'season-zero:first-impressions',
        round: 3,
        score: 400,
        streak: 2,
        bestStreak: 2,
        understood: 2
      }
    })
    await expect(secondState.getOrCreateStats('legacy-player', 'Legacy Player')).resolves.toMatchObject({
      showSet: { round: 2, score: 150, streak: 1, bestStreak: 1, understood: 1 }
    })
    expect((await secondState.getOrCreateStats('legacy-player', 'Legacy Player')).showSet?.showKey).toBeUndefined()
  })

  it('returns empty pending counts for an unknown player', () => {
    const { state } = setup()
    expect(state.consumePending('missing')).toEqual({ triedYou: 0, gotYou: 0, replies: 0, mail: 0 })
  })

  it('advances and saturates the authoritative progression revision', () => {
    const { state } = setup()
    const stats = makeStats({ revision: 4 })

    expect(state.advanceProgressRevision(stats)).toBe(5)
    stats.revision = 2_147_483_647
    expect(state.advanceProgressRevision(stats)).toBe(2_147_483_647)
  })
})
