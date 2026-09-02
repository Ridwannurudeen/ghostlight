<div align="center">
  <h1>Ghostlight</h1>
  <p><strong>Decode another player's three-emote performance, then leave one for the next visitor.</strong></p>
  <p>A mobile-first social World built with Decentraland SDK7 and its authoritative Multiplayer Server.</p>
</div>

## Concept

Ghostlight turns player avatars into asynchronous performers. The server records a player's avatar look,
phrase, and ordered emote sequence; later visitors watch that ghost on a theater stage and choose between three
answers. The core loop uses performance instead of free-text input and does not depend on DMs, voice, or scene
chat.

When no eligible player performance exists, the server serves one of six clearly labelled `HOUSE GHOST`
performances spanning all six themes. Signed-in public House guesses advance personal decoded, first-try-correct,
daily, and revision progression. House content remains excluded from charade statistics, boards, author
notifications, and live winners; guest and Ghost Mail guesses remain excluded from progression.

## Game loop

1. Enter the theater. A skippable four-second cold open runs once per client session while the authoritative server
   prepares the first performance. Its overlay closes at four seconds; the stage camera remains through the first
   complete 7.5-second performance, then returns control automatically.
2. Watch a player-authored three-emote sequence, or the clearly labelled House fallback. If a player charade has
   an answer-back, both players perform on stage in alternating three-emote sequences.
3. Watch all three ordered clues: `START` establishes who or where, `ACTION` shows what happens, and `REACTION`
   shows the result or feeling. The answer cards remain locked until the first complete sequence. Then choose one
   of three phrase cards; exactly one is the phrase assigned to the author. Replay restarts from `START`.
4. A routine reveal takes three seconds. The first reveal of a visit or set, a finale, or a genuine milestone keeps
   the full eight-second theatrical reveal: answers lock, the camera pushes toward the stage, the theater lighting
   changes, the verdict appears, the audience reacts, and the aggregate result is reported.
5. Answer back with a new performance of the same phrase, make a new charade from the fixed phrase deck, or send
   a private Ghost Mail to a recent real performer.
6. Preview and post the ordered three-emote performance. An ordinary charade can explicitly opt into future
   touring to other Worlds from this final confirmation; the control starts off. Then inspect today's boards or
   copy a general World invite for a friend. The server selects eligible content after arrival; the link does not
   target one charade.
7. Return later to see how many people understood your ghosts, whether anyone answered back, and how much Ghost Mail
   is waiting.

The answer is never chosen at random. The server records the author's assigned phrase, creates two constrained
same-theme decoys, and checks the selected card against that stored phrase. A wrong first choice gets one
position-specific replay and a two-card second chance; a recovery awards 50 points but does not count as a
first-try "understood" result in the author's solve statistics.

The normal client locks first guesses through the complete 7.5-second performance. The authoritative server applies
the same minimum delay only after sending the exact charade and any duet reply, so a modified client cannot win a
live round early. For a server-issued second chance, the normal client starts the position-specific replay while
showing the two remaining cards; the server does not add another delay to that retry.

If authoritative readiness takes more than 12 seconds on a first visit, the waking screen offers Retry and a fixed
local House Practice. Practice shows its assigned phrase before playback and uses the normal three beats and stage
camera, but sends no gameplay request and changes no score, progress, boards, or saved state; Retry and Back remain
available. This shipped to the live World on 2026-09-02 - see the deployment note below.

With two or more players present, the Multiplayer Server serves a shared live round. Only a player-authored round
accepts one first-correct winner, who moves directly into the author flow; House rounds reveal without a live
winner. Solo visitors continue through the asynchronous loop.
Players who are watching rather than actively decoding can press Laugh, Gasp, or Applause. The server rate-limits
each address and relays the stamp to the other players present without changing the round state.

## Tonight's Show

The server rotates one of six themes at UTC midnight: Everyday Escapades, Big Feelings, Kitchen Capers,
Decentraland Life, Pop Spectacles, and Awkward Moments. The repository retains 120 historical phrase IDs and
translations, while the playable release deck is a deliberately constrained set of 30 phrases: five per theme,
each with two validated choices for each of the three ordered beats. Season Zero schedules 28 of those 30 each
week and rotates two out and two in at every weekly boundary. Charade selection prefers the current theme and falls
back to any eligible player performance without requiring a redeploy. The selectable pool covers the most recent
14 UTC days; genuine current-theme content must be renewed before it ages out during a release or judging window.

The current theme drives the foyer marquee and UI accent. For a signed-in player, three public decodes—
player-authored or House—plus one authored charade on the same UTC day awards one saved daily completion stamp.
The playbill shows the six most recent player-authored performances. Among performances with at least three
guesses, Crowd Pleaser ranks the one closest to a 60% solve rate, with audience size breaking ties; its author
becomes Ghost of the Night on the foyer pedestal. If none qualifies, the pedestal has no winner.

