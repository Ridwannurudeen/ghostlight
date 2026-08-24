# Ghostlight — Build Plan (A → Z)

Companion to `docs/superpowers/specs/2026-08-23-ghostlight-design.md` (the spec: WHAT). This file is the
HOW: task order, file ownership, acceptance criteria, and the rules. Read the spec first, then this, then build.

## 0. Ground rules (non-negotiable)

1. **SDK is pinned.** `@dcl/sdk` and `@dcl/js-runtime` stay at exactly `7.26.1-32239895147.commit-3c77d90`.
   Do not run `npm install @dcl/sdk@…`, `upgrade-sdk`, or touch those two lines. The only new dependency
   allowed is `vitest` (devDependency, latest 4.x).
2. **Verified API surface only.** Everything below was read from the installed packages or the official docs.
   If you need an API not listed in §1, read its `.d.ts` under `node_modules/@dcl/` first; never guess a
   signature. `Schemas.Int` is a 32-bit write — never put `Date.now()` in a message; use `Schemas.Int64` or
   `Schemas.Number` for epoch milliseconds.
3. **Build must stay green after every task:** `npm run build` (bundles + strict type-check) and
   `npx vitest run`. A task is not done until both pass.
4. **Commit per task** with a conventional message (`feat(server): …`, `feat(client): …`, `test: …`,
   `content: …`). Plain commits — **no AI attribution of any kind, no Co-Authored-By trailers.**
5. **Never run `npm run start` or `npm run deploy`.** A preview server already owns port 8000 and hot-reloads
   this folder; deploying needs the owner's wallet. Device testing is the owner's job — leave them a checklist.
6. **No free text from players anywhere.** Phrases come from the deck; names come from DCL profiles.
7. **Engagement is never fabricated.** The only non-player content is the single house charade, labelled
   `isHouse: true`, excluded from every board and count.
8. **Server is the authority.** Clients send intents; the server decides, persists, and replies. Looks
   (wearables, body, colours) are snapshotted on the server from the player entity, never accepted from
   the client.
9. **Every `Storage.set()` / `Storage.player.set()` boolean is handled.** They never throw; `false` means
   the save was lost. Go through `storage.ts`'s dirty-set + flush; never call `Storage` directly elsewhere.
10. Keep the mobile budget: ≤ 8 `AvatarShape` entities alive at once, all within 10 m of the stage camera;
    spawn ≤ 3 per second; primitives + ≤ 10 props; no particles, no dynamic lights, no Draco GLBs.

## 1. Verified API surface (installed `@dcl/sdk@7.26.1-32239895147.commit-3c77d90`)

