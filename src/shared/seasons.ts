import { THEMES, WIRE_INT_MAX, themeForTimestamp } from './config'
import { HOUSE_CHARADES, PLAYABLE_DECK, type PhraseId } from './deck'
import type { Language } from './i18n'

export type LocalizedSeasonLabel = Readonly<Record<Language, string>>
export type SeasonWeekId = 'first-impressions' | 'main-character-energy' | 'fashionably-haunted' | 'final-encore'
export type SeasonModerationDecision = 'approved' | 'quarantined'
export type SeasonModerationDecisions = Readonly<Record<string, SeasonModerationDecision | undefined>>

export type SeasonModerationRecord = Readonly<{
  v: 1
  seasonId: 'season-zero'
  revision: number
  updatedAt: number
  decisions: Readonly<Record<string, SeasonModerationDecision>>
}>

export type SeasonReference = {
  phraseId: PhraseId
  curationStatus: 'curated'
}

export type SeasonWeek = {
  id: SeasonWeekId
  name: LocalizedSeasonLabel
  eligibility: {
    startsAt: number
    endsAt: number
  }
  references: readonly SeasonReference[]
  title: {
    id: string
    label: LocalizedSeasonLabel
    availability: 'planned'
  }
  prop: {
    id: string
    label: LocalizedSeasonLabel
    availability: 'planned'
  }
  finale: {
    id: string
    label: LocalizedSeasonLabel
    window: {
      startsAt: number
      endsAt: number
    }
  }
}

export type WeekModerationSummary = Readonly<{
  weekId: SeasonWeekId
  total: number
  approved: number
  quarantined: number
  pending: number
  quarantineRate: number | null
  reviewComplete: boolean
  promptRangeReady: boolean
}>

export type SeasonModerationSummary = Readonly<{
  total: number
  approved: number
  quarantined: number
  pending: number
  quarantineRate: number | null
  reviewComplete: boolean
  launchReady: boolean
  weeks: readonly WeekModerationSummary[]
}>

export type HouseFallbackCoverage = Readonly<{
  weekId: SeasonWeekId
  approvedPhraseIds: readonly PhraseId[]
  ready: boolean
}>

export type SeasonModerationEvaluation = Readonly<{
  moderation: SeasonModerationSummary
  houseFallbackCoverage: readonly HouseFallbackCoverage[]
  houseFallbackReady: boolean
  launchReady: boolean
}>

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const WEEK_MILLISECONDS = 7 * DAY_MILLISECONDS
const MAX_TIMESTAMP = 8_640_000_000_000_000

export const SEASON_ZERO_START_AT = Date.UTC(2026, 8, 13)
export const SEASON_ZERO_END_AT = SEASON_ZERO_START_AT + 4 * WEEK_MILLISECONDS

function curatedReferences(phraseIds: readonly PhraseId[]): readonly SeasonReference[] {
  return phraseIds.map((phraseId) => ({ phraseId, curationStatus: 'curated' }))
}

const SEASON_ZERO_PLAYABLE_PHRASE_IDS = PLAYABLE_DECK.map((phrase) => phrase.id as PhraseId)

function playableReferencesExcluding(excludedPhraseIds: readonly PhraseId[]): readonly SeasonReference[] {
  const excluded = new Set<PhraseId>(excludedPhraseIds)
  return curatedReferences(SEASON_ZERO_PLAYABLE_PHRASE_IDS.filter((phraseId) => !excluded.has(phraseId)))
}

