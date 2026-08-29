import { THEMES, themeForTimestamp } from './config'
import type { PhraseId } from './deck'
import type { Language } from './i18n'

export type LocalizedSeasonLabel = Readonly<Record<Language, string>>
export type SeasonWeekId = 'first-impressions' | 'main-character-energy' | 'fashionably-haunted' | 'final-encore'
export type SeasonModerationDecision = 'approved' | 'quarantined'
export type SeasonModerationDecisions = Readonly<Record<string, SeasonModerationDecision | undefined>>

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

export type WeekModerationSummary = {
  weekId: SeasonWeekId
  total: number
  approved: number
  quarantined: number
  pending: number
  quarantineRate: number | null
  reviewComplete: boolean
  promptRangeReady: boolean
}

export type SeasonModerationSummary = {
  total: number
  approved: number
  quarantined: number
  pending: number
  quarantineRate: number | null
  reviewComplete: boolean
  launchReady: boolean
  weeks: readonly WeekModerationSummary[]
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const WEEK_MILLISECONDS = 7 * DAY_MILLISECONDS

export const SEASON_ZERO_START_AT = Date.UTC(2026, 8, 13)
export const SEASON_ZERO_END_AT = SEASON_ZERO_START_AT + 4 * WEEK_MILLISECONDS

function curatedReferences(phraseIds: readonly PhraseId[]): readonly SeasonReference[] {
  return phraseIds.map((phraseId) => ({ phraseId, curationStatus: 'curated' }))
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
    references: curatedReferences([
      'everyday-wake-up-late',
      'everyday-miss-the-bus',
      'everyday-find-lost-keys',
      'everyday-take-a-selfie',
      'everyday-greet-a-neighbor',
      'everyday-choose-an-outfit',
      'everyday-forget-a-password',
      'feelings-hide-embarrassment',
      'feelings-calm-your-nerves',
      'feelings-fake-confidence',
      'feelings-suspect-a-surprise',
      'feelings-act-confused',
      'feelings-get-starstruck',
      'feelings-hold-in-a-laugh',
      'dcl-life-enter-a-portal',
      'dcl-life-meet-your-digital-twin',
      'dcl-life-take-an-avatar-selfie',
      'dcl-life-wave-at-an-npc',
      'dcl-life-explore-a-new-world',
      'pop-walk-the-red-carpet',
      'pop-meet-an-alien',
      'pop-reveal-secret-identity',
      'awkward-wave-at-wrong-person',
      'awkward-forget-someones-name',
      'awkward-get-stuck-handshaking',
      'awkward-enter-wrong-room',
      'awkward-miss-a-high-five',
      'awkward-wear-shirt-backwards',
      'awkward-sit-in-wrong-chair',
      'awkward-pretend-to-know-song'
    ]),
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
    references: curatedReferences([
      'feelings-celebrate-a-win',
      'feelings-fake-confidence',
      'feelings-burst-with-excitement',
      'feelings-lose-your-patience',
      'feelings-feel-proud',
      'feelings-get-starstruck',
      'dcl-life-mint-a-wearable',
      'dcl-life-dance-at-the-plaza',
      'dcl-life-flex-a-rare-wearable',
      'dcl-life-build-a-dream-house',
      'dcl-life-claim-a-free-wearable',
      'dcl-life-chase-an-airdrop',
      'dcl-life-crash-a-virtual-party',
      'dcl-life-trade-digital-art',
      'pop-become-a-superhero',
      'pop-fight-an-invisible-villain',
      'pop-walk-the-red-carpet',
      'pop-win-a-talent-show',
      'pop-cast-a-magic-spell',
      'pop-ride-a-space-rocket',
      'pop-train-like-a-ninja',
      'pop-direct-a-blockbuster',
      'pop-time-travel',
      'pop-survive-a-dinosaur',
      'pop-rule-a-kingdom',
      'pop-summon-a-dragon',
      'pop-reveal-secret-identity',
      'awkward-trip-on-stage',
      'awkward-dance-after-music-stops',
      'awkward-get-caught-singing'
    ]),
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
    references: curatedReferences([
      'everyday-take-a-selfie',
      'everyday-dance-in-elevator',
      'everyday-choose-an-outfit',
      'feelings-fall-in-love',
      'feelings-hide-embarrassment',
      'feelings-fake-confidence',
      'feelings-feel-jealous',
      'feelings-feel-proud',
      'feelings-get-starstruck',
      'dcl-life-enter-a-portal',
      'dcl-life-mint-a-wearable',
      'dcl-life-dance-at-the-plaza',
      'dcl-life-meet-your-digital-twin',
      'dcl-life-flex-a-rare-wearable',
      'dcl-life-claim-a-free-wearable',
      'dcl-life-take-an-avatar-selfie',
      'dcl-life-attend-metaverse-wedding',
      'dcl-life-crash-a-virtual-party',
      'dcl-life-find-a-secret-room',
      'pop-walk-the-red-carpet',
      'pop-escape-a-zombie',
      'pop-cast-a-magic-spell',
      'pop-solve-a-mystery',
      'pop-join-a-boy-band',
      'pop-summon-a-dragon',
      'pop-ghost-party',
      'pop-reveal-secret-identity',
      'awkward-wear-shirt-backwards',
      'awkward-get-caught-singing',
      'awkward-pretend-to-know-song'
    ]),
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
    references: curatedReferences([
      'everyday-take-a-selfie',
      'everyday-dance-in-elevator',
      'feelings-celebrate-a-win',
      'feelings-burst-with-excitement',
      'feelings-feel-proud',
      'feelings-get-starstruck',
      'feelings-hold-in-a-laugh',
      'food-bake-a-cake',
      'food-flip-a-pancake',
      'food-share-the-popcorn',
      'food-juggle-three-oranges',
      'food-serve-breakfast',
      'dcl-life-dance-at-the-plaza',
      'dcl-life-tip-a-performer',
      'dcl-life-take-an-avatar-selfie',
      'dcl-life-attend-metaverse-wedding',
      'dcl-life-crash-a-virtual-party',
      'pop-walk-the-red-carpet',
      'pop-win-a-talent-show',
      'pop-sing-into-a-microphone',
      'pop-direct-a-blockbuster',
      'pop-join-a-boy-band',
      'pop-ghost-party',
      'pop-reveal-secret-identity',
      'awkward-trip-on-stage',
      'awkward-laugh-at-bad-time',
      'awkward-miss-a-high-five',
      'awkward-dance-after-music-stops',
      'awkward-get-caught-singing',
      'awkward-pretend-to-know-song'
    ]),
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
  return {
    weekId: week.id,
    total,
    approved,
    quarantined,
    pending,
    quarantineRate: pending === 0 ? quarantined / total : null,
    reviewComplete: pending === 0,
    promptRangeReady: approved >= 25 && approved <= 40
  }
}

export function seasonModerationSummary(decisions: SeasonModerationDecisions): SeasonModerationSummary {
  const weeks = SEASON_ZERO_WEEKS.map((week) => weekModerationSummary(week, decisions))
  const total = weeks.reduce((sum, week) => sum + week.total, 0)
  const approved = weeks.reduce((sum, week) => sum + week.approved, 0)
  const quarantined = weeks.reduce((sum, week) => sum + week.quarantined, 0)
  const pending = weeks.reduce((sum, week) => sum + week.pending, 0)
  const reviewComplete = pending === 0
  const quarantineRate = reviewComplete ? quarantined / total : null
  return {
    total,
    approved,
    quarantined,
    pending,
    quarantineRate,
    reviewComplete,
    launchReady:
      reviewComplete && weeks.every((week) => week.promptRangeReady) && quarantineRate !== null && quarantineRate < 0.02,
    weeks
  }
}

export function showForTimestamp(timestamp: number):
  | { kind: 'season'; week: SeasonWeek }
  | { kind: 'daily-theme'; theme: (typeof THEMES)[number] }
  | null {
  if (!isValidTimestamp(timestamp)) return null
  const week = seasonWeekForTimestamp(timestamp)
  return week ? { kind: 'season', week } : { kind: 'daily-theme', theme: themeForTimestamp(timestamp) }
}