| Need | Import | Notes |
|---|---|---|
| Server split | `import { isServer } from '@dcl/sdk/network'` | `main()` branches once |
| Messages | `import { registerMessages } from '@dcl/sdk/network'`; `Schemas` from `@dcl/sdk/ecs` | `registerMessages(Messages)` once at top level of `src/shared/messages.ts`; payloads are `Schemas.Map`; `room.send(type, data, { to: [address] })` is server-only; `room.onMessage(type, (data, context?) => …)`, `context.from` = verified address; `room.send` queues until ready; `room.isReady()` exists |
| Storage | `import { Storage } from '@dcl/sdk/server'` | `Storage.get<T>(key, { fresh?: boolean })` → `T \| null`; `Storage.set(key, value)` → `Promise<boolean>`; `Storage.delete(key)`; `Storage.player.get/set/delete(address, key, …)`. Store strings (JSON). Max 40 in-flight host calls; keep ≤ 8 writes in flight. ~13 KB message cap; keep every payload < 4 KB |
| Players | `import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/src/players'` | `getPlayer()` may be `null` / have empty `wearables` on early frames — poll. Returns `{ name, userId, isGuest, avatar?: { bodyShapeUrn, skinColor, hairColor, eyesColor, name }, wearables, emotes, entity, position }` |
| Server-side player data | `PlayerIdentityData`, `AvatarBase`, `AvatarEquippedData`, `Transform` from `@dcl/sdk/ecs` | `engine.getEntitiesWith(PlayerIdentityData, AvatarBase, AvatarEquippedData)` on the server; `AvatarBase` = `{ name, bodyShapeUrn, skinColor, eyesColor, hairColor }`, `AvatarEquippedData` = `{ wearableUrns, emoteUrns }` |
| Ghost | `AvatarShape` from `@dcl/sdk/ecs` | `{ id, name, bodyShape, skinColor, hairColor, eyeColor, wearables, emotes, expressionTriggerId, expressionTriggerTimestamp }`; `id` = the real `0x…` address; an empty name or `"NPC"` hides the tag; `expressionTriggerTimestamp` is a lamport counter — start at 1, +1 per trigger |
| Platform | `import { getPlatform, isMobile } from '@dcl/sdk/platform'` | `getPlatform()` is `null` on the first frames — poll in a system, then do platform-dependent setup |
| HUD | `TouchScreenControls`, `InputAction` from `@dcl/sdk/ecs` | `TouchScreenControls.hideAll()` hides every gamepad button (joystick stays) |
| UI | `ReactEcs, { ReactEcsRenderer, UiEntity, Button, Label } from '@dcl/sdk/react-ecs'` | `ReactEcsRenderer.setUiRenderer(fn, { screenInset: 'interactable' \| 'device' })` — call it only once the platform is known; `Button` has `onMouseDown`, `variant: 'primary' \| 'secondary'`, `fontSize`, `uiTransform`; `Label` has `value`, `fontSize`, `color`, `textAlign` |
| Camera | `VirtualCamera`, `MainCamera` from `@dcl/sdk/ecs` | `MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity })`; clear `virtualCameraEntity` **before** removing a camera entity; `fov` is ignored on mobile |
| Restricted actions | `import { triggerEmote, copyToClipboard } from '~system/RestrictedActions'` | `triggerEmote({ predefinedEmote })`; `copyToClipboard({ text })` |
| Proximity / triggers | `engine.addSystem` + distance from `Transform.get(engine.PlayerEntity).position` | No gestures on mobile; no reliance on tap-on-3D-entity |
| Pure math | `Vector3`, `Quaternion`, `Color3`, `Color4` from `@dcl/sdk/math` | |

Emote vocabulary (documented AND shipped by the mobile client): `wave fistpump robot raiseHand clap money kiss
shrug handsair disco dab dontsee hammer tektonik tik headexplode`.

## 2. File map and ownership

Four workstreams with disjoint write scopes. **Task T1 is done by the lead agent first**; everything else
fans out. A file is written only by its owner; the other workstreams import it.

```
src/index.ts                      lead   main(): isServer() ? startServer() : startClient()
src/shared/config.ts              lead   WORLD_NAME, INVITE_URL, timings, budgets, PROTOCOL_VERSION
src/shared/types.ts               lead   Look, Charade, PlayerStats, Boards, schema version constants
src/shared/messages.ts            lead   registerMessages({...}) — the whole protocol (spec §5.2)
src/shared/deck.ts                D      phrase deck + categories + suggested emotes + decoy rules
src/shared/pick.ts                D      pure: chooseCharadeFor, pickDecoys, dealPhrase, offerEmotes, shuffleSeeded
src/server/server.ts              A      message handlers, heartbeat, enter/leave, look snapshot
src/server/state.ts               A      in-memory state, hydration, migrations, recent visitors, boards
src/server/storage.ts             A      checked writes, dirty set, flush, key schema (spec §5.3)
src/server/rounds.ts              A      live round logic when ≥ 2 present
src/client/setup.ts               B      platform poll → HUD, virtual screen, UI renderer, camera rig
src/client/theater.ts             B      foyer, doors, stage, six seats, props, trigger areas
src/client/ghosts.ts              B      AvatarShape pool: performer, six audience, preview; emote sequencer
src/client/flow.ts                C      client state machine + readiness gate + request/retry
src/client/ui.tsx                 C      screens: waking, decode, reveal, author, boards, invite, since
src/client/reactions.ts           C      reaction buttons → triggerEmote + `react` message
test/*.test.ts                    D      vitest for shared/* and server/storage.ts + state.ts (fake Storage)
docs/DEVICE-CHECKLIST.md          lead   the owner's on-phone checklist
```

The spike files (`src/client/spike.ts`, the current `src/server/server.ts`, `src/shared/messages.ts`,
`src/client/ui.tsx`) are replaced, not extended. Delete `spike.ts` once `ghosts.ts` renders a ghost.

## 3. Tasks in order