## Titles and reward props

Titles come only from recorded participation. Signed-in player progress is stored by the Multiplayer Server and
restored on reconnect.

| Title             | Requirement                                 | Attached prop |
| ----------------- | ------------------------------------------- | ------------- |
| Understudy        | Post the first charade                      | Top hat       |
| Scene Stealer     | Reach 10 correct decodes or 5 posts         | Mask          |
| Ghostlight Legend | Reach 25 correct decodes and 3 daily stamps | Trophy        |

The client attaches each reward to the titled player's avatar address, so visible players receive the correct
head or hand prop rather than a local-only costume.

## Answer-back duets

After revealing an eligible real-player charade, the decoder can choose `ANSWER BACK`. The reply keeps the
original phrase, offers two phrase-specific choices at each labelled beat, and records a new ordered sequence of
three. The author cannot repeat an emote, choose outside the current beat, or post before watching the complete
preview. A charade accepts only its first reply. Future visitors see the original performer and replier alternate
complete sequences, and the original author receives a persisted return notification.

Self-replies, House replies, replies before a completed guess, phrase changes, and second replies are rejected by
the server.

## Ghost Mail

Signed-in players can choose a real recent performer from the playbill and author a private three-emote Ghost Mail
without typing an address or message. The server persists it outside the public pool and boards, serves unseen mail
only to its recipient, and allows that recipient to decode and Answer Back. Guests, self-sends, and unknown
recipients are rejected.

## Touring consent

The ordinary Preview/Post confirmation includes one `ALLOW TOUR TO OTHER WORLDS` control. It is off by default for
every new draft and must be deliberately enabled to opt in before posting. The selected value remains attached to
that draft through emote changes and network retries. Answer Back and Ghost Mail never show the control and always
post with touring consent set to false.

This release records the opt-in only as part of the authored performance. No shared touring read, cross-World feed,
or client-facing touring API exists yet, and the separate `api/` service is not wired to this consent.

## Languages and accessibility

English is the default; Settings cycles English, Spanish, and Portuguese without text entry. The client bundle
contains 220 interface strings and all 120 historical phrase texts in each language under stable IDs; 30 of those
phrases are in the current playable deck. The server sends
canonical phrase and answer IDs alongside compatibility fallback text, so authors and decoders can use different
languages while retaining answer options from the same theme.

For the current visit, Settings also offers full, quiet, or off sound, reduced motion, and 20% larger text. Reduced
motion shortens the reveal to three seconds while retaining the verdict, sound, statistics, and progress.

## Controls

| Action                | Mobile-first behavior                                                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move                  | Use the Decentraland movement joystick. Native action buttons are hidden after mobile platform detection.                                                                                                                                                                           |
| Start decoding        | Follow the static `WALK TO THE STAGE` instruction, then tap `DECODE A GHOST` in the house or stage area.                                                                                                                                                                            |
| Guess                 | Watch the complete `START -> ACTION -> REACTION` sequence, then tap one of three 96 px source-layout answer buttons. Exactly one answer is true. Required UI stays inside Decentraland's interactable screen inset.                                                                 |
| Watch again           | Tap `REPLAY` to restart the current solo performance or duet.                                                                                                                                                                                                                       |
| Make a charade        | Tap `MAKE YOUR OWN`, accept or shuffle the dealt phrase, then choose one of two validated emotes for each labelled beat. The third choice advances to confirmation; watch the full preview before Post becomes available. Ordinary posts include one off-by-default touring opt-in. |
| Answer back           | After an eligible reveal, tap `ANSWER BACK`, choose three emotes for the same phrase, preview, then send the reply.                                                                                                                                                                 |
| Send Ghost Mail       | Tap `GHOST MAIL`, choose a recent real performer, then use the normal phrase, emote, preview, and send flow. No address or message entry is required.                                                                                                                               |
| React in a live round | While watching an active round in the stage area, open `REACT`. Laugh, Gasp, and Applause replace the other actions, trigger one local emote and stamp, and relay once to the other players present.                                                                                |
| How to play           | From the foyer, tap the top-right `HOW TO PLAY` control for five short instructions, then choose `SETTINGS` or `BACK`.                                                                                                                                                              |
| Settings              | Open `HOW TO PLAY` from the foyer, then switch language, sound level, reduced motion, or large text for the current visit. Settings links back to `HOW TO PLAY`.                                                                                                                    |
| Invite                | `COPY INVITE` copies a general World invitation configured in `src/shared/config.ts`; it does not route to a specific charade.                                                                                                                                                      |

Desktop preview uses the normal Decentraland movement controls and the same on-screen game UI.

## Architecture

`scene.json` enables `authoritativeMultiplayer`, and `src/index.ts` branches once between the server and client
runtimes.

