# Ghostlight — Submission Packet

## Submission timing and judging facts

This section is for submission preparation; the paste-ready project copy begins below.

- The published deadline string is `2026/09/04 01:00`; its timezone is unstated. The internal release lock is
  Tue 2 Sep at 18:00.
- Judges play alone in the Decentraland mobile app from Sep 5–11.
- The seven official criteria are Mobile-First Experience; Social Value; Mobile UX and Accessibility;
  Performance and Optimization; Creativity and Originality; Retention and Discovery Value; and Overall
  Execution.
- Ties prioritize Mobile-First Experience, Retention and Discovery Value, and Overall Execution.
- The candidate is configured for `ghostlight.dcl.eth`; the owner must prove control of that NAME before the
  World link is final.

## Hard release gates - do not deploy or submit

**Gate status recorded 2026-09-02, revised after the afternoon deploy.** The submitted build is the deployed World,
tagged `release/2026-09-02` (`c905fe0`, scene code `c49bf1d`), deployed 2026-09-02T16:53:18Z as entity
`bafkreihydi7utkj5quq5y6tzpf7sw7neurw7lvcnjqqoyyne2bhqscanhy`; the previous build, `release/friendzone-judging`
(`c0abf00`), is the rollback target, and Sep 3-11 is a deploy freeze. Closed with evidence: the scene-configuration
gate below, verified against that entity after upload (`authoritativeMultiplayer: true`, no `fixedAdapter`, no
`placesConfig`); control of `ghostlight.dcl.eth`, evidenced by the deployment being accepted under the NAME by the
owner's wallet; and repository publication, with the absolute repository, licence and World links in the Links
section below confirmed to return HTTP 200. Still open and owner-only: the genuine-content and cold-rehydration
gates, daily pool renewal through judging, `docs/DEVICE-CHECKLIST.md` on the deployed build, the recorded
High-profile Performance measurement at line 143, and the on-device trailer.

- Confirm ownership of `ghostlight.dcl.eth`; verify the exact release candidate retains
  `worldConfiguration.name: "ghostlight.dcl.eth"`, `authoritativeMultiplayer: true`, and no `fixedAdapter` or
  `placesConfig.optOut`.
- Publish the repository first. Replace the repository/licence preparation note below with working absolute public
  HTTPS URLs to the repository and `LICENSE`; relative links are prohibited in the submitted copy. Done
  2026-09-02: the repository is public and the Links section carries verified absolute URLs.
- In production, use genuine accounts to create at least three distinct current-theme charades less than 14 days
  old and at least one genuine Answer-Back duet. Never synthesize a visitor, guess, reply, performance, or board.
- After a real server sleep, use a fresh named account to prove the production store rehydrates and serves the real
  charades and duet instead of a House-only venue. Record the authors, themes, UTC ages, and duet status.
- Check the deployed pool daily through judging and renew genuine current-theme content before the 14-day serving
  window expires. House is the honest failure floor, not a release-ready seed.
- For every local phone run, start one preview with `--no-client`, generate the deep link with
  `node tools/mobile-preview.mjs`, verify the printed host is the phone-reachable physical LAN adapter, open its
  `/about` URL on the phone, and record the Decentraland app reaching `ready`. The SDK's automatic QR, a laptop-only
  endpoint check, or a rendered QR is not real-phone evidence.
- Complete every unchecked item in `docs/DEVICE-CHECKLIST.md` on the exact deployed commit before final media or
  submission approval.

The paste-ready copy below carries no “Measured mobile result” section: no High-profile Performance score,
device model, OS version, or diagnostics frame proxy was recorded on 2026-09-02. Reinstate that section only from a
real `COPY DIAGNOSTICS` block and the app's own Performance percentage; do not paste an estimate.

## DoraHacks submission copy

### Project title

Ghostlight

### Hook

Ghostlight turns Decentraland mobile's missing chat into the game: decode a stranger's three-emote ghost,
then leave a performance for the next visitor.

