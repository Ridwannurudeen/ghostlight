import { describe, expect, it } from 'vitest'
import { THEMES, themeForTimestamp } from '../src/shared/config'
import { CATEGORIES, DECK, EMOTE_VOCABULARY, HOUSE_CHARADE, type Category, type Phrase } from '../src/shared/deck'
import { chooseCharadeFor, dealPhrase, offerEmotes, pickDecoys, shuffleSeeded } from '../src/shared/pick'
import { STORAGE_SCHEMA_VERSION, type Charade, type Look } from '../src/shared/types'

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

  it('keeps the single labelled house charade outside the player deck', () => {
    expect(HOUSE_CHARADE.isHouse).toBe(true)
    expect(HOUSE_CHARADE.author.name).toBe('House')
    expect(DECK.some((phrase) => phrase.id === HOUSE_CHARADE.id)).toBe(false)
    expect(DECK.some((phrase) => phrase.id === HOUSE_CHARADE.phraseId)).toBe(true)
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

  it('never selects the house fallback from the player pool', () => {
    expect(chooseCharadeFor('player', [], [HOUSE_CHARADE])).toBeNull()
  })
})

describe('pickDecoys', () => {
  it('returns two stable same-category decoys with distinct first words', () => {
    const phrase = DECK[0]
    const first = pickDecoys(phrase.id, DECK, 'charade-7')
    const second = pickDecoys(phrase.id, DECK, 'charade-7')

    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    expect(first.every((candidate) => candidate.category === phrase.category)).toBe(true)
    expect(first.every((candidate) => candidate.id !== phrase.id)).toBe(true)
    expect(new Set([firstWord(phrase.text), ...first.map((candidate) => firstWord(candidate.text))]).size).toBe(3)
  })

  it('returns no decoys for an unknown phrase', () => {
    expect(pickDecoys('missing', DECK, 'seed')).toEqual([])
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

describe('offerEmotes', () => {
  it('returns the three suggestions plus two unique verified extras in a stable shuffle', () => {
    const phrase = DECK[0]
    const offered = offerEmotes(phrase, 'offer-seed')

    expect(offered).toEqual(offerEmotes(phrase, 'offer-seed'))
    expect(offered).toHaveLength(5)
    expect(new Set(offered).size).toBe(5)
    expect(phrase.suggested.every((emote) => offered.includes(emote))).toBe(true)
    expect(offered.every((emote) => EMOTE_VOCABULARY.includes(emote))).toBe(true)
  })
})