```text
Decentraland mobile / desktop client
  ReactEcs UI, theater GLBs, cameras, sound, reveal timeline, eight-slot avatar pool
                         |
                         | registered SDK7 network messages
                         v
Authoritative Multiplayer Server
  request validation, avatar snapshots, themed selection, live rounds, progression
                         |
                         v
Decentraland Storage
  scene: charades, daily indexes, boards, recent visitors
  player: signed-in statistics, daily stamps, titles, return and mail notifications
```

The separate `api/` service is an undeployed PostgreSQL-backed foundation for signed, aggregate-only funnel
analytics and persistent moderation staging. It is not wired into the current World candidate. Its authenticated
ingestion, untrusted publishing, privacy-bounded reporting, and role-gated moderator/export boundaries are documented
in [`api/README.md`](api/README.md). HTTP-published content cannot enter a shared pool because this slice has no
positive approval or channel-elevation path. It also has no shared touring read and is not wired to the World
client's touring-consent field.

The client sends intents such as guess, post, and react. It never supplies the avatar look used for a stored
performance; the server snapshots Decentraland's player ECS data. All persisted values are serialized JSON, and
charade and player-stat records carry a schema version. Storage writes pass through a dirty queue, retry when the
host returns `false`, and run in batches of at most eight. Final guesses and every post shape journal the exact
request fingerprint, after-images, and response before applying their state changes. On restart, the server reapplies
an active journal entry before accepting players; a same-show client then resends the exact request and receives the
original reveal or post acknowledgement without duplicate scoring, progression, or content. A first wrong guess is
not a persistent mutation, so a restart replaces that unfinished round with a fresh charade.

Localized copy stays in the client bundle. The server includes canonical phrase and answer IDs alongside the
existing fallback fields, and each decoder renders those IDs in the language selected on that client.

The presentation layer uses generated GLBs and emissive material changes rather than dynamic lights or particles.
The avatar pool is capped at eight slots: one stage performer, six audience positions, and one preview/replier;
Ghost of the Night reuses an audience slot.

Visible title rewards are separately bounded to the 16 nearest titled live players, refreshed once per second,
plus one reusable stage-author slot. The conservative all-trophy reveal peak is 79 app-created entities and 16,492
authored triangles, within the two declared parcels' 400-entity and 20,000-triangle budgets.

## Generated assets

All shipped models, sounds, and UI textures are generated in-repository and committed, so normal installation does
not require Blender, Python imaging/audio packages, or FFmpeg.

| Pipeline                  | Command                 | Source and output                                                            |
| ------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| Theater and reward models | `npm run assets:models` | `tools/blender/build_assets.py` -> `assets/models/*.glb` and `manifest.json` |
| Room tone and show cues   | `npm run assets:sounds` | `tools/audio/build_sounds.py` -> `assets/sounds/*.mp3` and `manifest.json`   |
| Playbill UI textures      | `npm run assets:ui`     | `tools/ui/build_textures.py` -> `assets/ui/*.png` and `manifest.json`        |
| Everything                | `npm run assets`        | Runs the three pipelines in the order above                                  |

The model script is wired to Blender 5.1 at
`C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`. The current generator toolchain was verified with
Blender 5.1.2; Python 3.12.10; NumPy 2.4.6; SciPy 1.18.0; Pillow 12.2.0; and FFmpeg 8.1.2. `ffmpeg` must be on
`PATH` for sound generation.

`test/asset-budget.test.ts` parses the committed outputs and enforces the mobile budgets: no model above 3,000
triangles, exact `createTheater()` instance counts, 11,664 instantiated theater triangles within two parcels'
20,000-triangle budget, no Draco, power-of-two UI textures no larger than 1024 px, gapless metadata and a
non-outlier decoded seam for the room-tone loop, measured encoded peaks, less than 2 MB of sound, and less than
25 MB under `assets/`.

## Before deploying

Run `npm run preflight` from the exact candidate checkout. Resolve every reported `FAIL`, then review the ordered
owner warnings before requesting deployment approval; the command does not deploy the World.

## Run from scratch

Requirements: Node.js `^22.12.0` or `>=24.0.0`, and npm `>=10.0.0`. From a fresh checkout:

```bash
npm ci
npm run build
npm test
npm run start
```

The final command launches the local Decentraland preview. The generated assets are already committed. The
Decentraland SDK and runtime are pinned to `7.27.1-33086747846.commit-824d240`. The live World entity
`bafkreihydi7utkj5quq5y6tzpf7sw7neurw7lvcnjqqoyyne2bhqscanhy` was deployed on 2026-09-02 from tag `release/2026-09-02`
on that exact pin, and includes the wake recovery, House Practice, guided opening, adaptive reveal, and House
progression. The previous entity `bafkreihblrzvm6t3flfwgjbmyybi5gs3dyyhw345iix3qc4nkc3ohlmiyu` (tag
`release/friendzone-judging`, commit `c0abf00`) is retained as the rollback target. On 2026-09-02 the owner played
the deployed build on a phone with a named account and completed decode, reveal, the title notice, and three posts;
no screen recording was made, so the formal same-commit checklist in
[`docs/DEVICE-CHECKLIST.md`](docs/DEVICE-CHECKLIST.md) remains to be recorded. Any later SDK pin change restarts
the SDK-compatibility portion of that gate.

