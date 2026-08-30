export type SeasonZeroWeekId = 'first-impressions' | 'main-character-energy' | 'fashionably-haunted' | 'final-encore'

export type SeasonCalendarPhase = 'upcoming' | 'scheduled-week' | 'ended'

export type SeasonCalendarLabels = Readonly<{
  en: string
  es: string
  pt: string
}>

export type SeasonCalendarWeek = Readonly<{
  id: SeasonZeroWeekId
  labels: SeasonCalendarLabels
  startsAt: number
  endsAt: number
}>

export type SeasonCalendarState = Readonly<{
  basis: 'api-clock'
  asOf: number
  phase: SeasonCalendarPhase
  scheduledWeekId: SeasonZeroWeekId | null
}>

export type SeasonCalendarSnapshot = Readonly<{
  schemaVersion: 1
  kind: 'scheduled-calendar'
  seasonId: 'season-zero'
  timeZone: 'UTC'
  startsAt: number
  endsAt: number
  weeks: readonly SeasonCalendarWeek[]
  calendarState: SeasonCalendarState
  liveOperationalStateAvailable: false
}>

const MAX_TIMESTAMP = 8_640_000_000_000_000

export const SEASON_ZERO_START_AT = 1_789_257_600_000
export const SEASON_ZERO_END_AT = 1_791_676_800_000

export const SEASON_ZERO_WEEKS: readonly SeasonCalendarWeek[] = Object.freeze([
  Object.freeze({
    id: 'first-impressions',
    labels: Object.freeze({
      en: 'First Impressions',
      es: 'Primeras impresiones',
      pt: 'Primeiras impressões'
    }),
    startsAt: 1_789_257_600_000,
    endsAt: 1_789_862_400_000
  }),
  Object.freeze({
    id: 'main-character-energy',
    labels: Object.freeze({
      en: 'Main Character Energy',
      es: 'Energía de protagonista',
      pt: 'Energia de protagonista'
    }),
    startsAt: 1_789_862_400_000,
    endsAt: 1_790_467_200_000
  }),
  Object.freeze({
    id: 'fashionably-haunted',
    labels: Object.freeze({
      en: 'Fashionably Haunted',
      es: 'Elegantemente encantado',
      pt: 'Elegantemente assombrado'
    }),
    startsAt: 1_790_467_200_000,
    endsAt: 1_791_072_000_000
  }),
  Object.freeze({
    id: 'final-encore',
    labels: Object.freeze({
      en: 'Final Encore',
      es: 'Bis final',
      pt: 'Bis final'
    }),
    startsAt: 1_791_072_000_000,
    endsAt: 1_791_676_800_000
  })
])

export function seasonZeroCalendarSnapshot(now = Date.now()): SeasonCalendarSnapshot {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
    throw new RangeError('Invalid current timestamp')
  }

  let phase: SeasonCalendarPhase = 'upcoming'
  let scheduledWeekId: SeasonZeroWeekId | null = null
  if (now >= SEASON_ZERO_END_AT) {
    phase = 'ended'
  } else if (now >= SEASON_ZERO_START_AT) {
    phase = 'scheduled-week'
    scheduledWeekId = SEASON_ZERO_WEEKS.find((week) => now >= week.startsAt && now < week.endsAt)!.id
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: 'scheduled-calendar',
    seasonId: 'season-zero',
    timeZone: 'UTC',
    startsAt: SEASON_ZERO_START_AT,
    endsAt: SEASON_ZERO_END_AT,
    weeks: SEASON_ZERO_WEEKS,
    calendarState: Object.freeze({
      basis: 'api-clock',
      asOf: now,
      phase,
      scheduledWeekId
    }),
    liveOperationalStateAvailable: false
  })
}
