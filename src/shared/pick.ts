import type { ThemeId } from './config'
import {
  authorBeatChoices,
  CATEGORIES,
  DECK,
  HOUSE_CHARADE,
  HOUSE_CHARADES,
  isAllowedPerformance,
  performanceMatchCount,
  PLAYABLE_DECK,
  playablePhrase,
  type Emote,
  type Phrase
} from './deck'
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

export function chooseHouseCharade(seed: Seed, preferredTheme?: ThemeId): Charade
export function chooseHouseCharade(
  seed: Seed,
  preferredTheme: ThemeId | undefined,
  allowedPhraseIds: ReadonlySet<string>
): Charade | null
export function chooseHouseCharade(
  seed: Seed,
  preferredTheme?: ThemeId,
  allowedPhraseIds?: ReadonlySet<string>
): Charade | null {
  const allowed = allowedPhraseIds
    ? HOUSE_CHARADES.filter((charade) => allowedPhraseIds.has(charade.phraseId))
    : HOUSE_CHARADES
  const themed = preferredTheme ? allowed.filter((charade) => phraseTheme(charade.phraseId) === preferredTheme) : []
  const eligible = themed.length > 0 ? themed : allowed

  return shuffleSeeded(eligible, seed)[0] ?? (allowedPhraseIds ? null : HOUSE_CHARADE)
}

export function phraseTheme(phraseId: string): ThemeId | null {
  return DECK.find((phrase) => phrase.id === phraseId)?.theme ?? null
}

function firstWord(text: string) {
  return text.trim().split(/\s+/u)[0].toLowerCase()
}

export function pickDecoys(
  phraseId: string,
  performedEmotes: readonly string[],
  deck: readonly Phrase[],
  seed: Seed
): Phrase[] {
  const phrase = playablePhrase(phraseId)
  if (!phrase || !deck.some((candidate) => candidate.id === phrase.id) || !isAllowedPerformance(phrase, performedEmotes)) {
    return []
  }

  const sourceFirstWord = firstWord(phrase.text)
  const candidates = shuffleSeeded(
    deck.filter(
      (candidate) =>
        candidate.id !== phrase.id &&
        candidate.category === phrase.category &&
        firstWord(candidate.text) !== sourceFirstWord &&
        playablePhrase(candidate) !== null &&
        performanceMatchCount(candidate, performedEmotes) <= 1
    ),
    `${typeof seed}:${seed}:decoys`
  ).map((candidate) => ({
    phrase: candidate,
    firstWord: firstWord(candidate.text),
    matches: performanceMatchCount(candidate, performedEmotes)
  }))
  let best: { close: Phrase; distant: Phrase; closeMatches: number; distantMatches: number } | null = null

  for (const close of candidates) {
    for (const distant of candidates) {
      if (distant.phrase.id === close.phrase.id || distant.firstWord === close.firstWord) {
        continue
      }
      if (
        !best ||
        close.matches > best.closeMatches ||
        (close.matches === best.closeMatches && distant.matches < best.distantMatches)
      ) {
        best = {
          close: close.phrase,
          distant: distant.phrase,
          closeMatches: close.matches,
          distantMatches: distant.matches
        }
      }
    }
  }

  return best ? [best.close, best.distant] : []
}

export function chooseRetryBeat(
  performedEmotes: readonly string[],
  answerIds: readonly string[],
  removedAnswerIndex: number,
  seed: Seed,
  deck: readonly Phrase[] = PLAYABLE_DECK
) {
  const remaining = answerIds.filter((_answerId, index) => index !== removedAnswerIndex)
  const ranked = performedEmotes.map((emote, index) => {
    const frequency = remaining.reduce((count, answerId) => {
      const phrase = deck.find((candidate) => candidate.id === answerId)
      return count + (phrase && authorBeatChoices(phrase, index).includes(emote as Emote) ? 1 : 0)
    }, 0)
    return { index, rank: frequency === 1 ? 0 : frequency === 0 ? 1 : 2 }
  })
  const bestRank = Math.min(...ranked.map((candidate) => candidate.rank))
  const candidates = ranked.filter((candidate) => candidate.rank === bestRank).map((candidate) => candidate.index)
  return shuffleSeeded(candidates, seed)[0] ?? 0
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
