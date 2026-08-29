import { describe, expect, it } from 'vitest'
import { THEMES, themeForTimestamp } from '../src/shared/config'
import { DECK, HOUSE_CHARADES } from '../src/shared/deck'
import {
  SEASON_ZERO_END_AT,
  SEASON_ZERO_START_AT,
  SEASON_ZERO_WEEKS,
  eligibleSeasonPhraseIds,
  evaluateSeasonModerationRecord,
  isFinaleTimestamp,
  localizedSeasonLabel,
  parseSeasonModerationRecord,
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

function moderationRecord(decisions: SeasonModerationDecisions = {}) {
  return {
    v: 1,
    seasonId: 'season-zero',
    revision: 7,
    updatedAt: SEASON_ZERO_START_AT,
    decisions
  }
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

  it('uses the strict-audit replacement references and excludes every superseded candidate', () => {
    const replacements = {
      'first-impressions': [
        ['feelings-calm-your-nerves', 'awkward-hold-door-too-long'],
        ['feelings-suspect-a-surprise', 'feelings-fall-in-love'],
        ['feelings-hold-in-a-laugh', 'dcl-life-dance-at-the-plaza'],
        ['awkward-wear-shirt-backwards', 'everyday-dodge-the-rain'],
        ['awkward-sit-in-wrong-chair', 'awkward-trip-on-stage']
      ],
      'main-character-energy': [
        ['dcl-life-trade-digital-art', 'pop-sing-into-a-microphone'],
        ['pop-ride-a-space-rocket', 'pop-dodge-a-laser'],
        ['pop-direct-a-blockbuster', 'everyday-take-a-selfie'],
        ['pop-time-travel', 'pop-meet-an-alien'],
        ['pop-survive-a-dinosaur', 'pop-escape-a-zombie'],
        ['pop-summon-a-dragon', 'dcl-life-vote-in-the-dao']
      ],
      'fashionably-haunted': [
        ['everyday-dance-in-elevator', 'pop-become-a-superhero'],
        ['feelings-fall-in-love', 'feelings-fear-a-spider'],
        ['pop-summon-a-dragon', 'pop-fight-an-invisible-villain'],
        ['awkward-wear-shirt-backwards', 'pop-meet-an-alien'],
        ['awkward-get-caught-singing', 'pop-sing-into-a-microphone'],
        ['awkward-pretend-to-know-song', 'awkward-trip-on-stage']
      ],
      'final-encore': [
        ['feelings-hold-in-a-laugh', 'pop-become-a-superhero'],
        ['food-bake-a-cake', 'pop-cast-a-magic-spell'],
        ['food-share-the-popcorn', 'pop-dodge-a-laser'],
        ['food-serve-breakfast', 'dcl-life-vote-in-the-dao'],
        ['pop-direct-a-blockbuster', 'pop-fight-an-invisible-villain']
      ]
    } as const

    for (const week of SEASON_ZERO_WEEKS) {
      const phraseIds = new Set(week.references.map((reference) => reference.phraseId))
      for (const [superseded, replacement] of replacements[week.id]) {
        expect(phraseIds.has(superseded), `${week.id}:${superseded}`).toBe(false)
        expect(phraseIds.has(replacement), `${week.id}:${replacement}`).toBe(true)
      }
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

describe('Season Zero moderation records', () => {
  it('parses the exact v1 schema into an immutable normalized record', () => {
    const week = SEASON_ZERO_WEEKS[0]
    const firstKey = seasonReferenceKey(week.id, week.references[0].phraseId)
    const secondKey = seasonReferenceKey(week.id, week.references[1].phraseId)
    const rawDecisions = { [secondKey]: 'quarantined', [firstKey]: 'approved' }
    const raw = moderationRecord(rawDecisions)

    const parsed = parseSeasonModerationRecord(raw)

    expect(parsed).toEqual({
      v: 1,
      seasonId: 'season-zero',
      revision: 7,
      updatedAt: SEASON_ZERO_START_AT,
      decisions: { [firstKey]: 'approved', [secondKey]: 'quarantined' }
    })
    expect(parsed).not.toBe(raw)
    expect(parsed?.decisions).not.toBe(rawDecisions)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.decisions)).toBe(true)
    expect(Reflect.set(parsed!.decisions, firstKey, 'quarantined')).toBe(false)
  })

  it('rejects missing or unknown top-level fields and non-record decision containers', () => {
    const valid = moderationRecord()
    const { decisions: _decisions, ...missingDecisions } = valid
    const hiddenUnknown = moderationRecord()
    Object.defineProperty(hiddenUnknown, 'extra', { value: true })

    expect(parseSeasonModerationRecord(missingDecisions)).toBeNull()
    expect(parseSeasonModerationRecord({ ...valid, extra: true })).toBeNull()
    expect(parseSeasonModerationRecord(hiddenUnknown)).toBeNull()
    expect(parseSeasonModerationRecord({ ...valid, [Symbol('extra')]: true })).toBeNull()
    expect(parseSeasonModerationRecord({ ...valid, decisions: { [Symbol('extra')]: 'approved' } })).toBeNull()
    expect(parseSeasonModerationRecord({ ...valid, decisions: null })).toBeNull()
    expect(parseSeasonModerationRecord({ ...valid, decisions: [] })).toBeNull()
    expect(parseSeasonModerationRecord(null)).toBeNull()
  })

  it('accepts only own enumerable data properties without executing top-level or decision getters', () => {
    const topLevelGetter = moderationRecord()
    let topLevelCalls = 0
    Object.defineProperty(topLevelGetter, 'revision', {
      enumerable: true,
      get() {
        topLevelCalls += 1
        throw new Error('must not execute')
      }
    })

    const knownKey = seasonReferenceKey(SEASON_ZERO_WEEKS[0].id, SEASON_ZERO_WEEKS[0].references[0].phraseId)
    const decisionGetter: Record<string, unknown> = {}
    let decisionCalls = 0
    Object.defineProperty(decisionGetter, knownKey, {
      enumerable: true,
      get() {
        decisionCalls += 1
        throw new Error('must not execute')
      }
    })

    const hiddenRequired = moderationRecord()
    Object.defineProperty(hiddenRequired, 'revision', { value: 7, enumerable: false })
    const hiddenDecision: Record<string, unknown> = {}
    Object.defineProperty(hiddenDecision, knownKey, { value: 'approved', enumerable: false })

    expect(parseSeasonModerationRecord(topLevelGetter)).toBeNull()
    expect(topLevelCalls).toBe(0)
    expect(parseSeasonModerationRecord(moderationRecord(decisionGetter))).toBeNull()
    expect(decisionCalls).toBe(0)
    expect(parseSeasonModerationRecord(hiddenRequired)).toBeNull()
    expect(parseSeasonModerationRecord(moderationRecord(hiddenDecision))).toBeNull()
  })

  it('accepts at most all known keys and rejects unknown keys or decision values', () => {
    const allApproved = decisionsForEveryReference('approved')
    expect(Object.keys(allApproved)).toHaveLength(120)
    expect(parseSeasonModerationRecord(moderationRecord(allApproved))).not.toBeNull()
    expect(parseSeasonModerationRecord(moderationRecord({ ...allApproved, unknown: 'approved' }))).toBeNull()

    const knownKey = Object.keys(allApproved)[0]
    for (const decision of ['curated', 'pending', '', 1, null]) {
      expect(parseSeasonModerationRecord(moderationRecord({ [knownKey]: decision })), String(decision)).toBeNull()
    }
  })

  it('requires the exact version and season plus safe nonnegative revision and timestamp', () => {
    const valid = moderationRecord()

    for (const v of [0, 2, '1']) expect(parseSeasonModerationRecord({ ...valid, v }), `v:${v}`).toBeNull()
    for (const seasonId of ['', 'season-one', null]) {
      expect(parseSeasonModerationRecord({ ...valid, seasonId }), `season:${seasonId}`).toBeNull()
    }
    for (const revision of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(parseSeasonModerationRecord({ ...valid, revision }), `revision:${revision}`).toBeNull()
    }
    for (const updatedAt of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(parseSeasonModerationRecord({ ...valid, updatedAt }), `updatedAt:${updatedAt}`).toBeNull()
    }

    expect(
      parseSeasonModerationRecord({ ...valid, revision: 2_147_483_647, updatedAt: 8_640_000_000_000_000 })
    ).not.toBeNull()
    expect(parseSeasonModerationRecord({ ...valid, revision: 2_147_483_648 })).toBeNull()
    expect(parseSeasonModerationRecord({ ...valid, updatedAt: 8_640_000_000_000_001 })).toBeNull()
  })

  it('keeps launch blocked until every week has an explicitly approved House fallback', () => {
    const emptyRecord = parseSeasonModerationRecord(moderationRecord())!
    expect(evaluateSeasonModerationRecord(emptyRecord)).toMatchObject({
      launchReady: false,
      houseFallbackReady: false
    })

    const allApproved = decisionsForEveryReference('approved')
    const readyRecord = parseSeasonModerationRecord(moderationRecord(allApproved))!
    const ready = evaluateSeasonModerationRecord(readyRecord)
    expect(ready.moderation.launchReady).toBe(true)
    expect(ready.houseFallbackReady).toBe(true)
    expect(ready.houseFallbackCoverage.every((week) => week.ready && week.approvedPhraseIds.length > 0)).toBe(true)
    expect(ready.launchReady).toBe(true)
    expect(Object.isFrozen(ready)).toBe(true)
    expect(Object.isFrozen(ready.moderation)).toBe(true)
    expect(Object.isFrozen(ready.moderation.weeks)).toBe(true)
    expect(ready.moderation.weeks.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(ready.houseFallbackCoverage)).toBe(true)
    expect(ready.houseFallbackCoverage.every(Object.isFrozen)).toBe(true)
    expect(ready.houseFallbackCoverage.every((week) => Object.isFrozen(week.approvedPhraseIds))).toBe(true)
    expect(Reflect.set(ready, 'launchReady', false)).toBe(false)
    expect(Reflect.set(ready.moderation, 'launchReady', false)).toBe(false)
    expect(Reflect.set(ready.moderation.weeks[0], 'approved', 0)).toBe(false)
    expect(Reflect.set(ready.houseFallbackCoverage, 0, ready.houseFallbackCoverage[0])).toBe(false)
    expect(
      Reflect.set(
        ready.houseFallbackCoverage[0].approvedPhraseIds,
        0,
        ready.houseFallbackCoverage[0].approvedPhraseIds[0]
      )
    ).toBe(false)

    const housePhraseIds = new Set(HOUSE_CHARADES.map((charade) => charade.phraseId))
    const secondWeek = SEASON_ZERO_WEEKS[1]
    const withoutSecondWeekFallback: Record<string, 'approved' | 'quarantined'> = { ...allApproved }
    const secondWeekHouseReferences = secondWeek.references.filter((reference) => housePhraseIds.has(reference.phraseId))
    expect(secondWeekHouseReferences).toHaveLength(2)
    for (const reference of secondWeekHouseReferences) {
      withoutSecondWeekFallback[seasonReferenceKey(secondWeek.id, reference.phraseId)] = 'quarantined'
    }

    const noFallbackRecord = parseSeasonModerationRecord(moderationRecord(withoutSecondWeekFallback))!
    const noFallback = evaluateSeasonModerationRecord(noFallbackRecord)
    expect(noFallback.moderation.launchReady).toBe(true)
    expect(noFallback.houseFallbackCoverage.find((week) => week.weekId === secondWeek.id)).toEqual({
      weekId: secondWeek.id,
      approvedPhraseIds: [],
      ready: false
    })
    expect(noFallback.houseFallbackReady).toBe(false)
    expect(noFallback.launchReady).toBe(false)
  })
})
