import { describe, expect, it, vi } from 'vitest'
import { decodeEvent, encodeEvent } from '@dcl/sdk/network/events/protocol'
import { PROTOCOL_VERSION, THEMES, themeForTimestamp } from '../src/shared/config'
import {
  authorBeatChoices,
  canonicalPerformance,
  CATEGORIES,
  DECK,
  EMOTE_VOCABULARY,
  HOUSE_CHARADE,
  HOUSE_CHARADES,
  isAllowedPerformance,
  isDecodablePerformance,
  performanceMatchCount,
  PLAYABLE_DECK,
  playablePhrase,
  type Category,
  type Phrase,
  type PlayablePhrase
} from '../src/shared/deck'
import { Messages } from '../src/shared/messages'
import {
  chooseCharadeFor,
  chooseHouseCharade,
  chooseRetryBeat,
  dealPhrase,
  phraseTheme,
  pickDecoys,
  shuffleSeeded
} from '../src/shared/pick'
import { STORAGE_SCHEMA_VERSION, type Charade, type Look } from '../src/shared/types'

vi.mock('@dcl/sdk/network', () => ({
  registerMessages: () => ({})
}))

const look = (address: string): Look => ({
  address,
  name: address,
  isGuest: false,
  bodyShape: 'body',
  skinColor: { r: 1, g: 1, b: 1 },
  hairColor: { r: 0, g: 0, b: 0 },
  eyeColor: { r: 0, g: 0, b: 0 },
  wearables: []
})

const charade = (id: string, authorAddress: string, total: number, createdAt: number): Charade => ({
  v: STORAGE_SCHEMA_VERSION,
  id,
  author: look(authorAddress),
  phraseId: PLAYABLE_DECK[0].id,
  emotes: canonicalPerformance(PLAYABLE_DECK[0])!,
  createdAt,
  guesses: { total, correct: 0 },
  lastGuessAt: 0,
  isHouse: false
})

const firstWord = (text: string) => text.trim().split(/\s+/u)[0].toLocaleLowerCase()

function performances(phrase: PlayablePhrase): Array<[string, string, string]> {
  return phrase.beats[0].flatMap((first) =>
    phrase.beats[1].flatMap((second) => phrase.beats[2].map((third) => [first, second, third]))
  )
}

