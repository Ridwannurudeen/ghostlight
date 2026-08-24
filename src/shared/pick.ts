import type { ThemeId } from './config'
import { CATEGORIES, DECK, EMOTE_VOCABULARY, HOUSE_CHARADE, HOUSE_CHARADES, type Emote, type Phrase } from './deck'
import type { Charade } from './types'

export type Seed = string | number

function hashSeed(seed: Seed) {
  const input = `${typeof seed}:${seed}`
  let hash = 2166136261

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function seededRandom(seed: Seed) {
  let state = hashSeed(seed)

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffleSeeded<T>(items: readonly T[], seed: Seed): T[] {
  const shuffled = [...items]
  const random = seededRandom(seed)

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const current = shuffled[index]
    shuffled[index] = shuffled[swapIndex]
    shuffled[swapIndex] = current
  }

  return shuffled
}

export function chooseCharadeFor(
  address: string,
  seen: readonly string[],
  pool: readonly Charade[],
  lastAuthor = '',
  preferredTheme?: ThemeId
): Charade | null {
  const playerAddress = address.toLowerCase()
  const previousAuthor = lastAuthor.toLowerCase()
  const seenIds = new Set(seen)
  const eligible = pool.filter(
    (charade) =>
      !charade.isHouse &&
      charade.author.address.toLowerCase() !== playerAddress &&
      charade.author.address.toLowerCase() !== previousAuthor &&
      !seenIds.has(charade.id)
  )

  eligible.sort((left, right) => {
    const leftPreferred = preferredTheme && phraseTheme(left.phraseId) === preferredTheme ? 0 : 1
    const rightPreferred = preferredTheme && phraseTheme(right.phraseId) === preferredTheme ? 0 : 1
    return (
      leftPreferred - rightPreferred ||
      left.guesses.total - right.guesses.total ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id)
    )
  })

  return eligible[0] ?? null
}

export function chooseHouseCharade(seed: Seed, preferredTheme?: ThemeId): Charade {
  const eligible = preferredTheme
    ? HOUSE_CHARADES.filter((charade) => phraseTheme(charade.phraseId) === preferredTheme)
    : HOUSE_CHARADES

  return shuffleSeeded(eligible, seed)[0] ?? HOUSE_CHARADE
}

export function phraseTheme(phraseId: string): ThemeId | null {
  return DECK.find((phrase) => phrase.id === phraseId)?.theme ?? null
}

function firstWord(text: string) {
  return text.trim().split(/\s+/u)[0].toLowerCase()
}

export function pickDecoys(phraseId: string, deck: readonly Phrase[], seed: Seed): Phrase[] {
  const phrase = deck.find((candidate) => candidate.id === phraseId)
  if (!phrase) return []

  const usedFirstWords = new Set([firstWord(phrase.text)])
  const candidates = shuffleSeeded(
    deck.filter((candidate) => candidate.id !== phrase.id && candidate.category === phrase.category),
    seed
  )
  const decoys: Phrase[] = []

  for (const candidate of candidates) {
    const candidateFirstWord = firstWord(candidate.text)
    if (usedFirstWords.has(candidateFirstWord)) continue
    decoys.push(candidate)
    usedFirstWords.add(candidateFirstWord)
    if (decoys.length === 2) break
  }

  return decoys
}

export function dealPhrase(deck: readonly Phrase[], exclude: readonly string[], seed: Seed): Phrase | null {
  const excludedIds = new Set(exclude)
  const available = deck.filter((phrase) => !excludedIds.has(phrase.id))
  if (available.length === 0) return null

  const categories = CATEGORIES.filter((category) => available.some((phrase) => phrase.category === category))
  const random = seededRandom(seed)
  const category = categories[Math.floor(random() * categories.length)]
  const phrases = available.filter((phrase) => phrase.category === category)

  return phrases[Math.floor(random() * phrases.length)] ?? null
}

export function offerEmotes(phrase: Phrase, seed: Seed): Emote[] {
  const suggested = new Set<Emote>(phrase.suggested)
  const extras = shuffleSeeded(
    EMOTE_VOCABULARY.filter((emote) => !suggested.has(emote)),
    `${typeof seed}:${seed}:extras`
  ).slice(0, 2)

  return shuffleSeeded([...phrase.suggested, ...extras], `${typeof seed}:${seed}:offer`)
}