export const SEASON_ZERO_WEEKS: readonly SeasonWeek[] = [
  {
    id: 'first-impressions',
    name: {
      en: 'First Impressions',
      es: 'Primeras impresiones',
      pt: 'Primeiras impressões'
    },
    eligibility: {
      startsAt: SEASON_ZERO_START_AT,
      endsAt: SEASON_ZERO_START_AT + WEEK_MILLISECONDS
    },
    references: playableReferencesExcluding(['feelings-fight-boredom', 'food-crack-a-coconut']),
    title: {
      id: 'fresh-face',
      label: { en: 'Fresh Face', es: 'Cara nueva', pt: 'Cara nova' },
      availability: 'planned'
    },
    prop: {
      id: 'calling-card',
      label: { en: 'Calling Card', es: 'Tarjeta de presentación', pt: 'Cartão de apresentação' },
      availability: 'planned'
    },
    finale: {
      id: 'opening-call',
      label: { en: 'Opening Call', es: 'Primera llamada', pt: 'Primeira chamada' },
      window: { startsAt: SEASON_ZERO_START_AT, endsAt: SEASON_ZERO_START_AT + DAY_MILLISECONDS }
    }
  },
  {
    id: 'main-character-energy',
    name: {
      en: 'Main Character Energy',
      es: 'Energía de protagonista',
      pt: 'Energia de protagonista'
    },
    eligibility: {
      startsAt: SEASON_ZERO_START_AT + WEEK_MILLISECONDS,
      endsAt: SEASON_ZERO_START_AT + 2 * WEEK_MILLISECONDS
    },
    references: playableReferencesExcluding(['everyday-dodge-the-rain', 'food-eat-spicy-noodles']),
    title: {
      id: 'scene-magnet',
      label: { en: 'Scene Magnet', es: 'Imán de escena', pt: 'Ímã de cena' },
      availability: 'planned'
    },
    prop: {
      id: 'star-marker',
      label: { en: 'Star Marker', es: 'Marca de estrella', pt: 'Marca de estrela' },
      availability: 'planned'
    },
    finale: {
      id: 'spotlight-showdown',
      label: { en: 'Spotlight Showdown', es: 'Duelo bajo el foco', pt: 'Duelo sob os holofotes' },
      window: {
        startsAt: SEASON_ZERO_START_AT + WEEK_MILLISECONDS,
        endsAt: SEASON_ZERO_START_AT + WEEK_MILLISECONDS + DAY_MILLISECONDS
      }
    }
  },
  {
    id: 'fashionably-haunted',
    name: {
      en: 'Fashionably Haunted',
      es: 'Elegantemente encantado',
      pt: 'Elegantemente assombrado'
    },
    eligibility: {
      startsAt: SEASON_ZERO_START_AT + 2 * WEEK_MILLISECONDS,
      endsAt: SEASON_ZERO_START_AT + 3 * WEEK_MILLISECONDS
    },
    references: playableReferencesExcluding(['dcl-life-dance-at-the-plaza', 'pop-become-a-superhero']),
    title: {
      id: 'phantom-icon',
      label: { en: 'Phantom Icon', es: 'Icono fantasma', pt: 'Ícone fantasma' },
      availability: 'planned'
    },
    prop: {
      id: 'spectral-boutonniere',
      label: { en: 'Spectral Boutonniere', es: 'Prendedor espectral', pt: 'Broche espectral' },
      availability: 'planned'
    },
    finale: {
      id: 'haunted-runway',
      label: { en: 'Haunted Runway', es: 'Pasarela encantada', pt: 'Passarela assombrada' },
      window: {
        startsAt: SEASON_ZERO_START_AT + 2 * WEEK_MILLISECONDS,
        endsAt: SEASON_ZERO_START_AT + 2 * WEEK_MILLISECONDS + DAY_MILLISECONDS
      }
    }
  },
  {
    id: 'final-encore',
    name: {
      en: 'Final Encore',
      es: 'Bis final',
      pt: 'Bis final'
    },
    eligibility: {
      startsAt: SEASON_ZERO_START_AT + 3 * WEEK_MILLISECONDS,
      endsAt: SEASON_ZERO_END_AT
    },
    references: playableReferencesExcluding(['feelings-celebrate-a-win', 'awkward-wave-at-wrong-person']),
    title: {
      id: 'encore-legend',
      label: { en: 'Encore Legend', es: 'Leyenda del bis', pt: 'Lenda do bis' },
      availability: 'planned'
    },
    prop: {
      id: 'finale-playbill',
      label: { en: 'Finale Playbill', es: 'Programa de la final', pt: 'Programa da final' },
      availability: 'planned'
    },
    finale: {
      id: 'season-zero-curtain-call',
      label: { en: 'Season Zero Curtain Call', es: 'Despedida de la Temporada Cero', pt: 'Despedida da Temporada Zero' },
      window: {
        startsAt: SEASON_ZERO_START_AT + 3 * WEEK_MILLISECONDS,
        endsAt: SEASON_ZERO_START_AT + 3 * WEEK_MILLISECONDS + DAY_MILLISECONDS
      }
    }
  }
]