describe('phrase deck', () => {
  it('contains 120 unique, short player phrases split evenly across six categories', () => {
    expect(DECK).toHaveLength(120)
    expect(new Set(DECK.map((phrase) => phrase.id)).size).toBe(DECK.length)
    expect(new Set(DECK.map((phrase) => phrase.text)).size).toBe(DECK.length)

    for (const category of CATEGORIES) {
      expect(DECK.filter((phrase) => phrase.category === category)).toHaveLength(20)
    }

    for (const phrase of DECK) {
      expect(phrase.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      expect(phrase.text.length).toBeGreaterThan(0)
      expect(phrase.text.length).toBeLessThanOrEqual(40)
    }
  })

  it('maps every daily theme to exactly twenty tagged phrases', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual(CATEGORIES)
    for (const theme of THEMES) expect(DECK.filter((phrase) => phrase.theme === theme.id)).toHaveLength(20)
  })

  it('changes the selected theme at the UTC day boundary', () => {
    const beforeMidnight = Date.UTC(2026, 7, 23, 23, 59, 59, 999)
    expect(themeForTimestamp(beforeMidnight)).not.toEqual(themeForTimestamp(beforeMidnight + 1))
  })

  it('uses exactly three distinct verified emotes for every phrase', () => {
    const vocabulary = new Set<string>(EMOTE_VOCABULARY)

    for (const phrase of DECK) {
      expect(phrase.suggested).toHaveLength(3)
      expect(new Set(phrase.suggested).size).toBe(3)
      for (const emote of phrase.suggested) expect(vocabulary.has(emote)).toBe(true)
    }
  })

  it('keeps the reviewed 30-phrase release deck at five per theme and two choices per ordered beat', () => {
    const vocabulary = new Set<string>(EMOTE_VOCABULARY)

    expect(PLAYABLE_DECK).toHaveLength(30)
    expect(PLAYABLE_DECK.length).toBeLessThan(DECK.length)
    expect(new Set(PLAYABLE_DECK.map((phrase) => phrase.id)).size).toBe(PLAYABLE_DECK.length)
    for (const category of CATEGORIES) {
      expect(
        PLAYABLE_DECK.filter((phrase) => phrase.category === category),
        category
      ).toHaveLength(5)
    }

    for (const phrase of PLAYABLE_DECK) {
      expect(playablePhrase(phrase), phrase.id).toBe(phrase)
      expect(playablePhrase(phrase.id), phrase.id).toBe(phrase)
      expect(phrase.beats).toHaveLength(3)
      for (let beat = 0; beat < 3; beat += 1) {
        const choices = authorBeatChoices(phrase, beat)
        expect(choices, `${phrase.id}:${beat}`).toHaveLength(2)
        expect(new Set(choices).size, `${phrase.id}:${beat}`).toBe(choices.length)
        expect(
          choices.every((emote) => vocabulary.has(emote)),
          `${phrase.id}:${beat}`
        ).toBe(true)
      }
      const canonical = canonicalPerformance(phrase)
      expect(canonical, phrase.id).not.toBeNull()
      expect(phrase.suggested, phrase.id).toEqual(canonical)
      expect(new Set(canonical).size, phrase.id).toBe(3)
      expect(isAllowedPerformance(phrase, canonical!), phrase.id).toBe(true)
      expect(performanceMatchCount(phrase, canonical!), phrase.id).toBe(3)
    }

    expect(playablePhrase('everyday-brush-your-teeth')).toBeNull()
    expect(playablePhrase('missing')).toBeNull()
    expect(canonicalPerformance('missing')).toBeNull()
    expect(authorBeatChoices('missing', 0)).toEqual([])
    expect(authorBeatChoices(PLAYABLE_DECK[0], -1)).toEqual([])
    expect(authorBeatChoices(PLAYABLE_DECK[0], 3)).toEqual([])
  })

  it('admits only distinct, position-valid performances and gives every valid performance two fair decoys', () => {
    const ambiguous: string[] = []

    for (const phrase of PLAYABLE_DECK) {
      for (const performed of performances(phrase)) {
        const label = `${phrase.id}:${performed.join(',')}`
        const distinct = new Set(performed).size === 3
        expect(isAllowedPerformance(phrase, performed), label).toBe(distinct)
        if (!distinct) continue
        expect(performanceMatchCount(phrase, performed), label).toBe(3)
        if (!isDecodablePerformance(phrase, performed, PLAYABLE_DECK)) {
          ambiguous.push(label)
          continue
        }
        const decoys = pickDecoys(phrase.id, performed, PLAYABLE_DECK, label)
        expect(decoys, label).toHaveLength(2)
        expect(
          decoys.every((decoy) => performanceMatchCount(decoy, performed) <= 1),
          label
        ).toBe(true)
      }
    }

    expect(ambiguous).toEqual([])

    const phrase = PLAYABLE_DECK[0]
    const repeated = [phrase.beats[0][0], phrase.beats[0][0], phrase.beats[0][0]]
    expect(isAllowedPerformance(phrase, repeated)).toBe(false)
    expect(isDecodablePerformance(phrase, repeated, PLAYABLE_DECK)).toBe(false)
  })

  it('gives every phrase at least two usable same-category decoys', () => {
    for (const phrase of DECK) {
      const sourceFirstWord = firstWord(phrase.text)
      const decoyFirstWords = new Set(
        DECK.filter(
          (candidate) =>
            candidate.id !== phrase.id &&
            candidate.category === phrase.category &&
            firstWord(candidate.text) !== sourceFirstWord
        ).map((candidate) => firstWord(candidate.text))
      )
      expect(decoyFirstWords.size, phrase.id).toBeGreaterThanOrEqual(2)
    }
  })

  it('keeps one reviewed House fallback per category outside the player deck and every real-content count', () => {
    expect(HOUSE_CHARADES).toHaveLength(CATEGORIES.length)
    expect(HOUSE_CHARADES[0]).toBe(HOUSE_CHARADE)
    expect(new Set(HOUSE_CHARADES.map((charade) => charade.id)).size).toBe(HOUSE_CHARADES.length)
    expect(HOUSE_CHARADES.filter((charade) => !charade.isHouse)).toHaveLength(0)

    for (const charade of HOUSE_CHARADES) {
      const phrase = playablePhrase(charade.phraseId)
      expect(charade.isHouse, charade.id).toBe(true)
      expect(charade.author.name, charade.id).toBe('House')
      expect(
        DECK.some((candidate) => candidate.id === charade.id),
        charade.id
      ).toBe(false)
      expect(phrase, charade.id).toBeDefined()
      expect(charade.emotes, charade.id).toEqual(canonicalPerformance(phrase!))
      expect(isAllowedPerformance(phrase!, charade.emotes), charade.id).toBe(true)
    }

    expect(new Set(HOUSE_CHARADES.map((charade) => phraseTheme(charade.phraseId)))).toEqual(new Set(CATEGORIES))
  })
})

