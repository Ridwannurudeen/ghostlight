import { describe, expect, it, vi } from 'vitest'
import { AUDIENCE_SEATS, HYDRATION_DAYS } from '../src/shared/config'
import { HOUSE_CHARADE } from '../src/shared/deck'
import { STORAGE_SCHEMA_VERSION } from '../src/shared/types'
import {
  GhostCharadesState,
  computeProgress,
  computeTitle,
  dayKey,
  migrateCharade,
  migrateLook,
  migratePlayerStats
} from '../src/server/state'
import {
  PLAYER_STATS_KEY,
  RECENT_VISITORS_KEY,
  boardsKey,
  charadeKey,
  createStorageRepository,
  indexKey
} from '../src/server/storage'
import { FIXED_NOW, FakeStorage, emptyBoards, makeCharade, makeLook, makeStats } from './test-helpers'

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
  const state = new GhostCharadesState(repository, () => now)
  return { storage, repository, state }
}

describe('state migrations', () => {
  it('accepts a complete look and rejects malformed boundaries', () => {
    const look = makeLook('0xlook', 'Look')
    expect(migrateLook(look)).toEqual(look)
    expect(migrateLook(null)).toBeNull()
    expect(migrateLook({ ...look, address: 4 })).toBeNull()
    expect(migrateLook({ ...look, skinColor: { r: 1, g: 1 } })).toBeNull()
  })

  it('migrates v0 charades and rejects unsupported or malformed records', () => {
    const legacy = { ...makeCharade('legacy'), v: 0, lastGuessAt: undefined }
    expect(migrateCharade(legacy)).toMatchObject({
      v: STORAGE_SCHEMA_VERSION,
      id: 'legacy',
      lastGuessAt: FIXED_NOW
    })
    expect(migrateCharade({ ...legacy, v: 99 })).toBeNull()
    expect(migrateCharade({ ...legacy, emotes: ['wave', 'clap'] })).toBeNull()
    expect(migrateCharade('{bad json')).toBeNull()
  })

  it('migrates and bounds player stats while defaulting garbage', () => {
    const seen = Array.from({ length: 205 }, (_, index) => `seen-${index}`)
    expect(migratePlayerStats({ ...makeStats({ seen }), v: 0 }, 'Fresh name', FIXED_NOW)).toMatchObject({
      v: STORAGE_SCHEMA_VERSION,
      name: 'Player',
      seen: seen.slice(-200)
    })

    expect(migratePlayerStats({ v: 'bad' }, 'Fresh name', FIXED_NOW)).toEqual(makeStats({ name: 'Fresh name' }))
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
        authored: [HOUSE_CHARADE.id, 'player-charade', 'player-charade'],
        title: 'Ghostlight Legend'
      }),
      'Player',
      FIXED_NOW
    )

    expect(migrated.authored).toEqual(['player-charade'])
    expect(migrated.title).toBe('Understudy')
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
  it('loads today and yesterday, skips garbage and stored house records, and always installs the house fallback', async () => {
    const { storage, state } = setup()
    const today = dayKey(FIXED_NOW)
    const yesterday = dayKey(FIXED_NOW - 24 * 60 * 60 * 1000)
    const todayCharade = makeCharade('today')
    const yesterdayCharade = makeCharade('yesterday', { createdAt: FIXED_NOW - 24 * 60 * 60 * 1000 })
    storage.putJSON(indexKey(today), ['today', 'bad', 'stored-house', 'today'])
    storage.putJSON(indexKey(yesterday), ['yesterday'])
    storage.putJSON(charadeKey('today'), todayCharade)
    storage.putJSON(charadeKey('yesterday'), { ...yesterdayCharade, v: 0 })
    storage.scene.set(charadeKey('bad'), '{')
    storage.putJSON(charadeKey('stored-house'), { ...HOUSE_CHARADE, id: 'stored-house' })
    storage.putJSON(RECENT_VISITORS_KEY, 'not-an-array')
    storage.scene.set(boardsKey(today), '{')

    await state.hydrate()

    expect(state.getCharade(HOUSE_CHARADE.id)).toEqual(HOUSE_CHARADE)
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

  it('tolerates missing and throwing storage reads', async () => {
    const { storage, state } = setup()
    storage.getErrors.add(indexKey(dayKey(FIXED_NOW)))
    storage.getErrors.add(RECENT_VISITORS_KEY)

    await expect(state.hydrate()).resolves.toBeUndefined()
    expect(state.getPool()).toEqual([])
    expect(state.getCharade(HOUSE_CHARADE.id)).toEqual(HOUSE_CHARADE)
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

  it('moves a returning visitor to the front and caps the audience at six distinct addresses', () => {
    const { state } = setup()
    for (let index = 0; index < 7; index += 1) state.touchVisitor(makeLook(`address-${index}`))
    state.touchVisitor(makeLook('address-3', 'Returned'))

    expect(state.recentVisitors).toHaveLength(AUDIENCE_SEATS)
    expect(state.recentVisitors[0]).toMatchObject({ address: 'address-3', name: 'Returned' })
    expect(new Set(state.recentVisitors.map((visitor) => visitor.address)).size).toBe(AUDIENCE_SEATS)
    expect(state.recentVisitors.some((visitor) => visitor.address === 'address-0')).toBe(false)
  })

  it('computes decoder standings and hardest ghosts without counting house or old charades', () => {
    const { state } = setup()
    state.upsertCharade(makeCharade('hard-four', { guesses: { total: 4, correct: 0 } }))
    state.upsertCharade(makeCharade('hard-two', { guesses: { total: 2, correct: 0 } }))
    state.upsertCharade(makeCharade('medium', { guesses: { total: 4, correct: 1 } }))
    state.upsertCharade(
      makeCharade('yesterday', {
        createdAt: FIXED_NOW - 24 * 60 * 60 * 1000,
        guesses: { total: 10, correct: 0 }
      })
    )
    state.upsertCharade(HOUSE_CHARADE)
    state.recordDecoder('alice', 'Alice', true)
    state.recordDecoder('alice', 'Alice', false)
    state.recordDecoder('bob', 'Bob', true)

    expect(state.boards.decoders).toEqual([
      { address: 'alice', name: 'Alice', correct: 1, total: 2 },
      { address: 'bob', name: 'Bob', correct: 1, total: 1 }
    ])
    expect(state.boards.hardest.map((row) => row.charadeId)).toEqual(['hard-four', 'hard-two', 'medium'])
  })

  it('resets decoder standings when the UTC day changes', () => {
    let now = FIXED_NOW
    const changingState = new GhostCharadesState(
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

  it('builds the playbill from the latest six real performances and selects the hardest ghost of the night', async () => {
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
    state.upsertCharade(HOUSE_CHARADE)
    const latestStats = await state.getOrCreateStats('performer-6', 'Performer 6')
    latestStats.authored.push('show-6')

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
    expect(ghost).toMatchObject({ charade: { id: 'show-0', isHouse: false }, title: '' })
  })
})

describe('player stats', () => {
  it('loads once, caps and deduplicates seen ids, consumes pending counts, and persists the reset', async () => {
    const { storage, repository, state } = setup()
    const seen = Array.from({ length: 205 }, (_, index) => `seen-${index}`)
    storage.putPlayerJSON('player', PLAYER_STATS_KEY, makeStats({ seen, pending: { triedYou: 5, gotYou: 2 } }))

    const stats = await state.getOrCreateStats('player', 'Current name')
    expect(stats.seen).toEqual(seen.slice(-200))
    expect(await state.getOrCreateStats('player', 'Renamed')).toBe(stats)
    expect(storage.playerGets).toHaveLength(1)
    stats.seen.push('seen-100', 'seen-205')

    expect(state.consumePending('player')).toEqual({ triedYou: 5, gotYou: 2 })
    expect(stats.pending).toEqual({ triedYou: 0, gotYou: 0 })
    expect(stats.seen).toHaveLength(200)
    expect(new Set(stats.seen).size).toBe(200)
    expect(stats.seen.at(-1)).toBe('seen-205')
    await repository.flush()

    expect(storage.readPlayerJSON<typeof stats>('player', PLAYER_STATS_KEY)).toMatchObject({
      name: 'Renamed',
      pending: { triedYou: 0, gotYou: 0 },
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

  it('awards one daily stamp at three decodes and one authored charade and restores it after server sleep', async () => {
    const storage = new FakeStorage()
    const firstRepository = createStorageRepository(storage)
    const firstState = new GhostCharadesState(firstRepository, () => FIXED_NOW)
    const stats = await firstState.getOrCreateStats('player', 'Player')

    expect(firstState.recordDailyAuthor(stats)).toBe(false)
    expect(firstState.recordDailyDecode(stats)).toBe(false)
    expect(firstState.recordDailyDecode(stats)).toBe(false)
    expect(firstState.recordDailyDecode(stats)).toBe(true)
    expect(firstState.recordDailyDecode(stats)).toBe(false)
    firstState.saveStats('player')
    await firstRepository.flushNow()

    const secondRepository = createStorageRepository(storage)
    const secondState = new GhostCharadesState(secondRepository, () => FIXED_NOW)
    const restored = await secondState.getOrCreateStats('player', 'Player')

    expect(restored.daily).toEqual({ day: '2026-08-23', decoded: 4, authored: 1, stamped: true })
    expect(restored.stampedDays).toEqual(['2026-08-23'])
  })

  it('returns empty pending counts for an unknown player', () => {
    const { state } = setup()
    expect(state.consumePending('missing')).toEqual({ triedYou: 0, gotYou: 0 })
  })
})
