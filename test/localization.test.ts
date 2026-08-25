import { describe, expect, it } from 'vitest'
import { THEMES, TITLES } from '../src/shared/config'
import { CATEGORIES, DECK, EMOTE_VOCABULARY, HOUSE_CHARADES } from '../src/shared/deck'
import {
  COPY,
  LANGUAGES,
  PHRASE_TEXTS,
  emoteLabel,
  errorLabel,
  localizeDeck,
  localizePhrase,
  isolatePlayerText,
  normalizeLanguage,
  normalizePlayerName,
  phraseById,
  phraseText,
  requirementLabel,
  themeLabel,
  titleLabel,
  translate
} from '../src/shared/i18n'
import { pickDecoys, shuffleSeeded } from '../src/shared/pick'

const REQUIREMENTS = [
  'Post your first charade',
  '10 correct decodes or 5 posts',
  '3 daily stamps and 25 correct decodes',
  'All titles unlocked'
] as const

const GUIDANCE_KEYS = [
  'howToPlay.title',
  'howToPlay.walk',
  'howToPlay.watch',
  'howToPlay.guess',
  'howToPlay.leave',
  'howToPlay.realPlayers',
  'hint.foyerFar',
  'hint.foyerStage',
  'hint.decode',
  'hint.reveal',
  'author.chooseThree',
  'hint.authorReady',
  'hint.posted'
] as const

const ERROR_CODES = [
  'already-guessed',
  'charade-not-served',
  'invalid-charade',
  'invalid-guess',
  'invalid-next-charade',
  'invalid-post',
  'invalid-reaction',
  'invalid-reply',
  'look-not-ready',
  'mail-guest',
  'mail-recipient-invalid',
  'mail-recipient-unknown',
  'post-guest',
  'post-rate-limited',
  'protocol-required',
  'protocol-version',
  'reaction-rate-limited',
  'reaction-guest',
  'reply-not-eligible',
  'reply-taken',
  'storage-unavailable',
  'server-busy',
  'deck_exhausted',
  'invalid_reply_phrase',
  'player_look_unavailable',
  'reaction_failed',
  'copy_failed',
  'request_timeout'
] as const