describe('shuffleSeeded', () => {
  it('is deterministic, returns a permutation, and does not mutate its input', () => {
    const source = ['a', 'b', 'c', 'd', 'e', 'f']
    const before = [...source]
    const first = shuffleSeeded(source, 'same-seed')

    expect(first).toEqual(shuffleSeeded(source, 'same-seed'))
    expect(first).not.toEqual(shuffleSeeded(source, 'other-seed'))
    expect([...first].sort()).toEqual([...source].sort())
    expect(source).toEqual(before)
  })
})

describe('chooseCharadeFor', () => {
  it('excludes the player, seen charades, and the previous author before ranking', () => {
    const pool = [
      charade('own', '0xPlayer', 0, 1),
      charade('seen', '0xSeen', 0, 1),
      charade('repeat-author', '0xPrevious', 0, 1),
      charade('eligible', '0xOther', 9, 9)
    ]

    expect(chooseCharadeFor('0xplayer', ['seen'], pool, '0xprevious')?.id).toBe('eligible')
  })

  it('uses fewest guesses, then oldest creation time, then id as a stable tie-breaker', () => {
    const pool = [
      charade('many', 'a', 2, 1),
      charade('new', 'b', 1, 20),
      charade('z-old', 'c', 1, 10),
      charade('a-old', 'd', 1, 10)
    ]

    expect(chooseCharadeFor('player', [], pool)?.id).toBe('a-old')
  })

  it('prefers the daily theme before falling back to the normal ranking', () => {
    const themed = charade('themed', 'a', 20, 20)
    themed.phraseId = DECK.find((phrase) => phrase.theme === 'food')!.id
    const fallback = charade('fallback', 'b', 0, 1)

    expect(chooseCharadeFor('player', [], [fallback, themed], '', 'food')?.id).toBe('themed')
    expect(chooseCharadeFor('player', ['themed'], [fallback, themed], '', 'food')?.id).toBe('fallback')
  })

  it('returns null when every charade is excluded', () => {
    expect(chooseCharadeFor('player', ['seen'], [charade('seen', 'other', 0, 0)])).toBeNull()
    expect(chooseCharadeFor('player', [], [charade('own', 'PLAYER', 0, 0)])).toBeNull()
    expect(chooseCharadeFor('player', [], [charade('repeat', 'author', 0, 0)], 'AUTHOR')).toBeNull()
  })

  it('never selects or counts any house fallback from the player pool', () => {
    const playerCharade = charade('player-charade', 'other', 0, 0)
    const pool = [...HOUSE_CHARADES, playerCharade]

    expect(pool.filter((candidate) => !candidate.isHouse)).toHaveLength(1)
    expect(chooseCharadeFor('player', [], HOUSE_CHARADES)).toBeNull()
    expect(chooseCharadeFor('player', [], pool)).toBe(playerCharade)
  })
})

describe('chooseHouseCharade', () => {
  it('is deterministic and varies the fallback across seeds', () => {
    expect(chooseHouseCharade('opening-night')).toBe(chooseHouseCharade('opening-night'))

    const selected = new Set(Array.from({ length: 100 }, (_, seed) => chooseHouseCharade(seed).id))
    expect(selected).toEqual(new Set(HOUSE_CHARADES.map((charade) => charade.id)))
  })

  it('keeps a themed fallback inside the requested daily theme', () => {
    for (const theme of CATEGORIES) {
      const themed = HOUSE_CHARADES.filter((charade) => phraseTheme(charade.phraseId) === theme)
      const selected = new Set(
        Array.from({ length: 100 }, (_, seed) => chooseHouseCharade(`${theme}:${seed}`, theme).id)
      )

      expect(selected, theme).toEqual(new Set(themed.map((charade) => charade.id)))
    }
  })

  it('prefers an allowed fallback in the requested theme', () => {
    const themed = HOUSE_CHARADES.find((charade) => phraseTheme(charade.phraseId) === 'food')!
    const other = HOUSE_CHARADES.find((charade) => phraseTheme(charade.phraseId) !== 'food')!
    const allowed = new Set([themed.phraseId, other.phraseId])

    for (let seed = 0; seed < 100; seed += 1) {
      expect(chooseHouseCharade(seed, 'food', allowed)).toBe(themed)
    }
  })

  it('falls back only within the allow-set when its preferred theme is unavailable', () => {
    const allowedCharades = HOUSE_CHARADES.filter((charade) => phraseTheme(charade.phraseId) !== 'food').slice(0, 2)
    const allowed = new Set(allowedCharades.map((charade) => charade.phraseId))
    const selected = Array.from({ length: 100 }, (_, seed) => chooseHouseCharade(seed, 'food', allowed))

    expect(selected.every((charade) => charade !== null && allowed.has(charade.phraseId))).toBe(true)
    expect(new Set(selected)).toEqual(new Set(allowedCharades))
    expect(chooseHouseCharade('stable', 'food', allowed)).toBe(chooseHouseCharade('stable', 'food', allowed))
  })

  it('returns null instead of using a global fallback when no House phrase is allowed', () => {
    expect(chooseHouseCharade('empty', undefined, new Set())).toBeNull()
    expect(chooseHouseCharade('unknown', 'food', new Set(['not-a-house-phrase']))).toBeNull()
  })
})

