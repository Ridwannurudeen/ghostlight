import { describe, expect, it, vi } from 'vitest'
import { decodeEvent, encodeEvent } from '@dcl/sdk/network/events/protocol'
import { THEMES, themeForTimestamp } from '../src/shared/config'
import {
  CATEGORIES,
  DECK,
  EMOTE_VOCABULARY,
  HOUSE_CHARADE,
  HOUSE_CHARADES,
  type Category,
  type Phrase
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
  phraseId: DECK[0].id,
  emotes: [...DECK[0].suggested],
  createdAt,
  guesses: { total, correct: 0 },
  lastGuessAt: 0,
  isHouse: false
})

const firstWord = (text: string) => text.trim().split(/\s+/u)[0].toLocaleLowerCase()

const canonicalTriplet = (phrase: Phrase) => [...phrase.suggested].sort().join(':')

const COLLISION_GROUPS = [
  ['food-share-the-popcorn', 'food-toast-a-marshmallow', 'food-serve-breakfast'],
  ['awkward-wave-at-wrong-person', 'awkward-enter-wrong-room'],
  ['food-steal-some-fries', 'food-hunt-a-midnight-snack']
] as const

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

  it('keeps eleven labelled house charades outside the player deck and every real-content count', () => {
    expect(HOUSE_CHARADES).toHaveLength(11)
    expect(HOUSE_CHARADES[0]).toBe(HOUSE_CHARADE)
    expect(new Set(HOUSE_CHARADES.map((charade) => charade.id)).size).toBe(HOUSE_CHARADES.length)
    expect(HOUSE_CHARADES.filter((charade) => !charade.isHouse)).toHaveLength(0)

    for (const charade of HOUSE_CHARADES) {
      const phrase = DECK.find((candidate) => candidate.id === charade.phraseId)
      expect(charade.isHouse, charade.id).toBe(true)
      expect(charade.author.name, charade.id).toBe('House')
      expect(
        DECK.some((candidate) => candidate.id === charade.id),
        charade.id
      ).toBe(false)
      expect(phrase, charade.id).toBeDefined()
      expect(charade.emotes, charade.id).toEqual(phrase?.suggested)
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
    const phrase = DECK[0]
    const first = pickDecoys(phrase.id, phrase.suggested, DECK, 'charade-7')
    const second = pickDecoys(phrase.id, phrase.suggested, DECK, 'charade-7')

    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    expect(first.every((candidate) => candidate.category === phrase.category)).toBe(true)
    expect(first.every((candidate) => candidate.id !== phrase.id)).toBe(true)
    expect(new Set([firstWord(phrase.text), ...first.map((candidate) => firstWord(candidate.text))]).size).toBe(3)
  })

  it('rejects truth and performed triplet collisions, then picks the closest and most distant decoys', () => {
    const fixture: Phrase[] = [
      {
        id: 'everyday-source',
        text: 'Act the source',
        category: 'everyday',
        theme: 'everyday',
        suggested: ['wave', 'clap', 'kiss']
      },
      {
        id: 'everyday-ordered-collision',
        text: 'Copy it exactly',
        category: 'everyday',
        theme: 'everyday',
        suggested: ['wave', 'clap', 'kiss']
      },
      {
        id: 'everyday-unordered-collision',
        text: 'Reorder that copy',
        category: 'everyday',
        theme: 'everyday',
        suggested: ['kiss', 'wave', 'clap']
      },
      {
        id: 'everyday-performed-collision',
        text: 'Match every move',
        category: 'everyday',
        theme: 'everyday',
        suggested: ['dab', 'wave', 'clap']
      },
      {
        id: 'everyday-close',
        text: 'Echo two moves',
        category: 'everyday',
        theme: 'everyday',
        suggested: ['wave', 'clap', 'robot']
      },
      {
        id: 'everyday-middle',
        text: 'Echo one move',
        category: 'everyday',
        theme: 'everyday',
        suggested: ['wave', 'robot', 'money']
      },
      {
        id: 'everyday-distant',
        text: 'Stand far apart',
        category: 'everyday',
        theme: 'everyday',
        suggested: ['robot', 'money', 'shrug']
      }
    ]

    expect(pickDecoys('everyday-source', ['wave', 'clap', 'dab'], fixture, 'performance-aware')).toEqual([
      fixture[4],
      fixture[6]
    ])
  })

  it('never serves any known canonical-collision pair together', () => {
    for (const ids of COLLISION_GROUPS) {
      const collisionKey = canonicalTriplet(DECK.find((phrase) => phrase.id === ids[0])!)
      expect(ids.map((id) => canonicalTriplet(DECK.find((phrase) => phrase.id === id)!))).toEqual(
        ids.map(() => collisionKey)
      )

      for (const phraseId of ids) {
        const phrase = DECK.find((candidate) => candidate.id === phraseId)!
        const servedIds = new Set([
          phrase.id,
          ...pickDecoys(phrase.id, phrase.suggested, DECK, `collision:${phrase.id}`).map((decoy) => decoy.id)
        ])
        expect(
          ids.filter((id) => servedIds.has(id)),
          phrase.id
        ).toEqual([phrase.id])
      }
    }
  })

  it('excludes every same-category canonical-collision pair in the full deck', () => {
    const collisionPairs = DECK.flatMap((left, index) =>
      DECK.slice(index + 1)
        .filter((right) => right.category === left.category && canonicalTriplet(right) === canonicalTriplet(left))
        .map((right) => [left, right] as const)
    )
    expect(new Set(collisionPairs.flatMap((pair) => pair.map((phrase) => phrase.id))).size).toBe(21)

    for (const [left, right] of collisionPairs) {
      for (const phrase of [left, right]) {
        const decoyIds = pickDecoys(phrase.id, phrase.suggested, DECK, `pair:${left.id}:${right.id}:${phrase.id}`).map(
          (decoy) => decoy.id
        )
        expect(decoyIds, `${phrase.id}:${left.id}:${right.id}`).not.toContain(phrase === left ? right.id : left.id)
      }
    }
  })

  it('keeps all three served canonical triplets pairwise distinguishable for every phrase and seeded performance', () => {
    for (const phrase of DECK) {
      for (let seed = 0; seed < EMOTE_VOCABULARY.length; seed += 1) {
        const performed = [
          EMOTE_VOCABULARY[seed],
          EMOTE_VOCABULARY[(seed + 5) % EMOTE_VOCABULARY.length],
          EMOTE_VOCABULARY[(seed + 11) % EMOTE_VOCABULARY.length]
        ]
        const decoys = pickDecoys(phrase.id, performed, DECK, `deck:${phrase.id}:${seed}`)
        const options = [phrase, ...decoys]
        const performedTriplet = [...performed].sort().join(':')

        expect(decoys, `${phrase.id}:${seed}`).toHaveLength(2)
        expect(
          decoys.every((decoy) => canonicalTriplet(decoy) !== performedTriplet),
          `${phrase.id}:${seed}:performed`
        ).toBe(true)
        expect(new Set(options.map(canonicalTriplet)).size, `${phrase.id}:${seed}`).toBe(3)
      }
    }
  })

  it('returns no decoys for an unknown phrase', () => {
    expect(pickDecoys('missing', ['wave', 'clap', 'dab'], DECK, 'seed')).toEqual([])
  })
})

