# Season Zero Content Review

## Reviewed snapshot

- Season: `season-zero`
- Moderation schema: version 1
- Ledger revision: 3
- Ledger timestamp: `2026-08-30T00:00:00.000Z`
- Playable release deck: 30 phrases, five per theme
- Schedule: four weeks, 28 references per week
- Final decisions: 112 approved, 0 quarantined, 0 pending
- Separate decoy-only approvals: 0

The repository retains 120 historical phrase IDs and translations, but only the 30-entry `PLAYABLE_DECK` is
eligible for new performances and answer sets. Every playable phrase defines three ordered beats—START, ACTION,
and REACTION—with exactly two reviewed emote choices per beat.

The checked-in ledger is an explicit 112-entry week-and-phrase record. It is not generated from the season
schedule. Module loading parses the record through the strict schema and evaluates moderation completeness,
per-week prompt counts, quarantine rate, and approved House fallback coverage. The record is exported only when
every launch gate passes.

## Review criteria

Each scheduled reference was checked for:

1. membership in the 30-phrase playable release deck;
2. uniqueness within its scheduled week;
3. fit with its named weekly show;
4. a recognizable action or situation expressible through the fixed Decentraland emote vocabulary;
5. a valid ordered performance with one allowed START, ACTION, and REACTION choice and no repeated emote;
6. availability of canonical English, Spanish, and Portuguese phrase text;
7. two same-theme answer decoys whose first words differ and whose ordered emote overlap cannot make the
   performance ambiguous; and
8. retention of at least one approved House fallback phrase in every week.

## Schedule rotation

Each week contains 28 of the 30 playable phrases. Adjacent weeks remove exactly two phrases and introduce exactly
two others, so the schedule changes without weakening the reviewed answer pool. Across all four weeks, every
playable phrase is explicitly reviewed. Because the reviewed union already covers the complete playable deck,
no separate decoy-only approval is required.

## Final evidence

Automated checks require exactly 112 unique ledger keys, 28 approved references in each week, four distinct weekly
compositions, an exact two-out/two-in adjacent rotation, a complete review with a 0% quarantine rate, approved House
fallback coverage in every week, and an empty immutable decoy-only record. They also exhaustively verify every
allowed performance against its two generated answer decoys and reject repeated, off-beat, or legacy-only
performances. The parsed records and moderation evaluation are deeply immutable.

The ledger is snapshot evidence, not an automatic approval policy. A reference added to or substituted in a
schedule copy has no decision and remains ineligible. Any production schedule change therefore requires an
explicit decision, ledger revision, updated timestamp, and another passing review.