describe('pickDecoys', () => {
  it('returns two stable same-category decoys with distinct first words', () => {
    const phrase = PLAYABLE_DECK[0]
    const performed = canonicalPerformance(phrase)!
    const first = pickDecoys(phrase.id, performed, PLAYABLE_DECK, 'charade-7')
    const second = pickDecoys(phrase.id, performed, PLAYABLE_DECK, 'charade-7')

    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    expect(first.every((candidate) => candidate.category === phrase.category)).toBe(true)
    expect(first.every((candidate) => candidate.id !== phrase.id)).toBe(true)
    expect(new Set([firstWord(phrase.text), ...first.map((candidate) => firstWord(candidate.text))]).size).toBe(3)
    expect(first.every((candidate) => performanceMatchCount(candidate, performed) <= 1)).toBe(true)
  })

  it('returns no decoys for an unknown, retired, repeated, or off-plan performance', () => {
    const phrase = PLAYABLE_DECK[0]
    expect(pickDecoys('missing', ['wave', 'clap', 'dab'], PLAYABLE_DECK, 'seed')).toEqual([])
    expect(pickDecoys('everyday-brush-your-teeth', ['wave', 'clap', 'dab'], PLAYABLE_DECK, 'seed')).toEqual([])
    expect(pickDecoys(phrase.id, ['wave', 'wave', 'wave'], PLAYABLE_DECK, 'seed')).toEqual([])
    expect(pickDecoys(phrase.id, ['wave', 'clap', 'dab'], PLAYABLE_DECK, 'seed')).toEqual([])
  })
})

describe('chooseRetryBeat', () => {
  it('replays a position that distinguishes the two remaining answers and is deterministic', () => {
    const phrase = PLAYABLE_DECK[0]
    const performed = canonicalPerformance(phrase)!
    const decoys = pickDecoys(phrase.id, performed, PLAYABLE_DECK, 'retry-options')
    const answerIds = [phrase.id, decoys[0].id, decoys[1].id]
    const args = [performed, answerIds, 1, 'stable', PLAYABLE_DECK] as const
    const selected = chooseRetryBeat(...args)

    expect(selected).toBe(chooseRetryBeat(...args))
    expect(authorBeatChoices(phrase, selected)).toContain(performed[selected])
    expect(authorBeatChoices(decoys[1], selected)).not.toContain(performed[selected])
  })
})

describe('dealPhrase', () => {
  it('is deterministic, respects exclusions, and returns null when nothing remains', () => {
    const excluded = DECK.slice(0, 15).map((phrase) => phrase.id)
    const first = dealPhrase(DECK, excluded, 'deal-seed')

    expect(first).toEqual(dealPhrase(DECK, excluded, 'deal-seed'))
    expect(excluded).not.toContain(first?.id)
    expect(
      dealPhrase(
        DECK.slice(0, 2),
        DECK.slice(0, 2).map((phrase) => phrase.id),
        'seed'
      )
    ).toBeNull()
  })

  it('chooses categories before phrases instead of weighting larger categories', () => {
    const uneven: Phrase[] = [
      {
        id: 'everyday-only',
        text: 'Wave hello',
        category: 'everyday',
        theme: 'everyday',
        suggested: ['wave', 'clap', 'kiss']
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `feelings-${index}`,
        text: `Feeling number ${index}`,
        category: 'feelings' as Category,
        theme: 'feelings' as const,
        suggested: ['shrug', 'dontsee', 'headexplode'] as const
      }))
    ]
    let everydayDeals = 0

    for (let seed = 0; seed < 500; seed += 1) {
      if (dealPhrase(uneven, [], seed)?.category === 'everyday') everydayDeals += 1
    }

    expect(everydayDeals).toBeGreaterThan(175)
    expect(everydayDeals).toBeLessThan(325)
  })
})