const MODERATION_RECORD_KEYS = new Set(['v', 'seasonId', 'revision', 'updatedAt', 'decisions'])
const KNOWN_SEASON_REFERENCE_KEYS = new Set(
  SEASON_ZERO_WEEKS.flatMap((week) =>
    week.references.map((reference) => seasonReferenceKey(week.id, reference.phraseId))
  )
)
const HOUSE_PHRASE_IDS = new Set(HOUSE_CHARADES.map((charade) => charade.phraseId))

export function localizedSeasonLabel(label: LocalizedSeasonLabel, language: Language): string {
  return label[language]
}

function isValidTimestamp(timestamp: number): boolean {
  return Number.isSafeInteger(timestamp) && timestamp >= 0
}

export function seasonWeekForTimestamp(timestamp: number): SeasonWeek | null {
  if (!isValidTimestamp(timestamp)) return null
  if (timestamp < SEASON_ZERO_START_AT || timestamp >= SEASON_ZERO_END_AT) return null
  return SEASON_ZERO_WEEKS[Math.floor((timestamp - SEASON_ZERO_START_AT) / WEEK_MILLISECONDS)] ?? null
}

export function seasonReferenceKey(weekId: SeasonWeekId, phraseId: PhraseId): string {
  return `${weekId}:${phraseId}`
}

export function isFinaleTimestamp(week: SeasonWeek, timestamp: number): boolean {
  if (!isValidTimestamp(timestamp)) return false
  return timestamp >= week.finale.window.startsAt && timestamp < week.finale.window.endsAt
}

export function eligibleSeasonPhraseIds(
  week: SeasonWeek,
  timestamp: number,
  decisions: SeasonModerationDecisions
): PhraseId[] {
  if (!isValidTimestamp(timestamp)) return []
  if (timestamp < week.eligibility.startsAt || timestamp >= week.eligibility.endsAt) return []
  return week.references
    .filter((reference) => decisions[seasonReferenceKey(week.id, reference.phraseId)] === 'approved')
    .map((reference) => reference.phraseId)
}

export function weekModerationSummary(
  week: SeasonWeek,
  decisions: SeasonModerationDecisions
): WeekModerationSummary {
  const approved = week.references.filter(
    (reference) => decisions[seasonReferenceKey(week.id, reference.phraseId)] === 'approved'
  ).length
  const quarantined = week.references.filter(
    (reference) => decisions[seasonReferenceKey(week.id, reference.phraseId)] === 'quarantined'
  ).length
  const total = week.references.length
  const pending = total - approved - quarantined
  return Object.freeze({
    weekId: week.id,
    total,
    approved,
    quarantined,
    pending,
    quarantineRate: pending === 0 ? quarantined / total : null,
    reviewComplete: pending === 0,
    promptRangeReady: approved >= 24 && approved <= 30
  })
}

export function seasonModerationSummary(decisions: SeasonModerationDecisions): SeasonModerationSummary {
  const weeks = Object.freeze(SEASON_ZERO_WEEKS.map((week) => weekModerationSummary(week, decisions)))
  const total = weeks.reduce((sum, week) => sum + week.total, 0)
  const approved = weeks.reduce((sum, week) => sum + week.approved, 0)
  const quarantined = weeks.reduce((sum, week) => sum + week.quarantined, 0)
  const pending = weeks.reduce((sum, week) => sum + week.pending, 0)
  const reviewComplete = pending === 0
  const quarantineRate = reviewComplete ? quarantined / total : null
  return Object.freeze({
    total,
    approved,
    quarantined,
    pending,
    quarantineRate,
    reviewComplete,
    launchReady:
      reviewComplete && weeks.every((week) => week.promptRangeReady) && quarantineRate !== null && quarantineRate < 0.02,
    weeks
  })
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null
}

