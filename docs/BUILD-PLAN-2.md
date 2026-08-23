# Ghost Charades — Build Plan 2: Opening Night (Phase 0 of `docs/ROADMAP.md`)

The functional core (`d157934`: loop, server, persistence, 113 tests) is done and frozen. This plan adds
everything the judge *sees and hears*. Read `docs/ROADMAP.md` §2 for the why; this file is the how.
`docs/BUILD-PLAN.md` §0–§1 (ground rules, verified API surface) still apply in full.

## 0. Additional ground rules

1. **Do not change the guessing contract or the server message schema** except where a task below says so
   (Duets, Tonight's Show, progression). Every existing test keeps passing.
2. **Everything is generated, nothing is downloaded.** 3D assets come from `tools/blender/build_assets.py`
   (Blender 5.1.2 headless, verified at `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`);
   sounds from `tools/audio/build_sounds.py` (numpy 2.4 + scipy 1.18 → WAV → ffmpeg 8.1 → mp3); UI textures
   from `tools/ui/build_textures.py` (Pillow 12.2). All three are wired to npm scripts (`assets:models`,
   `assets:sounds`, `assets:ui`, `assets`) and their outputs are committed so a clone builds without tools.
   No third-party asset, font, or sound file enters the repo (licence risk; T&C §8).
3. **Mobile budgets are enforced by a test**, not a comment: `test/asset-budget.test.ts` parses every GLB in
   `assets/models/` (read the binary header + JSON chunk; count `accessors` for `POSITION`/indices) and
   asserts: per-model ≤ 3,000 triangles, total ≤ 40,000 triangles, ≤ 12 materials total, every texture a
   power of two ≤ 1024, no Draco (`KHR_draco_mesh_compression` absent), total `assets/` < 25 MB.
   ≤ 8 `AvatarShape` alive stays enforced. No particles, no dynamic lights (mobile has neither) — use
   emissive materials, scale/colour tweens, and `Tween` moves.
4. **Sound**: `.mp3`, mono, 44.1 kHz, ≤ 3 s except the room-tone loop (≤ 15 s); total sounds < 2 MB. One
   `AudioSource` entity per clip, created once, `playing` toggled; never recreate per play.
5. **UI**: `uiBackground` textures use `textureMode: 'stretch'` or `'center'` — never `'nine-slices'` (tiles on
   mobile). All fonts render sans-serif on this SDK; design for it. Nothing bottom-right. Buttons ≥ 96 px.
6. Commit per task, conventional messages, no AI attribution, no Co-Authored-By. `npm run build` and
   `npm test` green before every commit. Never `npm run start` / `npm run deploy`.

## 1. Verified APIs for this plan (installed SDK `7.26.1-32239895147.commit-3c77d90`)

| Need | API |
|---|---|
| Models | `GltfContainer.create(entity, { src: 'assets/models/x.glb' })` |
| Sounds | `AudioSource.create(e, { audioClipUrl: 'assets/sounds/x.mp3', playing: false, loop: false, volume: 1 })`; `AudioSource.playSound(entity, url)` helper exists; `.mp3` recommended by the docs |
| Animation | `Tween.create(e, { mode: Tween.Mode.Move({ start, end }) \| .Rotate \| .Scale, duration: ms, easingFunction: EasingFunction.EF_EASEOUTQUAD })`; `TweenSequence` for chains; `tweenSystem.tweenCompleted(e)` |
| Emissive | `Material.setPbrMaterial(e, { albedoColor, emissiveColor, emissiveIntensity })` — change per beat |
| Camera | `VirtualCamera.create(cam, { defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.6) }, lookAtEntity })`; switch via `MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity })`; `fov` ignored on mobile |
| Avatar props | `AvatarAttach.create(prop, { avatarId: '0x…', anchorPointId: AvatarAnchorPointType.AAPT_HEAD \| AAPT_NAME_TAG \| AAPT_RIGHT_HAND … })` — `avatarId` REQUIRED or every viewer sees it on themselves |
| Portraits | UI: `uiBackground={{ avatarTexture: { userId: '0x…' }, textureMode: 'stretch' }}` (verified: `UiAvatarTexture { userId, wrapMode?, filterMode? }` in `@dcl/react-ecs/dist/components/uiBackground/types.d.ts`); world: `Material.Texture.Avatar({ userId })`. 256 px face; fails for guests → placeholder |
| UI textures | `uiBackground={{ texture: { src: 'assets/ui/panel.png' }, textureMode: 'stretch' }}` |
| Text in world | `TextShape.create(e, { text, fontSize, textColor, outlineWidth, outlineColor })` + `Billboard` |
| Emotes on ghosts | `expressionTriggerId` + lamport `expressionTriggerTimestamp` (existing `ghosts.ts`) |
| Player emote | `triggerEmote({ predefinedEmote })` from `~system/RestrictedActions` |

## 2. Workstreams and file ownership (disjoint)

```
tools/blender/build_assets.py        A   Blender script → assets/models/*.glb (+ manifest.json)
tools/audio/build_sounds.py          A   synth SFX → assets/sounds/*.mp3 (+ manifest.json)
tools/ui/build_textures.py           A   Pillow → assets/ui/*.png (panel, card, button states, marquee, stamp)
assets/models | sounds | ui          A   generated outputs (committed)
test/asset-budget.test.ts            A
src/client/sound.ts                  B   clip registry, play(name), ambience loop, volume ducking
src/client/reveal.ts                 B   the reveal choreography timeline (see T3)
src/client/opening.ts                B   the 10-second cold open
src/client/theater.ts                B   REPLACE primitives with the generated kit; lighting rig; curtain; marquee
src/client/setup.ts                  B   camera rig: foyer cam, stage cam, reveal push-in cam
src/client/ui.tsx                    C   playbill skin, answer cards, marquee header, progress ribbon, stamps
src/client/flow.ts                   C   new screens/states: opening, show, title-unlock, duet-reply
src/client/ghosts.ts                 C   second on-stage slot (replier) reusing the preview slot
src/shared/deck.ts                   D   theme tags (6 themes × 20 phrases; map categories → themes)
src/shared/config.ts | types.ts      D   THEMES, TITLES thresholds, REWARD_PROPS, Charade.reply, PlayerStats.title
src/shared/messages.ts               D   additive fields only (see T5–T7)
src/server/*                         D   Tonight's Show selection, progression, portraits list, duets
test/*                               owner of the code under test
docs/DEVICE-CHECKLIST.md, README.md  lead
docs/SUBMISSION.md, docs/FEATURING.md lead  (T9)
```

## 3. Tasks

### T1 — Asset pipelines (A) · Day 1
- `build_assets.py`: procedural, low-poly, flat-shaded with 2–3 shared materials per kit (warm wood,
  velvet red, brass gold, ghost-light cyan emissive). Models: `proscenium.glb`, `curtain_left.glb`,
  `curtain_right.glb`, `stage.glb`, `seat_row.glb`, `footlight.glb`, `chandelier.glb`, `poster_frame.glb`,
  `marquee.glb`, `spotlight_cone.glb` (translucent emissive), `foyer_doors.glb`, `pedestal.glb`, reward props
  `prop_tophat.glb`, `prop_mask.glb`, `prop_trophy.glb`. Export with `bpy.ops.export_scene.gltf(export_format='GLB',
  export_apply=True, export_draco_mesh_compression_enable=False)`. Write `assets/models/manifest.json`
  with triangle counts.
- `build_sounds.py`: `room_tone.mp3` (loop), `tick.mp3`, `drumroll.mp3`, `sting.mp3`, `hit.mp3`, `miss.mp3`,
  `applause.mp3`, `gasp.mp3`, `unlock.mp3`, `curtain.mp3`, `stamp.mp3`. Synthesised (filtered noise
  envelopes for applause/curtain/drumroll, additive synth for stings, short clicks for ticks). Normalise to
  −1 dBFS.
- `build_textures.py`: `panel.png`, `card.png`, `card_selected.png`, `button_primary.png`,
  `button_secondary.png`, `button_disabled.png`, `marquee.png`, `stamp.png`, `ribbon.png` — playbill style
  (cream paper, ink borders, ghost-light accent), 512×256 or 512×512, PNG.
- npm scripts; `test/asset-budget.test.ts`; run all three and commit outputs.

### T2 — Theater and lighting rig (B) · Day 1–2
Replace every primitive in `theater.ts` with the kit: foyer with doors → house with 6 seat rows (only the
front row holds ghosts) → proscenium, curtain (two halves, tween open/close), stage, 4 footlights, chandelier,
marquee over the doors, 2 poster frames, pedestal for "Ghost of the Night". Lighting rig = emissive
materials on footlights/chandelier/marquee + the spotlight cone aimed at the performer; `lights.set(mood)`
with moods `house`, `tension`, `hit`, `miss`, `applause`. Keep everything ≤ 10 m from the stage camera that
matters for name tags. Update `setup.ts` cameras: foyer (wide), stage (current), reveal push-in (closer,
lower). Gate: no primitive in the player's primary view; asset-budget test green.

### T3 — Reveal choreography (B) · Day 2 — THE ONE THING
`reveal.ts` drives an 8-second timeline from the `guess` tap to the next state:
0.0 s tick → answers lock, `lights.set('tension')`, `drumroll`, curtain edges twitch (scale tween);
1.2 s stage freeze: performer stops cycling (hold current emote); camera → push-in cam;
2.0 s `sting`; wrong answers fade (UI); spotlight cone colour → white;
2.6 s verdict: correct → `lights.set('hit')`, `hit.mp3`, floating "YOU GOT IT" `TextShape` rises + fades,
audience clones `clap`; wrong → `lights.set('miss')`, `miss.mp3`, "MAYA MEANT: …" card, audience `shrug`;
4.0 s performer plays `wave` (the bow), `applause.mp3` or `gasp.mp3`;
6.0 s stats card (7 of 11), title progress ribbon animates;
7.5 s camera → stage cam, `lights.set('house')`, reset. Every beat is a pure timeline entry `{ at, run }`
in a `REVEAL_TIMELINE` constant so it is unit-testable with a fake clock (`test/reveal.test.ts`: order,
timings, idempotent reset, skip-to-end on NEXT). Interruptible: NEXT during the timeline jumps to the end
state cleanly.

### T4 — Sound + cold open (B) · Day 2–3
`sound.ts` registry (one entity per clip, `play(name)`, ambience loop started after the platform is known,
ducking ambience during the reveal). `opening.ts`: on first entry per session, a 10-second scripted intro —
foyer cam → marquee "TONIGHT'S SHOW: <theme>" (TextShape) → doors open (tween) → stage cam → performer
enters → one line of UI copy ("Guess what they're saying") → the decode screen. Skippable by tap. Never
shown twice in a session. Gate: five fresh testers start the first guess without coaching (owner-run).

### T5 — Tonight's Show (D + C) · Day 3
Server picks the theme by UTC day (`THEMES[dayIndex % 6]`), serves charades whose phrase theme matches
first, falls back to any; `ready` gains `theme` and `themeLabel` (additive). Client: marquee text, palette
accent per theme (UI + emissive accent), a daily completion stamp (`stamp.png` + `stamp.mp3`) when the
player decodes 3 and authors 1 that day (`PlayerStats.daily` shard). Gate: theme flips at UTC midnight
without a redeploy (test with a fake clock).

### T6 — Progression and the playbill (D + C) · Day 3–4
Titles by verified participation: Understudy (first post) → Scene Stealer (10 correct decodes or 5 posts) →
Ghostlight Legend (3 daily stamps + 25 correct). Server computes `title` in `PlayerStats`; `since`/`reveal`
carry `title` and `nextUnlock` (additive). Client: title under the player's name on the progress ribbon;
reward props via `AvatarAttach` (`prop_tophat` Understudy, `prop_mask` Scene Stealer, `prop_trophy`
Legend) attached with the player's own address, visible to everyone; `unlock.mp3` + card on unlock. Ghost
of the Night pedestal: the day's hardest-to-decode author's clone (reuse an audience slot if none free).
Lobby playbill: a UI list of the last 6 performers with portrait (`AvatarTexture`, placeholder for guests),
name, title, "performed 3h ago". Gate: rewards persist and restore after reconnect (test).

### T7 — Answer-Back Duets (D + C) · Day 4–5
Additive data: `Charade.reply?: { address, name, look, emotes[3], createdAt }` (v2 records; v1 parse stays).
After a reveal, the decoder may "ANSWER BACK": pick 3 emotes for the same phrase (reuse the author flow),
`post` gains `replyTo?: charadeId`. A charade with a reply is served with both performers on stage
(performer slot + the preview slot as the replier), alternating sequences, before the guess. Author's
`since` gains `replies`. One reply per charade (first wins); server validates. Gate: author, reply, and
return notification survive server sleep and reconnect (tests through the fake room + fake storage).

### T8 — Integration, performance, device pass (lead) · Day 5
Wire everything; `npm run assets` idempotent; profile entity/triangle counts; remove the old primitive
theater code; update `docs/DEVICE-CHECKLIST.md` with the new checks (reveal timing on device, sound
latency, curtain, marquee readability at arm's length, prop visibility on another player, duet stage);
README updated (controls, Tonight's Show, titles, duets, asset pipelines).

### T9 — Submission and featuring packets (lead) · Day 5
`docs/SUBMISSION.md`: the DoraHacks text — hook sentence, the three required explanations (mobile design,
social interaction, return/share/invite), "one measured number" placeholder the owner fills from the
device run, World link placeholder, screenshot list, video shot list (30–90 s, device-captured).
`docs/FEATURING.md`: the `#rl-mobile-featuring` post (title, description, gameplay description, novel
mechanic statement, control-safe UI statement) and the `#rl-mobile-curation` post for iOS.

### T10 — Final rigorous self-audit (lead, last)
After T1–T9: audit the ENTIRE repo as an independent reviewer would — correctness of every timeline and
state machine, every schema change against the 13 KB cap, every `Storage` write's boolean, the 8-ghost
budget with the replier slot, asset budgets, UI safe areas, cold-start behaviour, duets and progression
across reconnect, T&C compliance (no fabricated engagement, house content labelled), and the build rules.
Fix what you find. Then produce `docs/AUDIT.md`: findings (fixed / accepted with reason), verified vs
unverified (device-only), and the exact owner checklist. Final message = that audit summary + commit list +
build/test tails.

## 4. Definition of done
`npm run assets` regenerates everything deterministically; `npm run build` strict-green; `npm test` green
including the asset budget; no primitive theater code; the full loop — opening → decode → reveal
choreography with sound → author → post → answer-back → invite — closes in preview; Tonight's Show,
titles, props, playbill, and duets persist across a server restart; `docs/AUDIT.md`, `SUBMISSION.md`,
`FEATURING.md`, updated README and DEVICE-CHECKLIST exist with no placeholders except the owner's
measured numbers and links.
