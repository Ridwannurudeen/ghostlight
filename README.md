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

When no eligible player performance exists, the server serves one clearly labelled `HOUSE GHOST`. House content
is excluded from player statistics, boards, and progression.

## Game loop

1. Enter the theater. A skippable ten-second cold open runs once per client session while the authoritative server
   prepares the first performance.
2. Watch a player-authored three-emote sequence, or the clearly labelled House fallback. If a player charade has
   an answer-back, both players perform on stage in alternating three-emote sequences.
3. Choose one of three phrase cards. Replay restarts the performance from its first emote.
4. The eight-second reveal locks the answers, pushes the camera toward the stage, changes the theater lighting,
   reveals the verdict, cues the audience, and reports the aggregate result.
5. Answer back with a new performance of the same phrase, or make a new charade from the fixed phrase deck.
6. Preview and post the ordered three-emote performance, inspect today's boards, or copy a general World invite
   for a friend. The server selects eligible content after arrival; the link does not target one charade.
7. Return later to see how many people tried the performance, how many decoded it, and whether anyone answered
   back.

With two or more players present, the Multiplayer Server serves a shared live round and accepts one first-correct
winner. The winner moves directly into the author flow; solo visitors continue through the asynchronous loop.

## Tonight's Show

The server rotates one of six themes at UTC midnight: Everyday Escapades, Big Feelings, Kitchen Capers,
Decentraland Life, Pop Spectacles, and Awkward Moments. Each theme owns 20 of the 120 built-in phrases. Charade
selection prefers the current theme and falls back to any eligible player performance without requiring a
redeploy. The selectable pool covers the most recent 14 UTC days; genuine current-theme content must be renewed
before it ages out during a release or judging window.

The current theme drives the foyer marquee and UI accent. For a signed-in player, three real-player decodes plus
one authored charade on the same UTC day awards one saved daily completion stamp. The playbill shows the six most
recent player-authored performances, and Ghost of the Night places the day's hardest-to-decode real performer on
the foyer pedestal.

## Titles and reward props

Titles come only from recorded participation. Signed-in player progress is stored by the Multiplayer Server and
restored on reconnect.

| Title | Requirement | Attached prop |
| --- | --- | --- |
| Understudy | Post the first charade | Top hat |
| Scene Stealer | Reach 10 correct decodes or 5 posts | Mask |
| Ghostlight Legend | Reach 25 correct decodes and 3 daily stamps | Trophy |

The client attaches each reward to the titled player's avatar address, so visible players receive the correct
head or hand prop rather than a local-only costume.

## Answer-back duets

After revealing an eligible real-player charade, the decoder can choose `ANSWER BACK`. The reply keeps the
original phrase, offers five verified Decentraland emotes, and records a new ordered sequence of three. A charade
accepts only its first reply. Future visitors see the original performer and replier alternate complete sequences,
and the original author receives a persisted return notification.

Self-replies, House replies, replies before a completed guess, phrase changes, and second replies are rejected by
the server.

## Controls

| Action | Mobile-first behavior |
| --- | --- |
| Move | Use the Decentraland movement joystick. Native action buttons are hidden after mobile platform detection. |
| Start decoding | Walk into the house or stage area, then tap `DECODE A GHOST`. The action remains disabled in the foyer. |
| Guess | Tap one of three 96 px answer buttons. Required UI stays inside Decentraland's interactable screen inset. |
| Watch again | Tap `REPLAY` to restart the current solo performance or duet. |
| Make a charade | Tap `MAKE YOUR OWN`, accept or shuffle the dealt phrase, continue to five-emote selection, then choose three in order. The third choice advances to a separate Preview/Post confirmation. |
| Answer back | After an eligible reveal, tap `ANSWER BACK`, choose three emotes for the same phrase, preview, then send the reply. |
| React in a live round | Open `REACTIONS`; its three choices replace the secondary actions while open, and trigger a local player emote plus a remote audience reaction. |
| Invite | `COPY INVITE` copies a general World invitation configured in `src/shared/config.ts`; it does not route to a specific charade. |

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
  player: signed-in statistics, daily stamps, titles, return notifications