function ownEnumerableDataValue(record: Record<string, unknown>, key: string): { value: unknown } | null {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { value: descriptor.value }
    : null
}

export function parseSeasonModerationRecord(value: unknown): SeasonModerationRecord | null {
  const input = asPlainRecord(value)
  if (!input) return null
  const keys = Reflect.ownKeys(input)
  if (
    keys.length !== MODERATION_RECORD_KEYS.size ||
    keys.some((key) => typeof key !== 'string' || !MODERATION_RECORD_KEYS.has(key))
  ) {
    return null
  }
  const version = ownEnumerableDataValue(input, 'v')
  const seasonId = ownEnumerableDataValue(input, 'seasonId')
  const revision = ownEnumerableDataValue(input, 'revision')
  const updatedAt = ownEnumerableDataValue(input, 'updatedAt')
  const decisions = ownEnumerableDataValue(input, 'decisions')
  if (!version || !seasonId || !revision || !updatedAt || !decisions) return null
  if (version.value !== 1 || seasonId.value !== 'season-zero') return null
  if (
    typeof revision.value !== 'number' ||
    !isValidTimestamp(revision.value) ||
    revision.value > WIRE_INT_MAX
  ) {
    return null
  }
  if (
    typeof updatedAt.value !== 'number' ||
    !isValidTimestamp(updatedAt.value) ||
    updatedAt.value > MAX_TIMESTAMP
  ) {
    return null
  }

  const inputDecisions = asPlainRecord(decisions.value)
  if (!inputDecisions) return null
  const decisionKeys = Reflect.ownKeys(inputDecisions)
  if (decisionKeys.length > KNOWN_SEASON_REFERENCE_KEYS.size) return null
  if (decisionKeys.some((key) => typeof key !== 'string' || !KNOWN_SEASON_REFERENCE_KEYS.has(key))) return null

  const normalizedDecisions: Record<string, SeasonModerationDecision> = {}
  for (const key of (decisionKeys as string[]).sort()) {
    const decision = ownEnumerableDataValue(inputDecisions, key)
    if (!decision || (decision.value !== 'approved' && decision.value !== 'quarantined')) return null
    normalizedDecisions[key] = decision.value
  }

  return Object.freeze({
    v: 1,
    seasonId: 'season-zero',
    revision: revision.value,
    updatedAt: updatedAt.value,
    decisions: Object.freeze(normalizedDecisions)
  })
}

export function evaluateSeasonModerationRecord(record: SeasonModerationRecord): SeasonModerationEvaluation {
  const moderation = seasonModerationSummary(record.decisions)
  const houseFallbackCoverage = Object.freeze(
    SEASON_ZERO_WEEKS.map((week) => {
      const approvedPhraseIds = Object.freeze(
        week.references
          .filter(
            (reference) =>
              HOUSE_PHRASE_IDS.has(reference.phraseId) &&
              record.decisions[seasonReferenceKey(week.id, reference.phraseId)] === 'approved'
          )
          .map((reference) => reference.phraseId)
      )
      return Object.freeze({
        weekId: week.id,
        approvedPhraseIds,
        ready: approvedPhraseIds.length > 0
      })
    })
  )
  const houseFallbackReady = houseFallbackCoverage.every((week) => week.ready)
  return Object.freeze({
    moderation,
    houseFallbackCoverage,
    houseFallbackReady,
    launchReady: moderation.launchReady && houseFallbackReady
  })
}

export function showForTimestamp(timestamp: number):
  | { kind: 'season'; week: SeasonWeek }
  | { kind: 'daily-theme'; theme: (typeof THEMES)[number] }
  | null {
  if (!isValidTimestamp(timestamp)) return null
  const week = seasonWeekForTimestamp(timestamp)
  return week ? { kind: 'season', week } : { kind: 'daily-theme', theme: themeForTimestamp(timestamp) }
}
