# Ghost Charades — Submission Packet

## Submission timing and judging facts

This section is for submission preparation; the paste-ready project copy begins below.

- The published deadline string is `2026/09/04 01:00`; its timezone is unstated. The internal release lock is
  Tue 2 Sep at 18:00.
- Judges play alone in the Decentraland mobile app from Sep 5–11.
- The seven official criteria are Mobile-First Experience; Social Value; Mobile UX and Accessibility;
  Performance and Optimization; Creativity and Originality; Retention and Discovery Value; and Overall
  Execution.
- Ties prioritize Mobile-First Experience, Retention and Discovery Value, and Overall Execution.
- The runtime invite target is `ghostcharades.dcl.eth`; the owner must buy and configure that NAME before the
  World link is final.

## DoraHacks submission copy

### Project title

Ghost Charades

### Hook

Ghost Charades turns Decentraland mobile's missing chat into the game: decode a stranger's three-emote ghost,
then leave a performance for the next visitor.

### Project description

Ghost Charades is a mobile-first, voice-free social World built around communication through avatar
performance. A visitor watches a previous player's saved Decentraland avatar act out a phrase, chooses between
three answers, and sees an eight-second theatrical reveal. The visitor can then choose a phrase from the curated
deck and post a three-emote performance for whoever arrives next. A clearly labelled House ghost keeps the solo
loop playable before real performances exist and is excluded from player statistics and boards.

Tonight's Show changes by UTC day across six themes and prioritizes matching charades without blocking the
queue when a theme has no eligible performance. Answer-Back Duets let a decoder perform a second take on the
same phrase; future visitors watch both avatars alternate. When two or more players are present, the shared
charade becomes a first-correct live race.

### How it was designed and optimized for mobile

Every game action is an on-screen button with a minimum 96 px touch target. The UI renders inside the mobile
client's interactable safe area on a fixed 1600 × 720 virtual canvas. Ghost Charades hides the client's native
action buttons because the scene does not use them, keeps the movement joystick available, and never requires a
tap on a 3D object. Answers, verdicts, progress, and errors use explicit text; sound and stage colour reinforce
the result instead of carrying it alone.

The generated theater kit contains 15 GLBs totalling 6,324 triangles and five material names. Automated asset
checks enforce per-model and whole-scene triangle limits, texture dimensions, sound duration and size limits,
the absence of Draco, and the total asset budget. Runtime avatar clones are capped at eight and recent audience
members spawn at no more than three per second. The scene uses emissive material changes and tweens instead of
particles or dynamic lights.

### How it encourages social interaction

The mobile client has no DMs, voice, or scene chat, so the performance is the message. The authoritative
Multiplayer Server captures each author's real avatar look, wearables, profile name, and three chosen emotes,
then serves that performance to another player later. Up to six recent visitors appear in the theater audience;
live visitors can react through avatar emotes, and two or more concurrent visitors race on the same charade.

Social activity survives an empty room. Authors return to a “Since you left” report showing how many people
tried their performance, how many solved it, and how many answered back. One decoder can attach an Answer-Back
Duet to a charade, so the next visitor watches a conversation expressed entirely through two avatar
performances. The House fallback is always labelled and never contributes to participation counts.

### Why players return, replay, share, and invite

Each UTC day brings a new Tonight's Show theme. For a signed-in player, three decodes plus one authored charade
earns a server-stored daily stamp. Verified participation unlocks Understudy, Scene Stealer, and Ghostlight
Legend titles with visible top-hat, mask, and trophy props. The playbill shows recent performers, and the day's
hardest real charade becomes Ghost of the Night. The server persists performances and duets; signed-in player
scores, stamps, titles, and return reports make each visit a continuation rather than a reset.

Players can replay a performance before guessing, make their own version after the reveal, or answer back to
the same phrase. After posting, Copy Invite copies a direct Decentraland World link with “Can you decode my
ghost?” so the social object being shared is the player's own performance, not a generic leaderboard. No
engagement, visitor, guess, or board entry is fabricated.

### The mechanic in five lines

1. Watch a previous player's Decentraland avatar perform a three-emote charade.
2. Choose the phrase from three answer cards and watch the eight-second stage verdict.
3. Take a dealt phrase, select three emotes in order, preview them, and post your ghost.
4. Answer back after a reveal so later visitors watch both performers alternate on the same phrase.
5. If another player is present, race to become the first correct decoder of the shared performance.

### Measured mobile result

`<MEASURED: High-profile Performance score on the tested phone, with device model, OS version, and test date>`

### Links

- World: `<WORLD LINK>`
- Repository: [Ghost Charades source repository](../)
- License: [MIT](../LICENSE)

### Team

Ridwan Nurudeen

## Screenshot shot list

Capture all six in the Decentraland mobile app with real player data. If the House fallback appears, keep its
House label visible; do not stage engagement counts.

1. Opening Night: foyer camera, Tonight's Show marquee, generated doors, and the mobile movement control visible.
2. Decode: a real player's ghost mid-emote beside the three large answer cards, with no control overlap.
3. Reveal: the push-in camera at the hit or miss verdict, including answer text, lighting shift, and result card.
4. Authoring: a dealt phrase with exactly three ordered emotes selected and Preview/Post controls visible.
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
- **0:29–0:39 — Leave a ghost:** show the dealt phrase, three ordered emote taps, Preview, and Post on the phone.
- **0:39–0:46 — Share:** show the posted confirmation and Copy Invite success state.
- **0:46–0:54 — Answer back:** cut to a real replied charade and hold on both avatars alternating their
  performances.
- **0:54–1:00 — Return reason:** finish on the real playbill/boards and an earned stamp, title, or return report;
  end on the World name in the mobile app.