### Verified phone-preview QR

SDK Commands 7.27 has no host-selection flag for `start --mobile`; it uses the first external IPv4 address, which
can be a VPN or virtual adapter. Start one preview without the SDK-generated mobile QR, using the pinned
authoritative-server package required by the device gate:

```powershell
$env:DCL_SERVER_ENGINE = 'bevy'
$env:DCL_SERVER_PACKAGE = '@dcl-regenesislabs/bevy-headless-server@0.1.0-32423386171.commit-d18de13'
npm run start -- --no-browser --no-client -p 8000
```

In a second terminal, generate the QR from the running preview:

```powershell
node tools/mobile-preview.mjs
```

The helper rejects loopback, link-local, and known VPN, tunnel, WSL, Hyper-V, and virtual adapters. It automatically
selects a host only when exactly one eligible, recognized physical LAN IPv4 exists. Multiple candidates make it exit
with their addresses and require `--host <IPv4>`; a sole adapter whose name is not recognized also requires explicit
verification and `--host`. It verifies the selected `http://<IPv4>:8000/about` response before printing the exact
`decentraland://open?preview=...` payload and terminal QR.

Before counting a device pass, confirm the printed host belongs to the Wi-Fi or Ethernet network shared with the
phone, open that exact `/about` URL on the phone, and verify `healthy: true`. Then scan the QR and record the
Decentraland app reaching Ghostlight's ready state. A successful laptop endpoint check or a rendered QR alone is
not phone evidence.

## Device testing and release state

Automated tests cover the loop, reveal timing, duet pairing, Ghost Mail privacy, title thresholds, live rounds,
spectator reaction relay and rate limits, localisation completeness and cross-language answers, accessibility
settings, storage recovery, network retries, and generated-asset limits. Real-device validation remains a separate
release gate; follow
[`docs/DEVICE-CHECKLIST.md`](docs/DEVICE-CHECKLIST.md) for cold start, safe areas, sound latency, camera behavior,
solo persistence, two-client rounds, and measured performance.

`scene.json` configures the World as `ghostlight.dcl.eth`. The live World serves entity
`bafkreihydi7utkj5quq5y6tzpf7sw7neurw7lvcnjqqoyyne2bhqscanhy` on exact SDK
`7.27.1-33086747846.commit-824d240`, deployed 2026-09-02 from tag `release/2026-09-02` (scene code `c49bf1d`), so
opening it from Decentraland search tests the wake recovery, House Practice, guided opening, adaptive reveal, and
House progression. The previous entity `bafkreihblrzvm6t3flfwgjbmyybi5gs3dyyhw345iix3qc4nkc3ohlmiyu`
(`release/friendzone-judging`, `c0abf00`) remains the rollback target. The repository and its MIT `LICENSE` were
published on 2026-09-02. The remaining release gates are the same-commit device checklist on the deployed build and
verifying that production Storage rehydrates at least three genuine recent performances and a real Answer-Back duet
after server sleep.

Guests can decode but cannot author persistent ordinary posts, Answer-Back replies, or Ghost Mail. Durable titles,
return reports, and authored performances require a signed-in Decentraland profile.

## Project layout

```text
src/
  client/   Client flow, ReactEcs UI, theater, ghosts, cameras, sound, reveals, rewards
  server/   Authoritative protocol handlers, live rounds, state, migrations, Storage queue
  shared/   Message schemas, fixed phrase deck, localisation, themes, progression constants, selection logic
test/       Vitest coverage for client, server, protocol, persistence, and asset budgets
tools/
  mobile-preview.mjs  Verified LAN-host deep-link and terminal QR generator
  blender/  Procedural GLB generator
  audio/    Deterministic synthesized MP3 generator
  ui/       Procedural PNG generator
assets/     Committed generated models, sounds, textures, and their manifests
docs/       Build plans, device checklist, roadmap, and submission materials
api/        Isolated signed analytics/moderation service, PostgreSQL migration, and API tests
```

## Roadmap

The current release sequence, device gates, and post-build priorities live in
[`docs/ROADMAP.md`](docs/ROADMAP.md). The implementation task record is
[`docs/BUILD-PLAN-2.md`](docs/BUILD-PLAN-2.md).

## License

[MIT](LICENSE) (c) 2026 Ridwan Nurudeen.