describe('installed protocol codec', () => {
  it('round-trips every registered message through the pinned SDK codec below the 4 KB envelope cap', () => {
    const maximalLook = {
      ...look(`0x${'a'.repeat(40)}`),
      name: 'A'.repeat(30),
      bodyShape: 'urn:decentraland:off-chain:base-avatars:BaseFemale',
      wearables: Array.from({ length: 20 }, (_, index) =>
        `urn:decentraland:matic:collections-v2:wearable-${index}`.padEnd(85, 'x')
      )
    }
    const daily = { day: '2026-08-23', decoded: 3, authored: 1, stamped: true }
    const nextUnlock = { nextTitle: 'Scene Stealer', requirement: '10 correct decodes or 5 posts', progress: 0.4 }
    const fixtures: Record<keyof typeof Messages, unknown> = {
      hello: { displayName: 'Player', isGuest: false, protocolVersion: PROTOCOL_VERSION },
      ready: { instanceId: 'instance', serverTime: 1_777_000_000_000, theme: 'food', themeLabel: 'Kitchen Capers' },
      showSchedule: {
        instanceId: 'instance',
        serverTime: 1_789_257_600_000,
        showKey: 'season-zero:first-impressions',
        season: {
          id: 'season-zero',
          weekId: 'first-impressions',
          startsAt: 1_789_257_600_000,
          endsAt: 1_789_862_400_000,
          titleId: 'fresh-face',
          propId: 'calling-card',
          finale: {
            id: 'opening-call',
            startsAt: 1_789_257_600_000,
            endsAt: 1_789_344_000_000
          }
        }
      },
      ping: { seq: 1 },
      pong: { seq: 1 },
      progress: { daily, revision: 2, title: 'Understudy', nextUnlock },
      playerTitle: { address: maximalLook.address, title: 'Understudy' },
      nextCharade: { requestId: 'next-1', exclude: ['one'] },
      charade: {
        requestId: 'next-1',
        id: 'ghost-0000000000000000',
        authorName: maximalLook.name,
        authorAddress: maximalLook.address,
        look: maximalLook,
        emotes: ['wave', 'clap', 'kiss'],
        answers: ['Wake up late', 'Brush your teeth', 'Miss the bus'],
        answerIds: ['everyday-wake-up-late', 'everyday-brush-your-teeth', 'everyday-miss-the-bus'],
        createdAt: 1_777_000_000_000,
        isHouse: false,
        authorTitle: 'Understudy',
        recipient: `0x${'b'.repeat(40)}`,
        setRound: 5,
        setSize: 5,
        setScore: 700,
        setStreak: 3,
        isFinale: true
      },
      guess: { charadeId: 'ghost-1', answerIndex: 1, requestId: 'guess-1', spotlight: true },
      retry: { requestId: 'guess-1', charadeId: 'ghost-1', removedAnswerIndex: 1, replayBeatIndex: 2 },
      reveal: {
        requestId: 'guess-1',
        charadeId: 'ghost-1',
        correct: true,
        phraseId: DECK[0].id,
        phrase: DECK[0].text,
        stats: { total: 3, correct: 2 },
        yourScore: 2,
        daily,
        revision: 2,
        stampAwarded: true,
        attempt: 2,
        title: 'Understudy',
        nextUnlock,
        titleUnlocked: true,
        spotlight: true,
        scoreDelta: 200,
        setRound: 5,
        setSize: 5,
        setScore: 900,
        setStreak: 4,
        setBestStreak: 4,
        setUnderstood: 4,
        setComplete: true,
        isFinale: true
      },
      post: {
        phraseId: DECK[0].id,
        emotes: [...DECK[0].suggested],
        requestId: 'post-1',
        recipient: `0x${'b'.repeat(40)}`
      },
      posted: {
        requestId: 'post-1',
        charadeId: 'ghost-1',
        recipient: `0x${'b'.repeat(40)}`,
        daily,
        revision: 3,
        stampAwarded: true,
        title: 'Understudy',
        nextUnlock,
        titleUnlocked: true
      },
      since: {
        triedYou: 2,
        gotYou: 1,
        replies: 1,
        mail: 1,
        rank: 11,
        daily,
        revision: 2,
        title: 'Understudy',
        nextUnlock
      },
      audience: { looks: [maximalLook] },
      boards: {
        topDecoders: [{ address: maximalLook.address, name: maximalLook.name, correct: 2, total: 3 }],
        hardestGhosts: [{ charadeId: 'ghost-1', authorName: maximalLook.name, total: 3, correct: 1 }],
        playbill: [
          {
            address: maximalLook.address,
            name: maximalLook.name,
            isGuest: false,
            title: 'Understudy',
            performedAt: 1_777_000_000_000
          }
        ],
        ghostOfNightId: 'ghost-1'
      },
      ghostOfNight: {
        charadeId: 'ghost-1',
        address: maximalLook.address,
        name: maximalLook.name,
        title: 'Understudy',
        look: maximalLook,
        total: 3,
        correct: 1
      },
      charadeReply: {
        charadeId: 'ghost-1',
        address: maximalLook.address,
        name: maximalLook.name,
        look: maximalLook,
        emotes: ['wave', 'clap', 'kiss'],
        createdAt: 1_777_000_000_000
      },
      roundStart: { instanceId: 'server', roundId: '1', charadeId: 'ghost-1', showKey: 'season-zero:week-1' },
      roundGuess: { roundId: '1', charadeId: 'ghost-1', answerIndex: 1, requestId: 'round-1', spotlight: true },
      roundWinner: {
        instanceId: 'server',
        roundId: '1',
        charadeId: 'ghost-1',
        showKey: 'season-zero:week-1',
        address: maximalLook.address,
        name: maximalLook.name
      },
      react: { kind: 'genius' },
      requestError: { code: 'invalid-guess', requestId: 'guess-1' },
      error: { code: 'storage-unavailable' }
    }
    const encodedSizes = new Map<keyof typeof Messages, number>()

    expect(Object.keys(Messages)).toContain('showSchedule')

    for (const type of Object.keys(Messages) as Array<keyof typeof Messages>) {
      const encoded = encodeEvent(type, fixtures[type] as never, Messages)
      encodedSizes.set(type, encoded.byteLength)
      const decoded = decodeEvent(encoded, Messages)
      expect(decoded.eventType).toBe(type)
      expect(decoded.payload).toBeDefined()
      expect(encoded.byteLength, type).toBeLessThan(4_000)
      if (type === 'ready') {
        expect((decoded.payload as { serverTime: number }).serverTime).toBe(1_777_000_000_000)
      }
      if (type === 'showSchedule') {
        expect(decoded.payload).toEqual(fixtures.showSchedule)
      }
      if (type === 'charade' || type === 'charadeReply') {
        expect((decoded.payload as { createdAt: number }).createdAt).toBe(1_777_000_000_000)
      }
      if (type === 'charade') {
        expect((decoded.payload as { answerIds: string[] }).answerIds).toEqual([
          'everyday-wake-up-late',
          'everyday-brush-your-teeth',
          'everyday-miss-the-bus'
        ])
      }
    }
    expect(
      Object.fromEntries(
        ['charade', 'guess', 'retry', 'reveal', 'roundGuess'].map((type) => [type, encodedSizes.get(type)])
      )
    ).toEqual({
      charade: 2_350,
      guess: 45,
      retry: 47,
      reveal: 237,
      roundGuess: 55
    })

    const dailySchedule = {
      instanceId: 'instance',
      serverTime: 1_777_000_000_000,
      showKey: 'daily:2026-04-24'
    }
    const decodedDailySchedule = decodeEvent(encodeEvent('showSchedule', dailySchedule as never, Messages), Messages)
    expect(decodedDailySchedule.payload).toEqual(dailySchedule)
    expect(decodedDailySchedule.eventType).toBe('showSchedule')

    const saturatedReveal = {
      ...(fixtures.reveal as Record<string, unknown>),
      stats: { total: 2_147_483_647, correct: 2_147_483_647 },
      yourScore: 2_147_483_647
    }
    const saturated = decodeEvent(encodeEvent('reveal', saturatedReveal as never, Messages), Messages)
    expect(saturated.payload).toMatchObject({
      stats: { total: 2_147_483_647, correct: 2_147_483_647 },
      yourScore: 2_147_483_647
    })
  })
})
