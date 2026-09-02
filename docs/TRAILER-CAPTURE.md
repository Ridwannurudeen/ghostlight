# Ghostlight trailer capture plan

The 60-second cut is already storyboarded in [`docs/SUBMISSION.md`](SUBMISSION.md) as eight segments. This file is
the operational layer underneath it: what must be true before recording, in what order to create it, and which
on-screen label proves each shot landed.

Every mechanic below was read out of the deployed build (`c0abf00`, tag `release/friendzone-judging`, entity
`bafkreihblrzvm6t3flfwgjbmyybi5gs3dyyhw345iix3qc4nkc3ohlmiyu`), not from the held candidate. Where a rule comes
from code, the file and symbol are named so it can be rechecked.

## Do not film these - they are not in the deployed World

`HOUSE PRACTICE` and `RETRY CONNECTION` ship only in the held candidate `c49bf1d`. Both strings are absent from the
deployed `bin/index.js`. They must not appear in the trailer, the featuring text, or the submission copy.

## Hard prerequisites

**Three distinct named accounts.** Not two. `chooseCharadeFor` (`src/shared/pick.ts:64-73`) excludes any charade
authored by the requesting player, and the reply that turns a charade into a duet is delivered by `sendTo` to the
single player being served that charade (`src/server/server.ts:1454-1463`), not broadcast. So the author cannot
watch their own duet, the replier has already seen it, and a third account is required to film segment 7.

**At least two phones**, both on the released Decentraland mobile client, both signed in as named accounts. Guests
cannot author, reply, or appear on boards.

**Today's theme.** `themeForTimestamp` (`src/shared/config.ts:38-41`) rotates six themes by UTC day. The server
filters the eligible pool to the current show's phrase set before selection
(`src/server/server.ts:1550-1556`), so **a charade whose phrase is off-theme is not served at all** - it is not
merely deprioritised. Seed with phrases the authoring screen offers under the current theme.

| UTC date | Tonight's Show |
|---|---|
| 2026-09-02 | Pop Spectacles |
| 2026-09-03 | Awkward Moments |
| 2026-09-04 | Everyday Escapades |
| 2026-09-05 (judging opens) | Big Feelings |
| 2026-09-06 | Kitchen Capers |
| 2026-09-07 | Decentraland Life |
| 2026-09-08 | Pop Spectacles |

**A 60-second authoring cooldown per player** (`AUTHOR_COOLDOWN_SECONDS`, `src/shared/config.ts:9`). Budget for it
rather than being surprised by it.

## How selection actually resolves - the lever that makes this repeatable

For a signed-in player, the server serves, in order: waiting Ghost Mail for that recipient, then the live round
charade if the player is a participant, then `chooseCharadeFor`, then a House charade
(`src/server/server.ts:1527-1567`). `chooseCharadeFor` drops House content, the requester's own charades, the
immediately previous author's, and anything already seen, then sorts by **fewest total guesses**, then oldest.

Two consequences worth holding onto:

- A charade that has just been posted has zero guesses, so it sorts to the front for the next eligible viewer.
  Post it, and the other phone gets it.
- Seen IDs persist for the charade's whole 14-day life. **A phone cannot re-watch a charade to get a second take.**
  Rehearse on House content, then spend each real charade once.

## Pre-flight, before the first take

- Landscape. Do Not Disturb on. Notifications and incoming calls off. Screen at full brightness. Battery above 50%.
- Screen recording set to capture **game audio and on-screen taps**. `docs/DEVICE-CHECKLIST.md` requires both, and a
  silent capture cannot prove the audio design that carries the reveal.
- Record the app version, phone model, OS version, and UTC time before the first take.
- Rehearse the whole run once against House content so the real charades are not burned on a fumbled take.

## Pass 1 - seed the pool

Run this to completion before recording anything for segments 5 through 8. Nothing here may be synthesised; every
post must be a real person on a real phone.

1. **Account A** enters, decodes whatever it is served, and authors one charade on today's theme. Note the phrase.
2. Wait out the 60-second cooldown.
3. **Account B** enters. It is served A's charade first - it is the only zero-guess eligible item. B decodes it and
   then uses `ANSWER BACK` to record a three-emote reply. A's charade is now a duet.
4. **Account B** authors a second charade of its own on today's theme.
5. **Account A** enters again and authors a third. Three genuine current-theme charades now exist, one of them a
   duet, satisfying the release gate in `docs/SUBMISSION.md`.
6. **Account C has not been spent yet.** Keep it clean - it is the camera for segments 2, 3 and 7.

If the server has slept since, re-enter once from a fresh named account first and confirm the real charades come
back rather than a House-only venue. That cold-rehydration proof is a separate release gate and this is the cheapest
moment to collect it.

## Pass 2 - capture, mapped to the eight segments

Segment boundaries and content come from `docs/SUBMISSION.md`. Below is what the operator should watch for.

**The full eight-second reveal fires only on the first reveal of a visit or set, a finale, or a title/stamp
milestone** (`docs/DEVICE-CHECKLIST.md`, reveal section). Later reveals in the same visit are adaptive and shorter.
Segment 4 needs the complete sequence, so **it must be the first reveal after entering** - if you decode something
else first to warm up, the shot is gone until the next visit.

| Segment | Account | Watch for on screen |
|---|---|---|
| 0:00-0:05 Arrival | C | Foyer, movement joystick visible, `HOW TO PLAY` top-right |
| 0:05-0:13 Tonight's Show | C | Marquee reading the current theme, doors opening, performer taking the stage |
| 0:13-0:21 Decode | C | Three emotes complete, three answer cards, one deliberate tap |
| 0:21-0:29 Reveal | C | **First reveal of the visit.** Answers lock and tick starts at 0.0; pose freezes and camera pushes ~1.2; sting and wrong answers fade ~2.0; verdict ~2.6; bow with applause or gasp ~4.0; stats ~6.0; reset ~7.5 |
| 0:29-0:41 Leave a ghost | A or B | Assigned phrase, three ordered beats, `UNDO LAST BEAT` available, `PREVIEW` runs to completion, `POST` only then enabled |
| 0:41-0:46 Share | same | Posted confirmation, `COPY INVITE` success state |
| 0:46-0:54 Answer back | C | Both avatars alternating on stage - this is the seeded duet from Pass 1 step 3 |
| 0:54-1:00 Return reason | A or B | `Your returning audience report is ready.`, the `{got} OF {tried} UNDERSTOOD YOUR GHOST` line, `ENTER THE THEATER`, then `TODAY'S BOARDS` |

Every label above was confirmed present in the deployed bundle.

## If three accounts are not available before the lock

Shoot segments 1 through 6 and 8 as written; they need one named account and one phone. Leave segment 7 out rather
than staging it, and let the cut run short. A 50-second honest trailer beats a 60-second one with a fabricated duet,
and `docs/AUDIT.md` records synthesised engagement as the one thing this project will not do.

## This capture doubles as device evidence

Shot landscape, with audio and visible taps, on the deployed build, one uninterrupted take per device, this run also
satisfies the evidence requirements in `docs/DEVICE-CHECKLIST.md` for cold start and readiness, the opening, the
reveal choreography, authoring and posting, and the duet. Keep the raw recordings, not just the edited cut, and note
the commit and UTC time against each.

## Honesty rules

- If House content appears, keep its House label visible in frame. It is the honest failure floor.
- No staged counts, no synthesised visitors, guesses, replies, performances, or boards.
- Real-device capture only. No desktop preview, no editor footage, no screen simulator.
- Content expires after 14 days, so the pool must be renewed with current-theme posts through 11 September.
