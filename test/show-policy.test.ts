import { describe, expect, it } from 'vitest'
import { DECK, EMOTE_VOCABULARY, HOUSE_CHARADES, type PhraseId } from '../src/shared/deck'
import { themeForTimestamp } from '../src/shared/config'
import { pickDecoys } from '../src/shared/pick'
import { SEASON_ZERO_DECOY_APPROVAL_RECORD, SEASON_ZERO_MODERATION_RECORD } from '../src/shared/season-zero-moderation'
import {
  SEASON_ZERO_END_AT,
  SEASON_ZERO_START_AT,
  SEASON_ZERO_WEEKS,
  evaluateSeasonModerationRecord,
  seasonReferenceKey,
  type SeasonModerationRecord
} from '../src/shared/seasons'
import { acceptedShowPolicy, showPolicyForTimestamp } from '../src/shared/show-policy'

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000
const ALL_PHRASE_IDS = DECK.map((phrase) => phrase.id).sort()

function expectedDayKey(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function recordWith(decisions: SeasonModerationRecord['decisions']): SeasonModerationRecord {
  return {
    ...SEASON_ZERO_MODERATION_RECORD,
    revision: SEASON_ZERO_MODERATION_RECORD.revision + 1,
    decisions
  }
}

describe('show policy timestamp boundaries', () => {
  it('returns null for invalid and out-of-Date-range timestamps', () => {
    for (const timestamp of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001]) {
      expect(showPolicyForTimestamp(timestamp), String(timestamp)).toBeNull()
    }
  })

  it('uses exact half-open UTC week boundaries and canonical keys', () => {
    const before = showPolicyForTimestamp(SEASON_ZERO_START_AT - 1)!
    expect(before).toMatchObject({ kind: 'daily', showKey: `daily:${expectedDayKey(SEASON_ZERO_START_AT - 1)}` })

    for (const week of SEASON_ZERO_WEEKS) {
      expect(showPolicyForTimestamp(week.eligibility.startsAt)).toMatchObject({
        kind: 'season-zero',
        showKey: `season-zero:${week.id}`,
        season: { id: 'season-zero', weekId: week.id }
      })
      expect(showPolicyForTimestamp(week.eligibility.endsAt - 1)).toMatchObject({
        kind: 'season-zero',
        showKey: `season-zero:${week.id}`
      })
    }

    const after = showPolicyForTimestamp(SEASON_ZERO_END_AT)!
    expect(after).toMatchObject({ kind: 'daily', showKey: `daily:${expectedDayKey(SEASON_ZERO_END_AT)}` })
  })

  it('reuses the checked-in policy within the same UTC day', () => {
    const timestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt
    expect(showPolicyForTimestamp(timestamp + 1)).toBe(showPolicyForTimestamp(timestamp + DAY_MILLISECONDS - 1))
  })
})

describe('accepted show policy', () => {
  it('accepts only an exact canonical key and season projection', () => {
    const daily = showPolicyForTimestamp(SEASON_ZERO_START_AT - 1)!
    expect(acceptedShowPolicy(daily, daily.showKey, undefined)).toBe(daily)
    expect(acceptedShowPolicy(daily, daily.showKey, null)).toBe(daily)
    expect(acceptedShowPolicy(daily, `${daily.showKey}:stale`, null)).toBeNull()

    const weekly = showPolicyForTimestamp(SEASON_ZERO_START_AT)!
    if (weekly.kind !== 'season-zero') throw new Error('Expected season policy')
    expect(acceptedShowPolicy(weekly, weekly.showKey, weekly.season)).toBe(weekly)
    expect(acceptedShowPolicy(weekly, weekly.showKey, null)).toBeNull()
    expect(acceptedShowPolicy(weekly, weekly.showKey, { ...weekly.season, endsAt: weekly.season.endsAt + 1 })).toBeNull()
    expect(
      acceptedShowPolicy(weekly, weekly.showKey, {
        ...weekly.season,
        finale: { ...weekly.season.finale, endsAt: weekly.season.finale.endsAt + 1 }
      })
    ).toBeNull()
  })
})

describe('daily show policy', () => {
  it('preserves full-deck primary and decoy availability with the canonical theme preference', () => {
    for (const timestamp of [0, SEASON_ZERO_START_AT - DAY_MILLISECONDS, SEASON_ZERO_END_AT]) {
      const policy = showPolicyForTimestamp(timestamp)!
      const theme = themeForTimestamp(timestamp)
      expect(policy).toMatchObject({
        kind: 'daily',
        legacyTheme: { id: theme.id, label: theme.label }
      })
      expect([...policy.primaryPhraseIds].sort()).toEqual(ALL_PHRASE_IDS)
      expect([...policy.decoyPhraseIds].sort()).toEqual(ALL_PHRASE_IDS)
      expect(policy.housePhraseIds).toEqual(HOUSE_CHARADES.map((charade) => charade.phraseId))
      expect('season' in policy).toBe(false)
      expect(Object.isFrozen(policy)).toBe(true)
      expect(Object.isFrozen(policy.legacyTheme)).toBe(true)
      expect(Object.isFrozen(policy.primaryPhraseIds)).toBe(true)
      expect(Object.isFrozen(policy.decoyPhraseIds)).toBe(true)
      expect(Object.isFrozen(policy.housePhraseIds)).toBe(true)
    }
  })
})