### T1 — Foundations (lead, before any fan-out)
- `config.ts`: `WORLD_NAME = 'ghostlight.dcl.eth'` (placeholder until the owner buys the NAME),
  `INVITE_URL = 'https://decentraland.org/jump/?realm=' + WORLD_NAME`, `EMOTE_STEP_SECONDS = 2.5`,
  `MAX_GHOSTS = 8`, `AUDIENCE_SEATS = 6`, `HEARTBEAT_SECONDS = 2`, `FLUSH_SECONDS = 30`,
  `AUTHOR_COOLDOWN_SECONDS = 60`, `PROTOCOL_VERSION = 1`.
- `types.ts`: `Look { address, name, isGuest, bodyShape, skinColor, hairColor, eyeColor, wearables }`;
  `Charade { v, id, author: Look, phraseId, emotes: [string,string,string], createdAt, guesses: { total, correct }, lastGuessAt, isHouse }`;
  `PlayerStats { v, name, decoded, correct, seen: string[], authored: string[], lastSeenAt, pending: { triedYou, gotYou } }`;
  `Boards { decoders: {address,name,correct,total}[], hardest: {charadeId, authorName, total, correct}[] }`.
- `messages.ts`: exactly the spec §5.2 set — `hello`, `ready`, `ping`, `pong`, `nextCharade`, `charade`,
  `guess`, `reveal`, `post`, `posted`, `since`, `audience`, `boards`, `roundStart`, `roundGuess`,
  `roundWinner`, `react`, `error`. Epoch millis as `Schemas.Int64`. Nested objects as nested `Schemas.Map`;
  arrays as `Schemas.Array(...)`. Keep every payload < 4 KB (audience = 6 looks ≈ 9 KB is too big — send
  `audience` as up to three messages of two looks, or trim wearables to the first 10 URNs per look).
- `index.ts` wired; `vitest` added (`"test": "vitest run"`); an empty `test/smoke.test.ts` passes.
- Acceptance: `npm run build` and `npm test` green. Commit.

### T2 — Content and pure logic (D)
- `deck.ts`: **120 phrases**, six categories × 20 (`everyday`, `feelings`, `food`, `dcl-life`, `pop`,
  `awkward`), each `{ id, text, category, suggested: [e1,e2,e3] }` using only the vocabulary in §1. Short,
  funny, decodable with three emotes, PG. Include the one house charade (`HOUSE_CHARADE`).
- `pick.ts` (pure, deterministic, seedable):
  `chooseCharadeFor(address, seen, pool)` — exclude own + seen, fewest guesses first, then oldest, never the
  same author twice in a row (pass `lastAuthor`); empty → `null` (caller substitutes the house charade).
  `pickDecoys(phraseId, deck, seed)` — two from the same category, different first word, stable per seed.
  `dealPhrase(deck, exclude, seed)`, `offerEmotes(phrase, seed)` — suggested three + two random, shuffled.
- Tests: deck integrity (120 phrases, unique ids, ≥ 2 same-category decoy candidates each, all emotes in the
  vocabulary); every `pick.ts` rule; determinism per seed.
- Acceptance: tests green. Commit.

### T3 — Server persistence and state (A)
- `storage.ts`: key schema from spec §5.3 (`gc:v1:charade:{id}`, `gc:v1:index:{YYYY-MM-DD}`,
  `gc:v1:recentVisitors`, `gc:v1:boards:{YYYY-MM-DD}`, player `gc:v1:stats`). API: `loadJSON<T>(key,
  fallback)`, `markDirty(key, value)`, `flush()` (≤ 8 writes in flight, keeps failed keys dirty, logs
  counts), `startFlushLoop()` (every `FLUSH_SECONDS`), `flushNow()` for checkpoints. Parse defensively;
  check `v`.
- `state.ts`: hydration on boot (today's + yesterday's index shards → charades; recent visitors; boards;
  house charade always present), `upsertCharade`, `recordGuess`, `touchVisitor(look)` (keeps six most
  recent distinct addresses), `recomputeBoards()`, `getOrCreateStats(address)`.
- Tests with a fake `Storage` (`set` returns `false` on demand): dirty keys survive a failed flush and retry;
  hydration tolerates missing/garbage values; boards math.
- Acceptance: tests green, build green. Commit.