```

The client sends intents such as guess, post, and react. It never supplies the avatar look used for a stored
performance; the server snapshots Decentraland's player ECS data. All persisted values are serialized JSON, and
charade and player-stat records carry a schema version. Storage writes pass through a dirty queue, retry when the
host returns `false`, and run in batches of at most eight. Requests that can mutate state carry IDs so a network
retry does not double-count a guess or post.

The presentation layer uses generated GLBs and emissive material changes rather than dynamic lights or particles.
The avatar pool is capped at eight slots: one stage performer, six audience positions, and one preview/replier;
Ghost of the Night reuses an audience slot.

Visible title rewards are separately bounded to the 16 nearest titled live players, refreshed once per second,
plus one reusable stage-author slot. The conservative all-trophy reveal peak is 79 app-created entities and 16,492
authored triangles, within the two declared parcels' 400-entity and 20,000-triangle budgets.

## Generated assets

All shipped models, sounds, and UI textures are generated in-repository and committed, so normal installation does
not require Blender, Python imaging/audio packages, or FFmpeg.

| Pipeline | Command | Source and output |
| --- | --- | --- |
| Theater and reward models | `npm run assets:models` | `tools/blender/build_assets.py` -> `assets/models/*.glb` and `manifest.json` |
| Room tone and show cues | `npm run assets:sounds` | `tools/audio/build_sounds.py` -> `assets/sounds/*.mp3` and `manifest.json` |
| Playbill UI textures | `npm run assets:ui` | `tools/ui/build_textures.py` -> `assets/ui/*.png` and `manifest.json` |
| Everything | `npm run assets` | Runs the three pipelines in the order above |

The model script is wired to Blender 5.1 at
`C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`. The current generator toolchain was verified with
Blender 5.1.2; Python 3.12.10; NumPy 2.4.6; SciPy 1.18.0; Pillow 12.2.0; and FFmpeg 8.1.2. `ffmpeg` must be on
`PATH` for sound generation.

`test/asset-budget.test.ts` parses the committed outputs and enforces the mobile budgets: no model above 3,000
triangles, exact `createTheater()` instance counts, 11,664 instantiated theater triangles within two parcels'
20,000-triangle budget, no Draco, power-of-two UI textures no larger than 1024 px, gapless metadata and a
non-outlier decoded seam for the room-tone loop, measured encoded peaks, less than 2 MB of sound, and less than
25 MB under `assets/`.

## Run from scratch

Requirements: Node.js 20.x, 22.x, or 24+ and npm 10+. From a fresh checkout:

```bash
npm ci
npm run build
npm test
npm run start
```

The final command launches the local Decentraland preview. The generated assets are already committed. The
Decentraland packages are pinned to `7.26.1-32239895147.commit-3c77d90`; changing that pin requires a new build,
test, and real-device validation pass.

## Device testing and release state

Automated tests cover the loop, reveal timing, duet pairing, title thresholds, live rounds, storage recovery,
network retries, and generated-asset limits. Real-device validation remains a separate release gate; follow
[`docs/DEVICE-CHECKLIST.md`](docs/DEVICE-CHECKLIST.md) for cold start, safe areas, sound latency, camera behavior,
solo persistence, two-client rounds, and measured performance.

`scene.json` configures the candidate for `ghostlight.dcl.eth`. Deployment remains blocked until the owner
proves control of that NAME, completes the device checklist, publishes absolute public repository/licence URLs,
and verifies that production Storage rehydrates at least three genuine recent current-theme performances and a
real Answer-Back duet after server sleep. This repository does not claim a live deployment.

Guest progress remains in server memory rather than player-scoped Storage. A guest-authored charade can still enter
the shared scene pool, but durable personal title and return progress requires a signed-in Decentraland profile.

## Project layout

```text
src/
  client/   Client flow, ReactEcs UI, theater, ghosts, cameras, sound, reveals, rewards
  server/   Authoritative protocol handlers, live rounds, state, migrations, Storage queue
  shared/   Message schemas, fixed phrase deck, themes, progression constants, selection logic
test/       Vitest coverage for client, server, protocol, persistence, and asset budgets
tools/
  blender/  Procedural GLB generator
  audio/    Deterministic synthesized MP3 generator
  ui/       Procedural PNG generator
assets/     Committed generated models, sounds, textures, and their manifests
docs/       Build plans, device checklist, roadmap, and submission materials
```

## Roadmap

The current release sequence, device gates, and post-build priorities live in
[`docs/ROADMAP.md`](docs/ROADMAP.md). The implementation task record is
[`docs/BUILD-PLAN-2.md`](docs/BUILD-PLAN-2.md).

## License

[MIT](LICENSE) (c) 2026 Ridwan Nurudeen.