describe('chooseRetryBeat', () => {
  const fixture: Phrase[] = [
    {
      id: 'one',
      text: 'One',
      category: 'everyday',
      theme: 'everyday',
      suggested: ['wave', 'clap', 'kiss']
    },
    {
      id: 'two',
      text: 'Two',
      category: 'everyday',
      theme: 'everyday',
      suggested: ['wave', 'robot', 'money']
    },
    {
      id: 'removed',
      text: 'Removed',
      category: 'everyday',
      theme: 'everyday',
      suggested: ['dab', 'shrug', 'dontsee']
    }
  ]

  it('prefers a beat present in exactly one remaining canonical triplet, then zero, then two', () => {
    expect(chooseRetryBeat(['wave', 'clap', 'dab'], ['one', 'two', 'removed'], 2, 'frequency', fixture)).toBe(1)
    expect([1, 2]).toContain(
      chooseRetryBeat(['wave', 'dab', 'shrug'], ['one', 'two', 'removed'], 2, 'zero-before-two', fixture)
    )
    expect(
      chooseRetryBeat(['wave', 'wave', 'wave'], ['one', 'two', 'removed'], 2, 'all-common', fixture)
    ).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic and depends only on performed beats, public answers, removal, and seed', () => {
    const args = [['clap', 'robot', 'dab'], ['one', 'two', 'removed'], 2, 'stable', fixture] as const
    const selected = chooseRetryBeat(...args)

    expect(selected).toBe(chooseRetryBeat(...args))
    expect(selected).toBeGreaterThanOrEqual(0)
    expect(selected).toBeLessThan(3)
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
      hello: { displayName: 'Player', isGuest: false, protocolVersion: 3 },
      ready: { instanceId: 'instance', serverTime: 1_777_000_000_000, theme: 'food', themeLabel: 'Kitchen Capers' },
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
      roundStart: { roundId: '1', charadeId: 'ghost-1' },
      roundGuess: { roundId: '1', charadeId: 'ghost-1', answerIndex: 1, requestId: 'round-1', spotlight: true },
      roundWinner: { roundId: '1', charadeId: 'ghost-1', address: maximalLook.address, name: maximalLook.name },
      react: { kind: 'genius' },
      error: { code: 'storage-unavailable' }
    }
    const encodedSizes = new Map<keyof typeof Messages, number>()

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
