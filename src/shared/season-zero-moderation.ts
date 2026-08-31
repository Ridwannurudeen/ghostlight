import { PLAYABLE_DECK, type PhraseId } from './deck'
import { evaluateSeasonModerationRecord, parseSeasonModerationRecord } from './seasons'

const CHECKED_IN_SEASON_ZERO_MODERATION = {
  v: 1,
  seasonId: 'season-zero',
  revision: 3,
  updatedAt: 1_788_048_000_000,
  decisions: {
    'first-impressions:everyday-miss-the-bus': 'approved',
    'first-impressions:everyday-take-a-selfie': 'approved',
    'first-impressions:everyday-dance-in-elevator': 'approved',
    'first-impressions:everyday-chase-a-mosquito': 'approved',
    'first-impressions:everyday-dodge-the-rain': 'approved',
    'first-impressions:feelings-celebrate-a-win': 'approved',
    'first-impressions:feelings-fake-confidence': 'approved',
    'first-impressions:feelings-lose-your-patience': 'approved',
    'first-impressions:feelings-act-confused': 'approved',
    'first-impressions:food-taste-a-lemon': 'approved',
    'first-impressions:food-eat-spicy-noodles': 'approved',
    'first-impressions:food-drop-the-ice-cream': 'approved',
    'first-impressions:food-juggle-three-oranges': 'approved',
    'first-impressions:dcl-life-enter-a-portal': 'approved',
    'first-impressions:dcl-life-mint-a-wearable': 'approved',
    'first-impressions:dcl-life-dance-at-the-plaza': 'approved',
    'first-impressions:dcl-life-flex-a-rare-wearable': 'approved',
    'first-impressions:dcl-life-vote-in-the-dao': 'approved',
    'first-impressions:pop-become-a-superhero': 'approved',
    'first-impressions:pop-fight-an-invisible-villain': 'approved',
    'first-impressions:pop-meet-an-alien': 'approved',
    'first-impressions:pop-cast-a-magic-spell': 'approved',
    'first-impressions:pop-train-like-a-ninja': 'approved',
    'first-impressions:awkward-wave-at-wrong-person': 'approved',
    'first-impressions:awkward-trip-on-stage': 'approved',
    'first-impressions:awkward-miss-a-high-five': 'approved',
    'first-impressions:awkward-dance-after-music-stops': 'approved',
    'first-impressions:awkward-drop-phone-on-face': 'approved',
    'main-character-energy:everyday-miss-the-bus': 'approved',
    'main-character-energy:everyday-take-a-selfie': 'approved',
    'main-character-energy:everyday-dance-in-elevator': 'approved',
    'main-character-energy:everyday-chase-a-mosquito': 'approved',
    'main-character-energy:feelings-celebrate-a-win': 'approved',
    'main-character-energy:feelings-fight-boredom': 'approved',
    'main-character-energy:feelings-fake-confidence': 'approved',
    'main-character-energy:feelings-lose-your-patience': 'approved',
    'main-character-energy:feelings-act-confused': 'approved',
    'main-character-energy:food-taste-a-lemon': 'approved',
    'main-character-energy:food-drop-the-ice-cream': 'approved',
    'main-character-energy:food-juggle-three-oranges': 'approved',
    'main-character-energy:food-crack-a-coconut': 'approved',
    'main-character-energy:dcl-life-enter-a-portal': 'approved',
    'main-character-energy:dcl-life-mint-a-wearable': 'approved',
    'main-character-energy:dcl-life-dance-at-the-plaza': 'approved',
    'main-character-energy:dcl-life-flex-a-rare-wearable': 'approved',
    'main-character-energy:dcl-life-vote-in-the-dao': 'approved',
    'main-character-energy:pop-become-a-superhero': 'approved',
    'main-character-energy:pop-fight-an-invisible-villain': 'approved',
    'main-character-energy:pop-meet-an-alien': 'approved',
    'main-character-energy:pop-cast-a-magic-spell': 'approved',
    'main-character-energy:pop-train-like-a-ninja': 'approved',
    'main-character-energy:awkward-wave-at-wrong-person': 'approved',
    'main-character-energy:awkward-trip-on-stage': 'approved',
    'main-character-energy:awkward-miss-a-high-five': 'approved',
    'main-character-energy:awkward-dance-after-music-stops': 'approved',
    'main-character-energy:awkward-drop-phone-on-face': 'approved',
    'fashionably-haunted:everyday-miss-the-bus': 'approved',
    'fashionably-haunted:everyday-take-a-selfie': 'approved',
    'fashionably-haunted:everyday-dance-in-elevator': 'approved',
    'fashionably-haunted:everyday-chase-a-mosquito': 'approved',
    'fashionably-haunted:everyday-dodge-the-rain': 'approved',
    'fashionably-haunted:feelings-celebrate-a-win': 'approved',
    'fashionably-haunted:feelings-fight-boredom': 'approved',
    'fashionably-haunted:feelings-fake-confidence': 'approved',
    'fashionably-haunted:feelings-lose-your-patience': 'approved',
    'fashionably-haunted:feelings-act-confused': 'approved',
    'fashionably-haunted:food-taste-a-lemon': 'approved',
    'fashionably-haunted:food-eat-spicy-noodles': 'approved',
    'fashionably-haunted:food-drop-the-ice-cream': 'approved',
    'fashionably-haunted:food-juggle-three-oranges': 'approved',
    'fashionably-haunted:food-crack-a-coconut': 'approved',
    'fashionably-haunted:dcl-life-enter-a-portal': 'approved',
    'fashionably-haunted:dcl-life-mint-a-wearable': 'approved',
    'fashionably-haunted:dcl-life-flex-a-rare-wearable': 'approved',
    'fashionably-haunted:dcl-life-vote-in-the-dao': 'approved',
    'fashionably-haunted:pop-fight-an-invisible-villain': 'approved',
    'fashionably-haunted:pop-meet-an-alien': 'approved',
    'fashionably-haunted:pop-cast-a-magic-spell': 'approved',
    'fashionably-haunted:pop-train-like-a-ninja': 'approved',
    'fashionably-haunted:awkward-wave-at-wrong-person': 'approved',
    'fashionably-haunted:awkward-trip-on-stage': 'approved',
    'fashionably-haunted:awkward-miss-a-high-five': 'approved',
    'fashionably-haunted:awkward-dance-after-music-stops': 'approved',
    'fashionably-haunted:awkward-drop-phone-on-face': 'approved',
    'final-encore:everyday-miss-the-bus': 'approved',
    'final-encore:everyday-take-a-selfie': 'approved',
    'final-encore:everyday-dance-in-elevator': 'approved',
    'final-encore:everyday-chase-a-mosquito': 'approved',
    'final-encore:everyday-dodge-the-rain': 'approved',
    'final-encore:feelings-fight-boredom': 'approved',
    'final-encore:feelings-fake-confidence': 'approved',
    'final-encore:feelings-lose-your-patience': 'approved',
    'final-encore:feelings-act-confused': 'approved',
    'final-encore:food-taste-a-lemon': 'approved',
    'final-encore:food-eat-spicy-noodles': 'approved',
    'final-encore:food-drop-the-ice-cream': 'approved',
    'final-encore:food-juggle-three-oranges': 'approved',
    'final-encore:food-crack-a-coconut': 'approved',
    'final-encore:dcl-life-enter-a-portal': 'approved',
    'final-encore:dcl-life-mint-a-wearable': 'approved',
    'final-encore:dcl-life-dance-at-the-plaza': 'approved',
    'final-encore:dcl-life-flex-a-rare-wearable': 'approved',
    'final-encore:dcl-life-vote-in-the-dao': 'approved',
    'final-encore:pop-become-a-superhero': 'approved',
    'final-encore:pop-fight-an-invisible-villain': 'approved',
    'final-encore:pop-meet-an-alien': 'approved',
    'final-encore:pop-cast-a-magic-spell': 'approved',
    'final-encore:pop-train-like-a-ninja': 'approved',
    'final-encore:awkward-trip-on-stage': 'approved',
    'final-encore:awkward-miss-a-high-five': 'approved',
    'final-encore:awkward-dance-after-music-stops': 'approved',
    'final-encore:awkward-drop-phone-on-face': 'approved'
  }
} as const

const CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL = {
  v: 1,
  seasonId: 'season-zero',
  revision: 3,
  updatedAt: 1_788_048_000_000,
  phraseIds: [] satisfies readonly PhraseId[]
} as const

const playablePhraseIds = new Set(PLAYABLE_DECK.map((phrase) => phrase.id))
if (
  new Set<string>(CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL.phraseIds).size !==
    CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL.phraseIds.length ||
  CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL.phraseIds.some((phraseId) => !playablePhraseIds.has(phraseId))
) {
  throw new Error('Invalid checked-in Season Zero decoy approval record')
}

const parsedRecord = parseSeasonModerationRecord(CHECKED_IN_SEASON_ZERO_MODERATION)
if (!parsedRecord) throw new Error('Invalid checked-in Season Zero moderation record')

const evaluatedRecord = evaluateSeasonModerationRecord(parsedRecord)
if (!evaluatedRecord.launchReady) throw new Error('Season Zero moderation record is not launch-ready')

export const SEASON_ZERO_MODERATION_RECORD = parsedRecord
export const SEASON_ZERO_MODERATION_EVALUATION = evaluatedRecord
export const SEASON_ZERO_DECOY_APPROVAL_RECORD = Object.freeze({
  ...CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL,
  phraseIds: Object.freeze([...CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL.phraseIds])
})
