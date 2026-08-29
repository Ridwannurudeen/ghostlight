import { describe, expect, it } from 'vitest'
import { DECK } from '../src/shared/deck'
import {
  SEASON_ZERO_DECOY_APPROVAL_RECORD,
  SEASON_ZERO_MODERATION_EVALUATION,
  SEASON_ZERO_MODERATION_RECORD
} from '../src/shared/season-zero-moderation'
import {
  SEASON_ZERO_WEEKS,
  eligibleSeasonPhraseIds,
  evaluateSeasonModerationRecord,
  parseSeasonModerationRecord,
  seasonReferenceKey,
  type SeasonWeek
} from '../src/shared/seasons'

describe('checked-in Season Zero moderation ledger', () => {
  it('covers exactly the current 120 week references with explicit approvals', () => {
    const expectedKeys = SEASON_ZERO_WEEKS.flatMap((week) =>
      week.references.map((reference) => seasonReferenceKey(week.id, reference.phraseId))
    ).sort()
    const decisionKeys = Object.keys(SEASON_ZERO_MODERATION_RECORD.decisions).sort()

    expect(expectedKeys).toHaveLength(120)
    expect(new Set(expectedKeys).size).toBe(120)
    expect(decisionKeys).toEqual(expectedKeys)
    expect(decisionKeys).toHaveLength(120)
    expect(Object.values(SEASON_ZERO_MODERATION_RECORD.decisions).every((decision) => decision === 'approved')).toBe(
      true
    )
    expect(SEASON_ZERO_MODERATION_RECORD).toMatchObject({
      v: 1,
      seasonId: 'season-zero',
      revision: 1,
      updatedAt: 1_787_961_600_000
    })
  })

  it('exports only the parsed launch-ready record and evaluation', () => {
    expect(SEASON_ZERO_MODERATION_EVALUATION).toEqual(
      evaluateSeasonModerationRecord(SEASON_ZERO_MODERATION_RECORD)
    )
    expect(SEASON_ZERO_MODERATION_EVALUATION).toMatchObject({
      launchReady: true,
      houseFallbackReady: true,
      moderation: {
        approved: 120,
        quarantined: 0,
        pending: 0,
        quarantineRate: 0,
        reviewComplete: true,
        launchReady: true
      }
    })
    expect(SEASON_ZERO_MODERATION_EVALUATION.houseFallbackCoverage.every((week) => week.ready)).toBe(true)
  })

  it('is immutable and fails closed when a decision is missing or invalid', () => {
    expect(Object.isFrozen(SEASON_ZERO_MODERATION_RECORD)).toBe(true)
    expect(Object.isFrozen(SEASON_ZERO_MODERATION_RECORD.decisions)).toBe(true)
    expect(Object.isFrozen(SEASON_ZERO_MODERATION_EVALUATION)).toBe(true)

    const firstKey = Object.keys(SEASON_ZERO_MODERATION_RECORD.decisions)[0]
    expect(Reflect.set(SEASON_ZERO_MODERATION_RECORD.decisions, firstKey, 'quarantined')).toBe(false)

    const missingDecision = { ...SEASON_ZERO_MODERATION_RECORD.decisions }
    delete missingDecision[firstKey]
    const incomplete = parseSeasonModerationRecord({
      ...SEASON_ZERO_MODERATION_RECORD,
      revision: 2,
      decisions: missingDecision
    })
    expect(incomplete).not.toBeNull()
    expect(evaluateSeasonModerationRecord(incomplete!).launchReady).toBe(false)

    expect(
      parseSeasonModerationRecord({
        ...SEASON_ZERO_MODERATION_RECORD,
        revision: 2,
        decisions: { ...SEASON_ZERO_MODERATION_RECORD.decisions, [firstKey]: 'pending' }
      })
    ).toBeNull()
  })

  it('does not derive new approvals when a test copy changes reference composition', () => {
    const week = SEASON_ZERO_WEEKS[0]
    const currentIds = new Set(week.references.map((reference) => reference.phraseId))
    const replacement = DECK.find((phrase) => !currentIds.has(phrase.id))!
    const alteredWeek: SeasonWeek = {
      ...week,
      references: [{ phraseId: replacement.id, curationStatus: 'curated' }, ...week.references.slice(1)]
    }

    const originalEligible = eligibleSeasonPhraseIds(
      week,
      week.eligibility.startsAt,
      SEASON_ZERO_MODERATION_RECORD.decisions
    )
    const alteredEligible = eligibleSeasonPhraseIds(
      alteredWeek,
      alteredWeek.eligibility.startsAt,
      SEASON_ZERO_MODERATION_RECORD.decisions
    )

    expect(originalEligible).toHaveLength(30)
    expect(alteredEligible).toHaveLength(29)
    expect(alteredEligible).not.toContain(replacement.id)
    expect(SEASON_ZERO_MODERATION_RECORD.decisions[seasonReferenceKey(week.id, replacement.id)]).toBeUndefined()
    expect(Object.keys(SEASON_ZERO_MODERATION_RECORD.decisions)).toHaveLength(120)
  })

  it('keeps the minimal reviewed food decoys separate from primary approvals', () => {
    expect(SEASON_ZERO_DECOY_APPROVAL_RECORD).toEqual({
      v: 1,
      seasonId: 'season-zero',
      revision: 1,
      updatedAt: 1_787_961_600_000,
      phraseIds: ['food-burn-the-toast', 'food-order-a-pizza']
    })
    expect(Object.isFrozen(SEASON_ZERO_DECOY_APPROVAL_RECORD)).toBe(true)
    expect(Object.isFrozen(SEASON_ZERO_DECOY_APPROVAL_RECORD.phraseIds)).toBe(true)
    expect(Reflect.set(SEASON_ZERO_DECOY_APPROVAL_RECORD.phraseIds, 0, 'food-flip-a-pancake')).toBe(false)

    const scheduledPhraseIds = new Set(
      SEASON_ZERO_WEEKS.flatMap((week) => week.references.map((reference) => reference.phraseId))
    )
    const approvedDecoys = SEASON_ZERO_DECOY_APPROVAL_RECORD.phraseIds.map((phraseId) =>
      DECK.find((phrase) => phrase.id === phraseId)
    )
    expect(approvedDecoys.every((phrase) => phrase?.category === 'food')).toBe(true)
    expect(new Set(approvedDecoys.map((phrase) => phrase?.text.split(' ')[0].toLowerCase())).size).toBe(2)
    expect(new Set(approvedDecoys.map((phrase) => [...phrase!.suggested].sort().join(':'))).size).toBe(2)
    expect(SEASON_ZERO_DECOY_APPROVAL_RECORD.phraseIds.every((phraseId) => !scheduledPhraseIds.has(phraseId))).toBe(
      true
    )
  })
})
