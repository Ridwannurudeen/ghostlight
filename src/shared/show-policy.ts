import { themeForTimestamp, type ThemeId } from './config'
import { DECK, HOUSE_CHARADES, type PhraseId } from './deck'
import { SEASON_ZERO_DECOY_APPROVAL_RECORD, SEASON_ZERO_MODERATION_RECORD } from './season-zero-moderation'
import {
  evaluateSeasonModerationRecord,
  parseSeasonModerationRecord,
  SEASON_ZERO_WEEKS,
  seasonReferenceKey,
  seasonWeekForTimestamp,
  type SeasonModerationRecord,
  type SeasonWeekId
} from './seasons'

type LegacyTheme = Readonly<{
  id: ThemeId
  label: string
}>

type SeasonMetadata = Readonly<{
  id: 'season-zero'
  weekId: SeasonWeekId
  startsAt: number
  endsAt: number
  titleId: string
  propId: string
  finale: Readonly<{
    id: string
    startsAt: number
    endsAt: number
  }>
}>

type PolicyContent = Readonly<{
  showKey: string
  legacyTheme: LegacyTheme
  primaryPhraseIds: readonly PhraseId[]
  decoyPhraseIds: readonly PhraseId[]
  housePhraseIds: readonly PhraseId[]
}>

export type DailyShowPolicy = PolicyContent &
  Readonly<{
    kind: 'daily'
  }>

export type SeasonZeroShowPolicy = PolicyContent &
  Readonly<{
    kind: 'season-zero'
    season: SeasonMetadata
  }>

export type ShowPolicy = DailyShowPolicy | SeasonZeroShowPolicy

const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000
const ALL_PHRASE_IDS = Object.freeze(DECK.map((phrase) => phrase.id as PhraseId))
const ALL_HOUSE_PHRASE_IDS = Object.freeze(HOUSE_CHARADES.map((charade) => charade.phraseId as PhraseId))

function validTimestamp(timestamp: number) {
  return Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= MAX_DATE_TIMESTAMP
}

function legacyTheme(timestamp: number): LegacyTheme {
  const theme = themeForTimestamp(timestamp)
  return Object.freeze({ id: theme.id, label: theme.label })
}

function dailyPolicy(timestamp: number): DailyShowPolicy {
  return Object.freeze({
    kind: 'daily',
    showKey: `daily:${new Date(timestamp).toISOString().split('T')[0]}`,
    legacyTheme: legacyTheme(timestamp),
    primaryPhraseIds: ALL_PHRASE_IDS,
    decoyPhraseIds: ALL_PHRASE_IDS,
    housePhraseIds: ALL_HOUSE_PHRASE_IDS
  })
}

export function showPolicyForTimestamp(
  timestamp: number,
  record: SeasonModerationRecord = SEASON_ZERO_MODERATION_RECORD
): ShowPolicy | null {
  if (!validTimestamp(timestamp)) return null
  const week = seasonWeekForTimestamp(timestamp)
  if (!week) return dailyPolicy(timestamp)

  const strictRecord = parseSeasonModerationRecord(record)
  if (!strictRecord) return null
  const evaluation = evaluateSeasonModerationRecord(strictRecord)
  if (!evaluation.launchReady) return null

  const primaryPhraseIds = Object.freeze(
    week.references
      .filter((reference) => strictRecord.decisions[seasonReferenceKey(week.id, reference.phraseId)] === 'approved')
      .map((reference) => reference.phraseId)
  )
  const approvedPhraseIds = new Set<PhraseId>()
  for (const seasonWeek of SEASON_ZERO_WEEKS) {
    for (const reference of seasonWeek.references) {
      if (strictRecord.decisions[seasonReferenceKey(seasonWeek.id, reference.phraseId)] === 'approved') {
        approvedPhraseIds.add(reference.phraseId)
      }
    }
  }
  for (const phraseId of SEASON_ZERO_DECOY_APPROVAL_RECORD.phraseIds) approvedPhraseIds.add(phraseId)
  const housePhraseIds = evaluation.houseFallbackCoverage.find(
    (coverage) => coverage.weekId === week.id
  )!.approvedPhraseIds
  const season = Object.freeze({
    id: 'season-zero' as const,
    weekId: week.id,
    startsAt: week.eligibility.startsAt,
    endsAt: week.eligibility.endsAt,
    titleId: week.title.id,
    propId: week.prop.id,
    finale: Object.freeze({
      id: week.finale.id,
      startsAt: week.finale.window.startsAt,
      endsAt: week.finale.window.endsAt
    })
  })
  return Object.freeze({
    kind: 'season-zero',
    showKey: `season-zero:${week.id}`,
    legacyTheme: legacyTheme(timestamp),
    primaryPhraseIds,
    decoyPhraseIds: Object.freeze([...approvedPhraseIds]),
    housePhraseIds,
    season
  })
}