describe('localization copy', () => {
  it('has the same complete, non-empty player-copy key set in every language', () => {
    const expectedKeys = Object.keys(COPY.en).sort()
    expect(expectedKeys).toHaveLength(183)

    for (const language of LANGUAGES) {
      expect(Object.keys(COPY[language]).sort(), language).toEqual(expectedKeys)
      for (const [key, value] of Object.entries(COPY[language])) {
        expect(value.trim().length, `${language}:${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('localizes every how-to-play and contextual guidance line outside English', () => {
    for (const key of GUIDANCE_KEYS) {
      expect(COPY.es[key], `es:${key}`).not.toBe(COPY.en[key])
      expect(COPY.pt[key], `pt:${key}`).not.toBe(COPY.en[key])
    }
  })

  it('localizes themes, titles, requirements, emotes, known errors, and invite interpolation', () => {
    for (const language of LANGUAGES) {
      for (const theme of THEMES) expect(themeLabel(theme.id, language).trim(), `${language}:${theme.id}`).not.toBe('')
      for (const title of TITLES) expect(titleLabel(title, language).trim(), `${language}:${title}`).not.toBe('')
      for (const requirement of REQUIREMENTS) {
        expect(requirementLabel(requirement, language).trim(), `${language}:${requirement}`).not.toBe('')
      }
      for (const emote of EMOTE_VOCABULARY) {
        expect(emoteLabel(emote, language).trim(), `${language}:${emote}`).not.toBe('')
      }
      for (const code of ERROR_CODES) expect(errorLabel(code, language).trim(), `${language}:${code}`).not.toBe('')

      expect(translate('invite.message', language, { url: 'https://example.test' })).toContain('https://example.test')
      expect(errorLabel('not-a-real-code', language)).toBe(translate('error.unknown', language))
    }
  })

  it('normalizes supported locale forms and defaults unknown or absent locales to English', () => {
    expect(normalizeLanguage('es-MX')).toBe('es')
    expect(normalizeLanguage('pt_BR')).toBe('pt')
    expect(normalizeLanguage('EN-gb')).toBe('en')
    expect(normalizeLanguage('fr-FR')).toBe('en')
    expect(normalizeLanguage(null)).toBe('en')
  })

  it('normalizes player names without permitting system-label or bidi-control spoofing', () => {
    expect(normalizePlayerName('  Alice\t  Example  ')).toBe('Alice Example')
    expect(normalizePlayerName('بيت الأشباح')).toBe('بيت الأشباح')
    expect(normalizePlayerName('HOUSE\u202e GHOST\u202c')).toBe('PLAYER')
    expect(normalizePlayerName('HOUSE\u200b GHOST')).toBe('PLAYER')
    expect(normalizePlayerName('Al\u200bice\u2060')).toBe('Alice')
    expect(normalizePlayerName('Visitor')).toBe('PLAYER')
    expect(normalizePlayerName('Guest')).toBe('PLAYER')
    expect(normalizePlayerName('House')).toBe('PLAYER')
    expect(normalizePlayerName('ＧＨＯＳＴＬＩＧＨＴ')).toBe('PLAYER')
    expect(normalizePlayerName('😀'.repeat(20))).toBe('😀'.repeat(8))
    expect(isolatePlayerText('بيت الأشباح')).toBe('\u2068بيت الأشباح\u2069')
  })

  it('falls back safely for runtime copy and title values outside their compile-time unions', () => {
    expect(translate('not-a-copy-key' as never, 'en')).toBe(COPY.en['error.unknown'])
    expect(titleLabel('HOUSE GHOST' as never, 'en')).toBe(COPY.en['title.none'])
  })
})

describe('localized phrase deck', () => {
  it('resolves every canonical phrase id to non-empty text in all three languages', () => {
    const expectedIds = DECK.map((phrase) => phrase.id).sort()
    expect(expectedIds).toHaveLength(120)

    for (const language of LANGUAGES) {
      expect(Object.keys(PHRASE_TEXTS[language]).sort(), language).toEqual(expectedIds)
      for (const phrase of DECK) {
        expect(phraseText(phrase.id, language)?.trim().length, `${language}:${phrase.id}`).toBeGreaterThan(0)
        expect(phraseById(phrase.id, language)?.id, `${language}:${phrase.id}`).toBe(phrase.id)
        expect(localizePhrase(phrase, language).text, `${language}:${phrase.id}`).toBe(phraseText(phrase.id, language))
      }
    }

    expect(phraseText('not-a-phrase', 'es')).toBeNull()
    expect(phraseById('not-a-phrase', 'pt')).toBeNull()
  })

  it('preserves ids, emote suggestions, categories, themes, and house phrase mappings in every language', () => {
    for (const language of LANGUAGES) {
      const localized = localizeDeck(language)
      expect(localized).toHaveLength(DECK.length)

      for (const category of CATEGORIES) {
        expect(
          localized.filter((phrase) => phrase.category === category),
          `${language}:${category}`
        ).toHaveLength(20)
        expect(
          localized.filter((phrase) => phrase.theme === category),
          `${language}:${category}:theme`
        ).toHaveLength(20)
      }

      for (const canonical of DECK) {
        const phrase = localized.find((candidate) => candidate.id === canonical.id)
        expect(phrase, `${language}:${canonical.id}`).toMatchObject({
          id: canonical.id,
          category: canonical.category,
          theme: canonical.theme,
          suggested: canonical.suggested
        })
      }

      for (const house of HOUSE_CHARADES) {
        expect(phraseText(house.phraseId, language)?.trim().length, `${language}:${house.id}`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps every localized decoy in the canonical phrase category and theme', () => {
    for (const language of LANGUAGES) {
      const localized = localizeDeck(language)
      for (const phrase of localized) {
        const decoys = pickDecoys(phrase.id, localized, `localized:${language}:${phrase.id}`)
        expect(decoys, `${language}:${phrase.id}`).toHaveLength(2)
        expect(
          decoys.every(
            (decoy) => decoy.id !== phrase.id && decoy.category === phrase.category && decoy.theme === phrase.theme
          ),
          `${language}:${phrase.id}`
        ).toBe(true)
      }
    }
  })

  it('round-trips an authored phrase id and same-theme answer ids across every language pair', () => {
    for (const canonical of DECK) {
      const decoyIds = pickDecoys(canonical.id, DECK, `round-trip:${canonical.id}`).map((phrase) => phrase.id)
      const answerIds = shuffleSeeded([canonical.id, ...decoyIds], `answers:${canonical.id}`)

      for (const authorLanguage of LANGUAGES) {
        const authored = phraseById(canonical.id, authorLanguage)
        expect(authored?.id, `${authorLanguage}:${canonical.id}:author`).toBe(canonical.id)

        for (const decoderLanguage of LANGUAGES) {
          const answers = answerIds.map((id) => phraseById(id, decoderLanguage))
          expect(
            answers.every((answer) => answer !== null),
            `${decoderLanguage}:${canonical.id}:answers`
          ).toBe(true)
          expect(answers.every((answer) => answer?.category === canonical.category)).toBe(true)
          expect(answers.every((answer) => answer?.theme === canonical.theme)).toBe(true)

          const selectedId = answers.find((answer) => answer?.id === authored?.id)?.id
          expect(selectedId, `${authorLanguage}:${decoderLanguage}:${canonical.id}`).toBe(canonical.id)
        }
      }
    }
  })
})
