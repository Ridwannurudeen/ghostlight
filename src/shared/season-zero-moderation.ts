import { DECK, type PhraseId } from './deck'
import { evaluateSeasonModerationRecord, parseSeasonModerationRecord } from './seasons'

const CHECKED_IN_SEASON_ZERO_MODERATION = {
  v: 1,
  seasonId: 'season-zero',
  revision: 1,
  updatedAt: 1_787_961_600_000,
  decisions: {
    'first-impressions:everyday-wake-up-late': 'approved',
    'first-impressions:everyday-miss-the-bus': 'approved',
    'first-impressions:everyday-find-lost-keys': 'approved',
    'first-impressions:everyday-take-a-selfie': 'approved',
    'first-impressions:everyday-greet-a-neighbor': 'approved',
    'first-impressions:everyday-choose-an-outfit': 'approved',
    'first-impressions:everyday-forget-a-password': 'approved',
    'first-impressions:feelings-hide-embarrassment': 'approved',
    'first-impressions:awkward-hold-door-too-long': 'approved',
    'first-impressions:feelings-fake-confidence': 'approved',
    'first-impressions:feelings-fall-in-love': 'approved',
    'first-impressions:feelings-act-confused': 'approved',
    'first-impressions:feelings-get-starstruck': 'approved',
    'first-impressions:dcl-life-dance-at-the-plaza': 'approved',
    'first-impressions:dcl-life-enter-a-portal': 'approved',
    'first-impressions:dcl-life-meet-your-digital-twin': 'approved',
    'first-impressions:dcl-life-take-an-avatar-selfie': 'approved',
    'first-impressions:dcl-life-wave-at-an-npc': 'approved',
    'first-impressions:dcl-life-explore-a-new-world': 'approved',
    'first-impressions:pop-walk-the-red-carpet': 'approved',
    'first-impressions:pop-meet-an-alien': 'approved',
    'first-impressions:pop-reveal-secret-identity': 'approved',
    'first-impressions:awkward-wave-at-wrong-person': 'approved',
    'first-impressions:awkward-forget-someones-name': 'approved',
    'first-impressions:awkward-get-stuck-handshaking': 'approved',
    'first-impressions:awkward-enter-wrong-room': 'approved',
    'first-impressions:awkward-miss-a-high-five': 'approved',
    'first-impressions:everyday-dodge-the-rain': 'approved',
    'first-impressions:awkward-trip-on-stage': 'approved',
    'first-impressions:awkward-pretend-to-know-song': 'approved',
    'main-character-energy:feelings-celebrate-a-win': 'approved',
    'main-character-energy:feelings-fake-confidence': 'approved',
    'main-character-energy:feelings-burst-with-excitement': 'approved',
    'main-character-energy:feelings-lose-your-patience': 'approved',
    'main-character-energy:feelings-feel-proud': 'approved',
    'main-character-energy:feelings-get-starstruck': 'approved',
    'main-character-energy:dcl-life-mint-a-wearable': 'approved',
    'main-character-energy:dcl-life-dance-at-the-plaza': 'approved',
    'main-character-energy:dcl-life-flex-a-rare-wearable': 'approved',
    'main-character-energy:dcl-life-build-a-dream-house': 'approved',
    'main-character-energy:dcl-life-claim-a-free-wearable': 'approved',
    'main-character-energy:dcl-life-chase-an-airdrop': 'approved',
    'main-character-energy:dcl-life-crash-a-virtual-party': 'approved',
    'main-character-energy:pop-sing-into-a-microphone': 'approved',
    'main-character-energy:pop-become-a-superhero': 'approved',
    'main-character-energy:pop-fight-an-invisible-villain': 'approved',
    'main-character-energy:pop-walk-the-red-carpet': 'approved',
    'main-character-energy:pop-win-a-talent-show': 'approved',
    'main-character-energy:pop-cast-a-magic-spell': 'approved',
    'main-character-energy:pop-dodge-a-laser': 'approved',
    'main-character-energy:pop-train-like-a-ninja': 'approved',
    'main-character-energy:everyday-take-a-selfie': 'approved',
    'main-character-energy:pop-meet-an-alien': 'approved',
    'main-character-energy:pop-escape-a-zombie': 'approved',
    'main-character-energy:pop-rule-a-kingdom': 'approved',
    'main-character-energy:dcl-life-vote-in-the-dao': 'approved',
    'main-character-energy:pop-reveal-secret-identity': 'approved',
    'main-character-energy:awkward-trip-on-stage': 'approved',
    'main-character-energy:awkward-dance-after-music-stops': 'approved',
    'main-character-energy:awkward-get-caught-singing': 'approved',
    'fashionably-haunted:everyday-take-a-selfie': 'approved',
    'fashionably-haunted:pop-become-a-superhero': 'approved',
    'fashionably-haunted:everyday-choose-an-outfit': 'approved',
    'fashionably-haunted:feelings-fear-a-spider': 'approved',
    'fashionably-haunted:feelings-hide-embarrassment': 'approved',
    'fashionably-haunted:feelings-fake-confidence': 'approved',
    'fashionably-haunted:feelings-feel-jealous': 'approved',
    'fashionably-haunted:feelings-feel-proud': 'approved',
    'fashionably-haunted:feelings-get-starstruck': 'approved',
    'fashionably-haunted:dcl-life-enter-a-portal': 'approved',
    'fashionably-haunted:dcl-life-mint-a-wearable': 'approved',
    'fashionably-haunted:dcl-life-dance-at-the-plaza': 'approved',
    'fashionably-haunted:dcl-life-meet-your-digital-twin': 'approved',
    'fashionably-haunted:dcl-life-flex-a-rare-wearable': 'approved',
    'fashionably-haunted:dcl-life-claim-a-free-wearable': 'approved',
    'fashionably-haunted:dcl-life-take-an-avatar-selfie': 'approved',
    'fashionably-haunted:dcl-life-attend-metaverse-wedding': 'approved',
    'fashionably-haunted:dcl-life-crash-a-virtual-party': 'approved',
    'fashionably-haunted:dcl-life-find-a-secret-room': 'approved',
    'fashionably-haunted:pop-walk-the-red-carpet': 'approved',
    'fashionably-haunted:pop-escape-a-zombie': 'approved',
    'fashionably-haunted:pop-cast-a-magic-spell': 'approved',
    'fashionably-haunted:pop-solve-a-mystery': 'approved',
    'fashionably-haunted:pop-join-a-boy-band': 'approved',
    'fashionably-haunted:pop-fight-an-invisible-villain': 'approved',
    'fashionably-haunted:pop-ghost-party': 'approved',
    'fashionably-haunted:pop-reveal-secret-identity': 'approved',
    'fashionably-haunted:pop-meet-an-alien': 'approved',
    'fashionably-haunted:pop-sing-into-a-microphone': 'approved',
    'fashionably-haunted:awkward-trip-on-stage': 'approved',
    'final-encore:everyday-take-a-selfie': 'approved',
    'final-encore:everyday-dance-in-elevator': 'approved',
    'final-encore:feelings-celebrate-a-win': 'approved',
    'final-encore:feelings-burst-with-excitement': 'approved',
    'final-encore:feelings-feel-proud': 'approved',
    'final-encore:feelings-get-starstruck': 'approved',
    'final-encore:pop-become-a-superhero': 'approved',
    'final-encore:pop-cast-a-magic-spell': 'approved',
    'final-encore:food-flip-a-pancake': 'approved',
    'final-encore:pop-dodge-a-laser': 'approved',
    'final-encore:food-juggle-three-oranges': 'approved',
    'final-encore:dcl-life-vote-in-the-dao': 'approved',
    'final-encore:dcl-life-dance-at-the-plaza': 'approved',
    'final-encore:dcl-life-tip-a-performer': 'approved',
    'final-encore:dcl-life-take-an-avatar-selfie': 'approved',
    'final-encore:dcl-life-attend-metaverse-wedding': 'approved',
    'final-encore:dcl-life-crash-a-virtual-party': 'approved',
    'final-encore:pop-walk-the-red-carpet': 'approved',
    'final-encore:pop-win-a-talent-show': 'approved',
    'final-encore:pop-sing-into-a-microphone': 'approved',
    'final-encore:pop-fight-an-invisible-villain': 'approved',
    'final-encore:pop-join-a-boy-band': 'approved',
    'final-encore:pop-ghost-party': 'approved',
    'final-encore:pop-reveal-secret-identity': 'approved',
    'final-encore:awkward-trip-on-stage': 'approved',
    'final-encore:awkward-laugh-at-bad-time': 'approved',
    'final-encore:awkward-miss-a-high-five': 'approved',
    'final-encore:awkward-dance-after-music-stops': 'approved',
    'final-encore:awkward-get-caught-singing': 'approved',
    'final-encore:awkward-pretend-to-know-song': 'approved'
  }
} as const

const CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL = {
  v: 1,
  seasonId: 'season-zero',
  revision: 1,
  updatedAt: 1_787_961_600_000,
  phraseIds: ['food-burn-the-toast', 'food-order-a-pizza'] satisfies readonly PhraseId[]
} as const

const canonicalPhraseIds = new Set(DECK.map((phrase) => phrase.id))
if (
  new Set<string>(CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL.phraseIds).size !==
    CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL.phraseIds.length ||
  CHECKED_IN_SEASON_ZERO_DECOY_APPROVAL.phraseIds.some((phraseId) => !canonicalPhraseIds.has(phraseId))
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
