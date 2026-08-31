import { describe, expect, it } from 'vitest'
import {
  SEASON_ZERO_END_AT,
  SEASON_ZERO_START_AT,
  SEASON_ZERO_WEEKS,
  seasonZeroCalendarSnapshot
} from '../src/season-calendar.js'

describe('Season Zero scheduled calendar', () => {
  it('returns the exact deeply frozen v1 scheduled-calendar contract', () => {
    const calendar = seasonZeroCalendarSnapshot(SEASON_ZERO_START_AT - 1)

    expect(calendar).toEqual({
      schemaVersion: 1,
      kind: 'scheduled-calendar',
      seasonId: 'season-zero',
      timeZone: 'UTC',
      startsAt: 1_789_257_600_000,
      endsAt: 1_791_676_800_000,
      weeks: [
        {
          id: 'first-impressions',
          labels: {
            en: 'First Impressions',
            es: 'Primeras impresiones',
            pt: 'Primeiras impressões'
          },
          startsAt: 1_789_257_600_000,
          endsAt: 1_789_862_400_000
        },
        {
          id: 'main-character-energy',
          labels: {
            en: 'Main Character Energy',
            es: 'Energía de protagonista',
            pt: 'Energia de protagonista'
          },
          startsAt: 1_789_862_400_000,
          endsAt: 1_790_467_200_000
        },
        {
          id: 'fashionably-haunted',
          labels: {
            en: 'Fashionably Haunted',
            es: 'Elegantemente encantado',
            pt: 'Elegantemente assombrado'
          },
          startsAt: 1_790_467_200_000,
          endsAt: 1_791_072_000_000
        },
        {
          id: 'final-encore',
          labels: { en: 'Final Encore', es: 'Bis final', pt: 'Bis final' },
          startsAt: 1_791_072_000_000,
          endsAt: 1_791_676_800_000
        }
      ],
      calendarState: {
        basis: 'api-clock',
        asOf: SEASON_ZERO_START_AT - 1,
        phase: 'upcoming',
        scheduledWeekId: null
      },
      liveOperationalStateAvailable: false
    })
    expect(Object.isFrozen(calendar)).toBe(true)
    expect(Object.isFrozen(calendar.weeks)).toBe(true)
    expect(Object.isFrozen(calendar.calendarState)).toBe(true)
    for (const week of calendar.weeks) {
      expect(Object.isFrozen(week)).toBe(true)
      expect(Object.isFrozen(week.labels)).toBe(true)
    }
  })

  it('uses inclusive starts and exclusive ends at every calendar boundary', () => {
    expect(seasonZeroCalendarSnapshot(SEASON_ZERO_START_AT - 1).calendarState).toEqual({
      basis: 'api-clock',
      asOf: SEASON_ZERO_START_AT - 1,
      phase: 'upcoming',
      scheduledWeekId: null
    })

    for (const [index, week] of SEASON_ZERO_WEEKS.entries()) {
      expect(seasonZeroCalendarSnapshot(week.startsAt).calendarState).toMatchObject({
        phase: 'scheduled-week',
        scheduledWeekId: week.id
      })
      expect(seasonZeroCalendarSnapshot(week.endsAt - 1).calendarState).toMatchObject({
        phase: 'scheduled-week',
        scheduledWeekId: week.id
      })

      const nextWeek = SEASON_ZERO_WEEKS[index + 1]
      expect(seasonZeroCalendarSnapshot(week.endsAt).calendarState).toMatchObject(
        nextWeek ? { phase: 'scheduled-week', scheduledWeekId: nextWeek.id } : { phase: 'ended', scheduledWeekId: null }
      )
    }

    expect(seasonZeroCalendarSnapshot(SEASON_ZERO_END_AT).calendarState).toEqual({
      basis: 'api-clock',
      asOf: SEASON_ZERO_END_AT,
      phase: 'ended',
      scheduledWeekId: null
    })
  })

  it('fails closed for invalid current timestamps', () => {
    for (const now of [-1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => seasonZeroCalendarSnapshot(now)).toThrowError(new RangeError('Invalid current timestamp'))
    }

    expect(() => seasonZeroCalendarSnapshot(0)).not.toThrow()
    expect(() => seasonZeroCalendarSnapshot(8_640_000_000_000_000)).not.toThrow()
    expect(() => seasonZeroCalendarSnapshot(8_640_000_000_000_001)).toThrow('Invalid current timestamp')
  })

  it('exposes schedule facts without claiming live or active operational state', () => {
    const calendar = seasonZeroCalendarSnapshot(SEASON_ZERO_START_AT)

    expect(Object.keys(calendar)).toEqual([
      'schemaVersion',
      'kind',
      'seasonId',
      'timeZone',
      'startsAt',
      'endsAt',
      'weeks',
      'calendarState',
      'liveOperationalStateAvailable'
    ])
    expect(Object.keys(calendar.calendarState)).toEqual(['basis', 'asOf', 'phase', 'scheduledWeekId'])
    expect(calendar.liveOperationalStateAvailable).toBe(false)
    for (const week of calendar.weeks) {
      expect(Object.keys(week)).toEqual(['id', 'labels', 'startsAt', 'endsAt'])
    }
    expect(calendar).not.toHaveProperty('active')
    expect(calendar).not.toHaveProperty('liveState')
    expect(calendar).not.toHaveProperty('operationalState')
  })
})