### Project description

Ghostlight is a mobile-first, voice-free social World built around communication through avatar
performance. A visitor watches a previous player's saved Decentraland avatar act out three ordered clues—START,
ACTION, and REACTION—for one assigned phrase. The three answer cards remain locked through the first complete
sequence, and exactly one is true. The authoritative server independently rejects a first guess before the
7.5-second sequence deadline, including in a live race. The visitor can then choose a phrase from the curated
30-phrase playable deck, select one of two validated emotes for each beat, watch a complete preview, and post it for
whoever arrives next. One of six clearly labelled House ghosts keeps
the solo loop playable before real performances exist and is excluded from player statistics and boards.

Tonight's Show changes by UTC day across six themes and prioritizes matching charades without blocking the
queue when a theme has no eligible performance. Answer-Back Duets let a decoder perform a second take on the
same phrase; future visitors watch both avatars alternate. When two or more players are present, the shared
charade becomes a first-correct live race. Performances remain in the selectable pool for 14 days, so the release
checklist requires genuine current-theme content to be renewed throughout judging.

Signed-in players can also choose a real recent performer and send a persisted Ghost Mail that stays outside the
public queue and boards and is served only when its recipient returns. English, Spanish, and Portuguese clients
render the same canonical phrase and answer IDs in their own language. The release gameplay deck contains 30
curated phrases; all 120 historical phrase IDs and translations remain available for stored-content compatibility.

### How it was designed and optimized for mobile

Every custom game action is an on-screen button with a minimum 96 px source-layout target. The UI renders inside
the mobile client's interactable safe area on a fixed 1600 × 720 virtual canvas; the real-device gate separately
checks physical scaling and thumb reach. Ghostlight hides the client's native action buttons because the scene does
not use them, keeps the movement joystick available, and never requires a tap on a 3D object. Answers, verdicts,
progress, and errors use explicit text; sound and stage colour reinforce
the result instead of carrying it alone. No screen exposes more than five game buttons: authoring separates phrase,
START/ACTION/REACTION selection, and confirmation, keeps Post unavailable until the complete preview finishes, and
replaces secondary actions with live reactions when opened. Starting preview playback alone does not unlock Post.

A five-control Settings panel offers English, Spanish, Portuguese, full/quiet/off sound, reduced motion, and 20%
larger text without typing. Reduced motion replaces the eight-second camera- and tween-heavy reveal with a
three-second result path while retaining the explicit verdict, sound, statistics, and progress. Settings apply for
the current visit.

The generated asset library contains 15 GLBs totalling 6,324 unique triangles and five material names. The live
theater instantiates 11,664 authored triangles across two declared parcels, below their combined 20,000-triangle
budget. Automated checks derive the exact `createTheater()` instance counts, enforce the parcel budget, texture
dimensions, gapless room-tone metadata and boundary quality, sound size limits, the absence of Draco, and the total
asset budget. Runtime avatar clones are capped at eight and recent audience members spawn at no more than three per
second. Reward props retain only the 16 nearest titled visitors plus one reusable stage slot; even the conservative
all-trophy peak is 16,492 authored triangles and 79 app-created entities. The scene uses emissive material changes
and tweens instead of particles or dynamic lights.

### How it encourages social interaction

The mobile client has no DMs, voice, or scene chat, so the performance is the message. The authoritative
Multiplayer Server captures each author's real avatar look, wearables, profile name, and three chosen emotes,
then serves that performance to another player later. Up to six recent visitors appear in the theater audience.
Players watching an active live round can press Laugh, Gasp, or Applause; a real press triggers one local avatar
emote and stamp while the server rate-limits the address and relays the reaction only to the other players present.
Two or more concurrent visitors race on the same charade.

Social activity survives an empty room. Authors return to a report showing how many players understood their ghost,
alongside Answer-Back replies and waiting Ghost Mail. Ghost Mail lets a signed-in player target a real recent
performer without free text; it stays out of the public pool and boards, is delivered only to that recipient, and can
receive the recipient's Answer-Back. The House fallback is always labelled and never contributes to participation
counts.

