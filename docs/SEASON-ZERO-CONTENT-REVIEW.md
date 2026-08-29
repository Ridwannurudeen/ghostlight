# Season Zero Content Review

## Reviewed snapshot

- Season: `season-zero`
- Moderation schema: version 1
- Ledger revision: 1
- Ledger timestamp: `2026-08-29T00:00:00.000Z`
- Schedule: four weeks, 30 references per week
- Final decisions: 120 approved, 0 quarantined, 0 pending

The checked-in ledger is an explicit 120-entry record. It is not generated from the season schedule. Module loading
parses the record through the strict schema and evaluates moderation, per-week prompt counts, the aggregate quarantine
rate, and approved House fallback coverage. The record is exported only when every launch gate passes.

## Review criteria

Each scheduled reference was checked for:

1. membership in the canonical 120-phrase deck;
2. uniqueness within its scheduled week;
3. fit with the named weekly theme;
4. a recognizable action or situation that can be performed with the fixed emote vocabulary;
5. availability of canonical English, Spanish, and Portuguese phrase text;
6. suitability for the curated, non-free-text game surface; and
7. retention of at least one approved House fallback phrase in every week.

## Independent passes

One pass applied the criteria to all 120 scheduled references and approved the original schedule. A stricter independent
pass identified 22 references for replacement. Two replacement maps were then checked against the canonical deck,
weekly uniqueness, theme fit, and House coverage; the cross-check changed five proposed mappings before the final map
was accepted.

## Accepted replacements

| Week | Removed reference | Approved replacement |
|---|---|---|
| First Impressions | `feelings-calm-your-nerves` | `awkward-hold-door-too-long` |
| First Impressions | `feelings-suspect-a-surprise` | `feelings-fall-in-love` |
| First Impressions | `feelings-hold-in-a-laugh` | `dcl-life-dance-at-the-plaza` |
| First Impressions | `awkward-wear-shirt-backwards` | `everyday-dodge-the-rain` |
| First Impressions | `awkward-sit-in-wrong-chair` | `awkward-trip-on-stage` |
| Main Character Energy | `dcl-life-trade-digital-art` | `pop-sing-into-a-microphone` |
| Main Character Energy | `pop-ride-a-space-rocket` | `pop-dodge-a-laser` |
| Main Character Energy | `pop-direct-a-blockbuster` | `everyday-take-a-selfie` |
| Main Character Energy | `pop-time-travel` | `pop-meet-an-alien` |
| Main Character Energy | `pop-survive-a-dinosaur` | `pop-escape-a-zombie` |
| Main Character Energy | `pop-summon-a-dragon` | `dcl-life-vote-in-the-dao` |
| Fashionably Haunted | `everyday-dance-in-elevator` | `pop-become-a-superhero` |
| Fashionably Haunted | `feelings-fall-in-love` | `feelings-fear-a-spider` |
| Fashionably Haunted | `pop-summon-a-dragon` | `pop-fight-an-invisible-villain` |
| Fashionably Haunted | `awkward-wear-shirt-backwards` | `pop-meet-an-alien` |
| Fashionably Haunted | `awkward-get-caught-singing` | `pop-sing-into-a-microphone` |
| Fashionably Haunted | `awkward-pretend-to-know-song` | `awkward-trip-on-stage` |
| Final Encore | `feelings-hold-in-a-laugh` | `pop-become-a-superhero` |
| Final Encore | `food-bake-a-cake` | `pop-cast-a-magic-spell` |
| Final Encore | `food-share-the-popcorn` | `pop-dodge-a-laser` |
| Final Encore | `food-serve-breakfast` | `dcl-life-vote-in-the-dao` |
| Final Encore | `pop-direct-a-blockbuster` | `pop-fight-an-invisible-villain` |

## Final evidence

Automated checks compare the ledger's keys with the current scheduled references and require exactly 120 unique matches.
They also require all 120 decisions to be `approved`, 30 approved references in each week, a complete review with a 0%
quarantine rate, and approved House fallback coverage in all four weeks. The parsed record and its evaluation are deeply
immutable.

The ledger is snapshot evidence, not an automatic approval policy. A reference added to or substituted in a schedule
copy has no decision and remains ineligible. Any production schedule change therefore requires an explicit decision,
ledger revision, updated timestamp, and another passing review.