describe('Season Zero show policy', () => {
  it('uses exactly the 30 explicitly approved references in each scheduled week', () => {
    for (const week of SEASON_ZERO_WEEKS) {
      const policy = showPolicyForTimestamp(week.eligibility.startsAt)!
      const expected = week.references
        .filter(
          (reference) =>
            SEASON_ZERO_MODERATION_RECORD.decisions[seasonReferenceKey(week.id, reference.phraseId)] === 'approved'
        )
        .map((reference) => reference.phraseId)
      expect(policy.kind).toBe('season-zero')
      expect(policy.primaryPhraseIds).toEqual(expected)
      expect(policy.primaryPhraseIds).toHaveLength(30)
    }
  })

  it('fails closed when the supplied strict record is incomplete', () => {
    const decisions = { ...SEASON_ZERO_MODERATION_RECORD.decisions }
    delete decisions[Object.keys(decisions)[0]]
    const timestamp = SEASON_ZERO_WEEKS[0].eligibility.startsAt
    expect(showPolicyForTimestamp(timestamp, recordWith(decisions))).toBeNull()
  })

  it('builds decoys only from phrase IDs explicitly approved anywhere in the supplied record', () => {
    const removed = SEASON_ZERO_WEEKS[0].references.find(
      (reference) => !HOUSE_CHARADES.some((charade) => charade.phraseId === reference.phraseId)
    )!
    const decisions = {
      ...SEASON_ZERO_MODERATION_RECORD.decisions,
      [seasonReferenceKey(SEASON_ZERO_WEEKS[0].id, removed.phraseId)]: 'quarantined' as const
    }
    const record = recordWith(decisions)
    expect(evaluateSeasonModerationRecord(record).launchReady).toBe(true)

    const policy = showPolicyForTimestamp(SEASON_ZERO_WEEKS[1].eligibility.startsAt, record)!
    const approvedUnion = new Set<PhraseId>()
    for (const week of SEASON_ZERO_WEEKS) {
      for (const reference of week.references) {
        if (record.decisions[seasonReferenceKey(week.id, reference.phraseId)] === 'approved') {
          approvedUnion.add(reference.phraseId)
        }
      }
    }
    for (const phraseId of SEASON_ZERO_DECOY_APPROVAL_RECORD.phraseIds) approvedUnion.add(phraseId)
    expect(policy.decoyPhraseIds).toEqual([...approvedUnion])
    expect(policy.decoyPhraseIds).not.toContain(removed.phraseId)
  })

  it('exposes only each week’s explicitly approved House fallbacks', () => {
    const evaluation = evaluateSeasonModerationRecord(SEASON_ZERO_MODERATION_RECORD)
    for (const week of SEASON_ZERO_WEEKS) {
      const policy = showPolicyForTimestamp(week.eligibility.startsAt)!
      const coverage = evaluation.houseFallbackCoverage.find((entry) => entry.weekId === week.id)!
      expect(policy.housePhraseIds).toEqual(coverage.approvedPhraseIds)
      expect(policy.housePhraseIds.length).toBeGreaterThan(0)
    }
  })

  it('provides a viable reviewed decoy deck for every active primary', () => {
    for (const week of SEASON_ZERO_WEEKS) {
      const policy = showPolicyForTimestamp(week.eligibility.startsAt)!
      const allowed = new Set(policy.decoyPhraseIds)
      const reviewedDeck = DECK.filter((phrase) => allowed.has(phrase.id as PhraseId))
      const triplets = new Map<string, readonly string[]>()
      for (const phrase of reviewedDeck) {
        triplets.set([...phrase.suggested].sort().join(':'), phrase.suggested)
      }
      const nonmatchingTriplet = [EMOTE_VOCABULARY[0], EMOTE_VOCABULARY[0], EMOTE_VOCABULARY[0]] as const
      expect(triplets.has([...nonmatchingTriplet].sort().join(':'))).toBe(false)
      const performedTriplets = [...triplets.values(), nonmatchingTriplet]
      for (const phraseId of policy.primaryPhraseIds) {
        for (let seed = 0; seed < performedTriplets.length; seed += 1) {
          const performed = performedTriplets[seed]
          const decoys = pickDecoys(phraseId, performed, reviewedDeck, `show-policy:${week.id}:${phraseId}:${seed}`)
          expect(decoys, `${week.id}:${phraseId}:${performed.join(',')}:${seed}`).toHaveLength(2)
          expect(decoys.every((decoy) => allowed.has(decoy.id as PhraseId))).toBe(true)
        }
      }
    }
  })

  it('returns deeply immutable policy values without localized server projections', () => {
    const policy = showPolicyForTimestamp(SEASON_ZERO_START_AT)!
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.legacyTheme)).toBe(true)
    expect(Object.isFrozen(policy.primaryPhraseIds)).toBe(true)
    expect(Object.isFrozen(policy.decoyPhraseIds)).toBe(true)
    expect(Object.isFrozen(policy.housePhraseIds)).toBe(true)
    expect(policy.kind).toBe('season-zero')
    if (policy.kind !== 'season-zero') throw new Error('Expected season policy')
    expect(Object.isFrozen(policy.season)).toBe(true)
    expect(Object.isFrozen(policy.season.finale)).toBe(true)
    expect(policy.season).not.toHaveProperty('name')
    expect(policy.season).not.toHaveProperty('label')
    expect(Reflect.set(policy.season, 'weekId', 'final-encore')).toBe(false)
    expect(Reflect.set(policy.primaryPhraseIds, 0, 'changed')).toBe(false)
  })
})