### Why players return, replay, share, and invite

Each UTC day brings a new Tonight's Show theme. For a signed-in player, three decodes plus one authored charade
earns a server-stored daily stamp. Verified participation unlocks Understudy, Scene Stealer, and Ghostlight
Legend titles with visible top-hat, mask, and trophy props. The playbill shows recent performers. Among performances
with at least three guesses, Crowd Pleaser ranks the one closest to a 60% solve rate, breaking ties by audience size,
and its author becomes Ghost of the Night. If none qualifies, there is no winner. The server persists performances
and duets; signed-in player scores, stamps, titles, private Ghost Mail, and return reports make each visit a
continuation rather than a reset.

Players can replay a performance before guessing, make their own version after the reveal, or answer back to
the same phrase. After posting, Copy Invite copies `Join me for Ghostlight:` plus the Decentraland World
URL. The server still selects the friend's eligible performance; the invite does not claim to target the inviter's
charade. No engagement, visitor, guess, or board entry is fabricated.

### The mechanic in five lines

1. Watch a previous player's Decentraland avatar perform START, ACTION, and REACTION for one secret phrase.
2. After all three clues, choose the one true phrase from three answer cards and watch the stage verdict.
3. Take a dealt phrase, choose one validated emote per beat, watch the full preview, and post your ghost.
4. Answer back after a reveal, or send a private Ghost Mail to a recent real performer.
5. If another player is present, race for first correct while spectators send server-relayed reaction stamps.

### Links

- World: https://decentraland.org/jump/?realm=ghostlight.dcl.eth
- Repository: https://github.com/Ridwannurudeen/ghostlight
- Licence: https://github.com/Ridwannurudeen/ghostlight/blob/main/LICENSE (MIT)

### Team

Ridwan Nurudeen

## Screenshot shot list

Capture all six in the Decentraland mobile app with real player data. If the House fallback appears, keep its
House label visible; do not stage engagement counts.

1. Opening Night: foyer camera, Tonight's Show marquee, generated doors, and the mobile movement control visible.
2. Decode: a real player's ghost mid-emote beside the three large answer cards, with no control overlap.
3. Reveal: the push-in camera at the hit or miss verdict, including answer text, lighting shift, and result card.
4. Authoring: the confirmation phase after exactly three ordered emotes, with Preview/Post controls visible.
5. Answer-Back Duet: both real player avatars on stage while their three-emote sequences alternate.
6. Retention: the recent-performer playbill and boards, with a verified title/reward prop or daily stamp visible
   only if it was earned in the captured run.

## Real-device gameplay video shot list — 60 seconds

Use only Decentraland mobile-app screen recordings from a real device. Hard cuts may join real gameplay states;
do not use desktop preview/editor footage, synthetic activity, or unearned progress.

- **0:00–0:05 — Arrival:** enter the World in the mobile app; hold long enough to establish the generated foyer
  and on-screen mobile controls.
- **0:05–0:13 — Tonight's Show:** capture the daily marquee, doors opening, camera move, and the performer taking
  the stage.
- **0:13–0:21 — Decode:** show all three emotes, the three answer cards, and one deliberate answer tap.
- **0:21–0:29 — Reveal:** keep the complete eight-second verdict on screen: locked answers, camera push, lighting,
  sound, audience reaction, bow, and progress.
- **0:29–0:41 — Leave a ghost:** show the dealt phrase, three ordered emote taps, the uninterrupted complete Preview,
  and Post unlocking only after the final beat on the phone.
- **0:41–0:46 — Share:** show the posted confirmation and Copy Invite success state.
- **0:46–0:54 — Answer back:** cut to a real replied charade and hold on both avatars alternating their
  performances.
- **0:54–1:00 — Return reason:** finish on the real playbill/boards and an earned stamp, title, or return report;
  end on the World name in the mobile app.
