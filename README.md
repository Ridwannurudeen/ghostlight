# Ghost Charades

Guess what a stranger's ghost is acting out, then leave your own charade for whoever comes next.

Ghost Charades is a mobile-first Decentraland SDK7 World built for the Friendzone Mobile Buildathon. A
visitor decodes three-emote performances left by real previous players, sees the crowd's result, and records
a new performance from a fixed phrase deck. The last six real visitors appear as the theater audience. When
two or more players are present, the server turns the shared performance into a first-correct race.

The deployment target is `ghostcharades.dcl.eth`. That NAME is not configured in `scene.json` until ownership
is confirmed.

## Controls

- Move with the Decentraland joystick on mobile or the normal movement controls on desktop.
- Walk into the theater to enable `DECODE A GHOST`; the foyer prompt remains `WALK TO THE STAGE` until then.
- Use the large on-screen buttons to decode, replay, author, react, view boards, and copy an invite. `MAKE YOUR
  OWN` remains available while a decode request is pending or recovering from an error.
- Authoring uses no text input: choose one dealt phrase and three emotes in order.
- Native mobile action buttons are hidden; the movement joystick remains available.

## Game loop

1. Walk through the foyer while the authoritative multiplayer server wakes, then enter the theater to decode.
2. Decode a real player's three-emote ghost, or the clearly labelled House ghost when no real charade exists.
3. See the answer, aggregate result, and personal decoder score.
4. Take a dealt phrase, select three emotes, preview the performance, and post it.
5. Copy the World invite, inspect today's real-player boards, and return later for the “since you left” result.

House guesses and House performances are excluded from player stats and boards.

## Architecture

`src/index.ts` branches once between the authoritative server and the client.

- `src/shared/` contains the registered binary message schemas, immutable configuration, 120-phrase deck,
  shared types, and deterministic selection functions.
- `src/server/` owns storage hydration and migrations, checked dirty-write flushing, player state, authoritative
  avatar snapshots, request idempotency, cooldowns, decode/post handlers, boards, and live rounds.
- `src/client/` owns the theater, eight-slot avatar pool, virtual stage camera, platform-aware HUD, client state
  machine, retries, reactions, and ReactEcs mobile UI.
- `test/` covers deck integrity, deterministic selection, persistence failure recovery, migrations, boards,
  protocol races, rounds, and the complete client flow.

Persistent data uses versioned `gc:v1:*` keys. Scene writes are serialized as JSON strings, retained when a
host write returns `false`, and flushed in batches of at most eight concurrent calls. Startup hydrates the last
14 daily charade indexes in read batches of at most eight so the full judging window remains available. Player
looks used for posted ghosts are read from server-side ECS components, never from client payloads, and retain
up to 20 wearable URNs.

The runtime keeps at most eight `AvatarShape` components active: one performer, six audience members, and one
preview. Audience spawns are staggered to three per second, and the scene uses primitives without particles or
dynamic lights.

## Run from scratch

Requirements: Node.js 20.x, 22.x, or 24+ and npm 10+. The exact supported ranges are enforced by `package.json`.

```bash
npm ci
npm run build
npm test
npm run start
```

`npm run start` launches the local Decentraland preview. For phone validation, open its QR preview in the real
Decentraland mobile app and follow [`docs/DEVICE-CHECKLIST.md`](docs/DEVICE-CHECKLIST.md).

The Decentraland packages are pinned to `7.26.1-32239895147.commit-3c77d90`; do not upgrade them without a new
device validation pass.

## World deployment

Deployment is owner-gated. After the owner controls the NAME, add this top-level block to `scene.json`:

```json
"worldConfiguration": {
  "name": "ghostcharades.dcl.eth"
}
```

Keep `authoritativeMultiplayer: true`, do not add an offline fixed adapter, and leave Places opt-out unset.
Build, complete the device checklist, and deploy only after the owner approves the release.

## Roadmap to submission

- Complete the Android cold-start, rendering, safe-area, camera, persistence, invite, and performance checks.
- Buy and configure the target Decentraland NAME, then deploy the tested commit.
- Seed only through real playtests; never create synthetic visitors, charades, guesses, or leaderboard rows.
- Run the two-device live-round check and a blind five-minute solo judge audit before the release lock.

## License

[MIT](LICENSE) © 2026 Ridwan Nurudeen.
