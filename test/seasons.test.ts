import { describe, expect, it } from 'vitest'
import { THEMES, themeForTimestamp } from '../src/shared/config'
import { DECK } from '../src/shared/deck'
import {
  SEASON_ZERO_END_AT,
  SEASON_ZERO_START_AT,
  SEASON_ZERO_WEEKS,
  eligibleSeasonPhraseIds,
  isFinaleTimestamp,
  localizedSeasonLabel,
  seasonModerationSummary,
  seasonReferenceKey,
  seasonWeekForTimestamp,
  showForTimestamp,
  weekModerationSummary,
  type SeasonModerationDecisions
} from '../src/shared/seasons'

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const WEEK_MILLISECONDS = 7 * DAY_MILLISECONDS

function decisionsForEveryReference(decision: 'approved' | 'quarantined'): SeasonModerationDecisions {
  return Object.fromEntries(
    SEASON_ZERO_WEEKS.flatMap((week) =>
      week.references.map((reference) => [seasonReferenceKey(week.id, reference.phraseId), decision])
    )
  )
}

describe('Season Zero schedule', () => {
  it('defines the four roadmap themes as contiguous UTC weeks from September 13, 2026', () => {
    expect(SEASON_ZERO_START_AT).toBe(Date.UTC(2026, 8, 13))
    expect(SEASON_ZERO_END_AT).toBe(SEASON_ZERO_START_AT + 4 * WEEK_MILLISECONDS)
    expect(SEASON_ZERO_WEEKS.map((week) => week.id)).toEqual([
      'first-impressions',
      'main-character-energy',
      'fashionably-haunted',
      'final-encore'
    ])

    for (const [index, week] of SEASON_ZERO_WEEKS.entries()) {
      expect(week.eligibility.startsAt).toBe(SEASON_ZERO_START_AT + index * WEEK_MILLISECONDS)
      expect(week.eligibility.endsAt).toBe(week.eligibility.startsAt + WEEK_MILLISECONDS)
    }
  })

  it('uses 30 unique canonical curated candidates per week', () => {
    const canonicalIds = new Set(DECK.map((phrase) => phrase.id))

    for (const week of SEASON_ZERO_WEEKS) {
      const phraseIds = week.references.map((reference) => reference.phraseId)
      expect(phraseIds).toHaveLength(30)
      expect(new Set(phraseIds).size, week.id).toBe(phraseIds.length)
      expect(phraseIds.every((phraseId) => canonicalIds.has(phraseId)), week.id).toBe(true)
      expect(week.references.every((reference) => reference.curationStatus === 'curated'), week.id).toBe(true)
    }
  })

  it('keeps season rewards explicitly planned and does not present unshipped assets as available', () => {
    for (const week of SEASON_ZERO_WEEKS) {
      expect(week.title).toMatchObject({ availability: 'planned' })
      expect(week.prop).toMatchObject({ availability: 'planned' })
      expect('asset' in week.prop).toBe(false)
      expect('assetPath' in week.prop).toBe(false)

      for (const language of ['en', 'es', 'pt'] as const) {
        expect(localizedSeasonLabel(week.name, language).trim(), `${week.id}:${language}:name`).not.toBe('')
        expect(localizedSeasonLabel(week.title.label, language).trim(), `${week.id}:${language}:title`).not.toBe('')
        expect(localizedSeasonLabel(week.prop.label, language).trim(), `${week.id}:${language}:prop`).not.toBe('')
        expect(localizedSeasonLabel(week.finale.label, language).trim(), `${week.id}:${language}:finale`).not.toBe('')
      }
    }
  })

  it('selects weekly content deterministically at inclusive-start, exclusive-end boundaries', () => {
    for (const [index, week] of SEASON_ZERO_WEEKS.entries()) {
      expect(seasonWeekForTimestamp(week.eligibility.startsAt)).toBe(week)
      expect(seasonWeekForTimestamp(week.eligibility.endsAt - 1)).toBe(week)
      expect(seasonWeekForTimestamp(week.eligibility.endsAt)).toBe(SEASON_ZERO_WEEKS[index + 1] ?? null)
    }

    expect(seasonWeekForTimestamp(SEASON_ZERO_START_AT - 1)).toBeNull()
    expect(seasonWeekForTimestamp(SEASON_ZERO_END_AT)).toBeNull()
  })

  it('exposes the full UTC Sunday finale window inside each week', () => {
    for (const week of SEASON_ZERO_WEEKS) {
      expect(week.finale.window).toEqual({
        startsAt: week.eligibility.startsAt,
        endsAt: week.eligibility.startsAt + DAY_MILLISECONDS
      })
      expect(new Date(week.finale.window.startsAt).getUTCDay()).toBe(0)
      expect(isFinaleTimestamp(week, week.finale.window.startsAt)).toBe(true)
      expect(isFinaleTimestamp(week, week.finale.window.endsAt - 1)).toBe(true)
      expect(isFinaleTimestamp(week, week.finale.window.endsAt)).toBe(false)
    }
  })

  it('requires explicit moderation decisions before a candidate is eligible', () => {
    const week = SEASON_ZERO_WEEKS[0]
    const first = week.references[0]
    const decisions: SeasonModerationDecisions = {
      [seasonReferenceKey(week.id, first.phraseId)]: 'approved',
      [seasonReferenceKey(week.id, week.references[1].phraseId)]: 'quarantined'
    }

    expect(eligibleSeasonPhraseIds(week, week.eligibility.startsAt, {})).toEqual([])
    expect(eligibleSeasonPhraseIds(week, week.eligibility.startsAt, decisions)).toEqual([first.phraseId])
    expect(eligibleSeasonPhraseIds(week, week.eligibility.startsAt - 1, decisions)).toEqual([])
    expect(eligibleSeasonPhraseIds(week, week.eligibility.endsAt, decisions)).toEqual([])
  })

  it('does not tautologically pass moderation or launch gates without measured decisions', () => {
    const emptySummary = seasonModerationSummary({})
    expect(emptySummary).toMatchObject({
      total: 120,
      approved: 0,
      quarantined: 0,
      pending: 120,
      quarantineRate: null,
      reviewComplete: false,
      launchReady: false
    })
    expect(emptySummary.weeks.every((week) => !week.promptRangeReady)).toBe(true)

    const allApproved = decisionsForEveryReference('approved')
    expect(seasonModerationSummary(allApproved)).toMatchObject({
      total: 120,
      approved: 120,
      quarantined: 0,
      pending: 0,
      quarantineRate: 0,
      reviewComplete: true,
      launchReady: true
    })

    const firstWeek = SEASON_ZERO_WEEKS[0]
    const oneQuarantined = {
      ...allApproved,
      [seasonReferenceKey(firstWeek.id, firstWeek.references[0].phraseId)]: 'quarantined' as const
    }
    expect(weekModerationSummary(firstWeek, oneQuarantined)).toMatchObject({
      approved: 29,
      quarantined: 1,
      pending: 0,
      promptRangeReady: true
    })
    expect(seasonModerationSummary(oneQuarantined)).toMatchObject({
      approved: 119,
      quarantined: 1,
      pending: 0,
      quarantineRate: 1 / 120,
      launchReady: true
    })

    const sixQuarantined: Record<string, 'approved' | 'quarantined'> = { ...allApproved }
    for (const reference of firstWeek.references.slice(0, 6)) {
      sixQuarantined[seasonReferenceKey(firstWeek.id, reference.phraseId)] = 'quarantined'
    }
    expect(weekModerationSummary(firstWeek, sixQuarantined).promptRangeReady).toBe(false)
    expect(seasonModerationSummary(sixQuarantined)).toMatchObject({
      quarantineRate: 6 / 120,
      launchReady: false
    })
  })

  it('rejects invalid timestamps consistently in every timestamp helper', () => {
    const week = SEASON_ZERO_WEEKS[0]
    const decisions = decisionsForEveryReference('approved')

    for (const timestamp of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 2 ** 53]) {
      expect(seasonWeekForTimestamp(timestamp), String(timestamp)).toBeNull()
      expect(showForTimestamp(timestamp), String(timestamp)).toBeNull()
      expect(isFinaleTimestamp(week, timestamp), String(timestamp)).toBe(false)
      expect(eligibleSeasonPhraseIds(week, timestamp, decisions), String(timestamp)).toEqual([])
    }
  })

  it('falls back to the existing six-theme rotation outside the season window', () => {
    expect(THEMES).toHaveLength(6)

    for (const timestamp of [SEASON_ZERO_START_AT - 1, SEASON_ZERO_END_AT]) {
      expect(showForTimestamp(timestamp)).toEqual({ kind: 'daily-theme', theme: themeForTimestamp(timestamp) })
    }

    for (const week of SEASON_ZERO_WEEKS) {
      expect(showForTimestamp(week.eligibility.startsAt)).toEqual({ kind: 'season', week })
    }
  })
})