### T4 — Server protocol (A)
- `server.ts`: `onEnterScene` → snapshot the look from the server-side player entity
  (`AvatarBase` + `AvatarEquippedData` + `PlayerIdentityData`), `touchVisitor`, send `ready`, `since`,
  `audience`, `boards`. Handlers: `ping`→`pong`; `nextCharade`→`charade` (answers shuffled with the correct
  index kept server-side per `(address, charadeId)`); `guess` (one per charade per address) → `reveal` +
  stats + author's `pending`; `post` (rate-limited `AUTHOR_COOLDOWN_SECONDS`, emotes validated against the
  vocabulary, phrase validated against the deck) → `posted`; `react` → relayed to others. Every reply is
  targeted with `{ to: [context.from] }`. Errors → `error { code }`, never silence.
- `rounds.ts`: when ≥ 2 players are present, the server runs rounds: `roundStart { charadeId }` to all;
  first correct `roundGuess` wins → `roundWinner { address, name }`; winner's next `nextCharade` is
  served an "author next" prompt flag. Solo players never see round messages.
- Acceptance: build green; a `test/server-protocol.test.ts` exercising the handlers through a fake room
  (construct the handler functions so they are testable without the engine). Commit.

### T5 — Client scene: theater, ghosts, camera, HUD (B)
- `setup.ts`: poll `getPlatform()`; on mobile `TouchScreenControls.hideAll()`; `setUiRenderer` with the
  right inset; stage `VirtualCamera` that engages when the player enters the decode area and releases on
  exit (clear `MainCamera.virtualCameraEntity` first).
- `theater.ts`: foyer (spawn) → 15-second walk → doors → house with stage and six seats facing it; simple
  primitives + ≤ 10 props; trigger areas (`foyer`, `house`, `stage`) as distance checks.
- `ghosts.ts`: a pool of ≤ `MAX_GHOSTS` `AvatarShape` entities; `showPerformer(look, emotes)`,
  `setAudience(looks)` (staggered ≤ 3 spawns/s), `showPreview(look, emotes)`, `react(kind)` (audience
  `clap` / `shrug`), `clearPerformer()`. Emote sequencer: advance every `EMOTE_STEP_SECONDS`, lamport +1,
  loop the trio. Everything placed within 10 m of the stage camera.
- Acceptance: build green; in the local preview (the owner runs it) a ghost with the player's own look
  renders and loops. Commit.

### T6 — Client flow and UI (C)
- `flow.ts`: states `waking → foyer → decode → reveal → author → posted → boards/invite`; readiness gate
  (`ping` every 2 s until `ready`/`pong`, then every 10 s); every request carries a `requestId` and retries
  once after 5 s; `since` shown once per session.
- `ui.tsx`: screens per spec §5.6 — one sentence each, buttons ≥ 96 px tall, answer buttons stacked and
  full-width on mobile, nothing bottom-right, `Replay`, `Shuffle` (×2), `Preview`, `Post`, `Copy invite`
  (a general World invitation using `INVITE_URL`), boards, house label when
  `isHouse`.
- `reactions.ts`: three reaction buttons (laugh / confused / genius) → `triggerEmote` locally + `react`.
- Acceptance: build green; flow unit-tested as a pure reducer where practical. Commit.

### T7 — Integration and hardening (lead)
- Wire `audience` into `ghosts.setAudience`, `reveal` into audience reactions, `roundWinner` into a toast.
- Cold start: confirm no gameplay message is sent before `ready`; show "The theater is waking up…" until then.
- Remove the spike files; delete dead code; run `npm run build` + `npm test`.
- Write `docs/DEVICE-CHECKLIST.md` (spec §7, device list) and update `README.md` (concept, controls,
  architecture, run-from-scratch, MIT, roadmap — no placeholders).
- Commit.

### T8 — Final report (lead, last message)
Return, in this order: (1) commit list with one line each; (2) `npm run build` and `npm test` output tails;
(3) what is VERIFIED (with the command/test that proves it) vs UNVERIFIED (anything only a phone or the
production server can prove); (4) exactly what the owner must do next (NAME, `worldConfiguration`, deploy,
device checklist, seeding playtests); (5) any spec deviation you made and why. No marketing language.

## 4. Definition of done

- `npm run build` green (strict), `npm test` green, no spike code left, no TODO/placeholder code.
- Solo path closes in preview: waking → decode a real charade (or the labelled house one) → reveal → author
  → post → invite; stats persist across a server restart (local storage emulator).
- Two-client path: rounds start when two are present and stop when one leaves.
- All eight mobile budget rules in §0.10 hold by construction (counts in code, not in comments).
