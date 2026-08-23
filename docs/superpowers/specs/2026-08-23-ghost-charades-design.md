# Ghost Charades — Design Spec

**Event:** Decentraland Friendzone Mobile Buildathon (DoraHacks). Deadline shown on the campaign page:
2026-09-04 00:00 (timezone not stated — our wall is **Tue 2 Sep 18:00 local**). Judging 5–11 Sep, every
entry played by a judge **alone, in the Decentraland mobile app**, unsupervised.
**Status:** design approved by the owner 2026-08-23 (concept chosen over eight alternatives; Codex and Claude
agreed on it twice). Nothing built yet.

## 1. The one-sentence hook

> **Guess what a stranger's ghost is acting out — then leave your own charade for whoever comes next.**

A small theater. On stage, a clone of a *real* previous visitor — their actual avatar and outfit — performs
three emotes. A banner asks **"WHAT IS MAYA SAYING?"** and three huge buttons offer answers. Tap. The
audience (clones of the last six real visitors) claps or facepalms. Reveal. Then you are dealt a phrase,
pick three emotes, and your ghost takes the stage for the next stranger.

It is communication across time: the purest form of "social" the judges ask for, and it works at full
strength with one person in the room. When two or more are present it becomes a race.

## 2. What a winning entry must do (derived from the brief, the T&C and the judging format)

- Pass the hard gates: deployed to a World, persistent, standalone (no host), tested on mobile, open source
  (MIT), original, submitted on DoraHacks with text that explains mobile design, social interaction, and
  why people return/share/invite.
- Never be an "empty venue" or "single-player" — the disqualifiers. Every stage performance and every audience
  seat is a real person; the judge's first ten seconds must show that.
- Never inflate engagement (T&C §12). Seeding is done only by real play — us, friends, and a public
  playtest announced in the Friendzone Discord. The only non-player content is a **house charade** labelled
  "House" for the case where nothing real is waiting, and it is never counted in stats.
- Be legible on a phone in ten seconds, with zero typing, zero gestures, zero precision aiming.
- Hide the Multiplayer Server's ~15 s cold start — the judge must never see a blank room.
- Hold > 90 % Performance on the High profile on a Galaxy A54 (the organisers' reference device).

## 3. The judge's five minutes (solo)

| t | What happens | What proves it is social |
|---|---|---|
| 0–15 s | Spawn at the theater foyer. A short walk to the house doors (this hides the server cold start). UI: "The theater is waking up…" until the server heartbeat is live, then "Tonight's ghosts are ready." | — |
| 15–25 s | Enter the house. Six clones of the last six real visitors sit in the front row, idling. The stage is lit. A clone walks on (a real player's look, their display name on the banner). | Real names, real outfits, "last here 18 min ago". |
| 25–45 s | The ghost performs three emotes in a loop. Banner: **WHAT IS MAYA SAYING?** Three big answer buttons + **Replay**. | You are decoding a specific person. |
| 45–60 s | Tap an answer. Audience reacts (clap / shrug). Reveal: Maya's phrase, "7 of 11 got it", your decoder score. **Next ghost** / **Make your own**. | Maya will see your guess on her return. |
| 1–2 min | Two or three more charades (each 20–30 s). | Every one is a different real person. |
| 2–3 min | **Make your own**: dealt a phrase (Shuffle ×2 allowed), pick three emotes from five big buttons in order, **Preview** (your own avatar performs it), **Post**. "Your ghost is on stage for the next stranger." | Your performance persists for others. |
| 3–4 min | **Invite** button copies a link ("Can you decode my ghost?"). Leaderboard: top decoders today, hardest ghosts. | Reason to share. |
| next visit | "Since you left: 4 people tried to decode you — 1 got it." | Reason to return. |

**With 2+ present:** everyone in the house sees the same charade as a *round*; the first correct guess
wins the round and gets "author next"; reaction buttons (laugh / confused / genius) trigger emotes on the
pressing player's avatar, visible to all.

## 4. Scoring doctrine — one decision per official criterion

| Criterion | The decision that wins it |
|---|---|
| Mobile-First Experience | The whole loop is walk-to-stage + tap big buttons. Custom HUD: joystick only, every native gamepad button hidden (`TouchScreenControls.hideAll()`), all actions are ReactEcs buttons. |
| Social Value | Every performance is a real player; guesses feed back to the author; audience is real visitors; live race when 2+. Communication is the mechanic — and the mobile client itself has no DMs, voice, or scene chat. |
| Mobile UX and Accessibility | `screenInset: 'interactable'` on mobile, bottom-right corner always empty, three answer buttons ≥ 96 px tall, one sentence of copy per screen, no typing anywhere, guests can play. |
| Performance and Optimization | ≤ 8 avatar clones in view (1 performer + 6 audience + 1 preview), all within 10 m of the camera; staggered spawns; primitives + ≤ 10 catalog props; no particles, no dynamic lights. |
| Creativity and Originality | Asynchronous charades performed by real players' ghosts — nothing like it among DCL's six official mobile sample scenes. |
| Retention and Discovery Value | "Who decoded me" on return, daily decks, decoder/hardest-ghost boards, in-scene invite link, auto-listed on Places. |
| Overall Execution | One loop, finished and stable; a blind five-minute phone audit on 30 Aug with repair aimed at the lowest-scoring criterion; 48-hour internal lock. |

## 5. Architecture

### 5.1 Runtime split
Decentraland SDK 7, TypeScript, ECS. `@dcl/sdk@auth-server` + `@dcl/js-runtime@auth-server`
(the Multiplayer Server branch; a commit-suffixed pre-release tag — **pin the resolved version in
`package-lock.json` and do not upgrade after 28 Aug**). `scene.json`: `"authoritativeMultiplayer": true`,
`worldConfiguration.name = <NAME>.dcl.eth`, **never** `fixedAdapter: "offline:offline"`,
`placesConfig.optOut` unset.

```
src/
  index.ts            main(): isServer() ? startServer() : startClient()
  shared/
    messages.ts       registerMessages({...}) — every payload a Schemas.Map; imported by both sides
    deck.ts           phrase deck (static content), decoy rules, emote vocabulary
    types.ts          Charade, Look, PlayerStats, schema version constants
    pick.ts           pure functions: chooseCharadeFor(), pickDecoys(), dealPhrase(), offerEmotes()
  server/
    server.ts         room.onMessage handlers, heartbeat, player enter/leave
    state.ts          in-memory state, hydration from Storage, dirty set + flush
    storage.ts        checked Storage writes (every boolean handled), key schema, migrations
    rounds.ts         live round logic when 2+ present
  client/
    setup.ts          platform detect, HUD (TouchScreenControls), virtual screen, camera
    theater.ts        stage, seats, doors, lighting props
    ghosts.ts         AvatarShape clones: performer, audience, preview; emote sequencing (lamport re-trigger)
    ui.tsx            ReactEcs screens: waking, decode, reveal, author, invite, boards
    flow.ts           client state machine; readiness gate; retries
```

### 5.2 Messages (client → server unless noted)
| name | payload | notes |
|---|---|---|
| `hello` | `{ displayName, isGuest, protocolVersion }` | on enter; server replies `ready` + `welcome` |
| `ready` (s→c) | `{ instanceId, serverTime }` | also used as the heartbeat answer |
| `ping` | `{ seq }` | every 2 s until `ready`; then every 10 s |
| `nextCharade` | `{ exclude: string[] }` | server replies `charade` |
| `charade` (s→c) | `{ id, authorName, authorAddress, look, emotes[3], answers[3], createdAt, isHouse }` | answers are shuffled; correct index is NOT sent |
| `guess` | `{ charadeId, answerIndex, requestId }` | one per charade per player; server replies `reveal` |
| `reveal` (s→c) | `{ charadeId, correct, phrase, stats: { total, correct }, yourScore }` | |
| `post` | `{ phraseId, emotes[3], requestId }` | server snapshots the player's look from `AvatarBase` + `AvatarEquippedData` on the **server-side** player entity (never trusts the client) |
| `posted` (s→c) | `{ charadeId }` | |
| `since` (s→c) | `{ triedYou, gotYou, rank }` | sent after `hello` for returning players |
| `audience` (s→c) | `{ looks: Look[≤6] }` | the last six distinct real visitors |
| `boards` (s→c) | `{ topDecoders[10], hardestGhosts[10] }` | |
| `round*` | live-round messages (start, guessResult, winner) | only when ≥ 2 players present |
| `react` | `{ kind }` | triggers an emote on the sender's avatar client-side; server relays to others |

All payloads < 4 KB (hard transport cap is ~13 KB; oversize is silently dropped).

### 5.3 Storage (world scope unless noted; all values JSON strings with a `v` field)
| key | value |
|---|---|
| `gc:v1:charade:{id}` | `{ v, id, author: { address, name, isGuest }, look, phraseId, emotes[3], createdAt, guesses: { total, correct }, lastGuessAt, isHouse }` |
| `gc:v1:index:{YYYY-MM-DD}` | `string[]` of charade ids created that day (daily shards keep each value small) |
| `gc:v1:recentVisitors` | `Look[≤6]` with `{ address, name, lastSeenAt }` |
| `gc:v1:boards:{YYYY-MM-DD}` | `{ decoders: {address,name,correct,total}[], hardest: {charadeId, authorName, total, correct}[] }` |
| player `gc:v1:stats` | `{ v, name, decoded, correct, seen: string[≤200], authored: string[], lastSeenAt, pending: { triedYou, gotYou } }` |

Rules (from the docs): strings only; `Storage.set()` resolves `false` on failure and **never throws** —
every write goes through `storage.ts`, which keeps a dirty set and flushes every 30 s and at checkpoints
(post, guess, leave), at most 8 writes in flight (the isolate cap is 40 host calls total and excess rejects
immediately). Reads are defensive (`try/catch`, defaults, `v` check). Storage survives redeploys; there is
no TTL.

### 5.4 Selection rules (pure functions in `shared/pick.ts`, unit-tested)
- `chooseCharadeFor(player, pool)`: exclude own and already-seen; prefer charades with the fewest guesses,
  then oldest; never two by the same author in a row; if the pool is empty → the house charade (`isHouse`).
- `pickDecoys(phrase, deck)`: two phrases from the same category, never the same first word, seeded by
  `charadeId` so the three options are stable for that charade.
- `dealPhrase(deck, exclude)`: uniform over categories, then phrases; `Shuffle` allowed twice.
- `offerEmotes(phrase)`: the phrase's three suggested emotes + two random from the vocabulary, shuffled.

### 5.5 Ghost rendering (client)
- `AvatarShape` per ghost: `id` = the author's real `0x…` address (gives the mobile client a cheap
  pre-baked body texture), `name` = display name (an empty name or "NPC" hides the tag), `bodyShape`,
  `skinColor`, `hairColor`, `eyeColor`, `wearables` from the stored look. Paid wearables render for everyone.
- Emote sequencing: `expressionTriggerId = emotes[i]`, `expressionTriggerTimestamp` incremented on every
  trigger (a lamport counter); a client system advances `i` every 2.5 s and loops the trio.
- Emote vocabulary (the documented list that the mobile client also ships): `wave fistpump robot raiseHand
  clap money kiss shrug handsair disco dab dontsee hammer tektonik tik headexplode`.
- Budget: 1 performer + 6 audience + 1 preview = 8 (the mobile client animates the 8 nearest at full rate).
  Everything within 10 m of the stage camera (name tags fade between 10 and 15 m). Spawn ≤ 3 per second.
- Stage camera: a `VirtualCamera` framing the performer while the player is in the decode area
  (`fov` is ignored on mobile — frame by position only); released when the player leaves the area.

### 5.6 Mobile HUD and UI
- `getPlatform()` polled until non-null (it is `null` on the first frames); then
  `TouchScreenControls.hideAll()` (joystick stays), `ReactEcsRenderer.setUiRenderer(ui, { screenInset:
  isMobile() ? 'interactable' : 'device' })`, explicit virtual screen `1600×720` on mobile.
- Screens: Waking · Decode (banner + 3 answers + Replay) · Reveal · Author (phrase + Shuffle, 5 emote
  buttons, Preview, Post) · Boards · Invite. Each screen: one sentence, big buttons, nothing bottom-right.
- Invite: `copyToClipboard({ text: 'Can you decode my ghost? https://decentraland.org/jump/?realm=<NAME>.dcl.eth' })`.
  Whether that https link opens the mobile app is **unverified** — day-1 test on the Android; fallback
  `decentraland://?realm=<NAME>.dcl.eth`.

### 5.7 Cold start and readiness
The server shuts down ~2 min after the last player leaves and cold-starts in ~15 s; messages sent before
it is ready are silently lost. The foyer walk covers it; the client sends `ping` every 2 s and shows the
Waking screen until `ready`; every request carries a `requestId` and is retried once after 5 s. After a
deploy, players already inside stay on the old instance until they rejoin — testers always leave and
re-enter after each deploy.

### 5.8 Abuse and fairness
No free text anywhere (phrases from the deck; names from DCL profiles). Guests may decode and author;
their stats live only for the session (no stable address). One guess per charade per address, enforced
server-side. Authoring rate-limited to one post per 60 s per address. Looks are snapshotted server-side,
never accepted from the client.

## 6. Content
- Deck v1: **120 phrases** in six categories (everyday, feelings, food, crypto/DCL life, pop culture,
  awkward moments), each with three suggested emotes and a category tag for decoys. Shipped as static
  TypeScript; no runtime AI, no external calls.
- One house charade, labelled **House** on the banner and excluded from boards.

## 7. Testing
- **Unit (vitest):** `shared/pick.ts`, `shared/deck.ts` integrity (every phrase has ≥ 2 same-category
  decoys and 3 valid emotes), `server/storage.ts` dirty-set/flush/retry with a fake `Storage` that returns
  `false`, `server/state.ts` hydration + migration, round logic.
- **Device (manual, Android, real app via the QR preview):** checklist run before every deploy: cold
  start hides behind the foyer; ghost with real wearables renders and loops; six audience clones; all
  buttons reachable with a thumb; no UI bottom-right; Performance > 90 % on High; leave/rejoin keeps state;
  invite link opens the app.
- **Blind solo-judge audit (30 Aug):** one person who has never seen it plays five minutes alone; score
  1–5 on all seven criteria; 31 Aug fixes the lowest axis.

## 8. Schedule (owner-only items marked ★)
| Day | Deliverable | Gate |
|---|---|---|
| Sun 24 Aug | Scaffold + auth-server pinned; Storage round-trip; **phone spike**: one `AvatarShape` with the player's own look looping three emotes on the Android; invite-link behaviour; `getPlatform` timing. ★ Buy the NAME (100 MANA) at builder.decentraland.org/names. | Spike green on device |
| Mon 25 Aug | (BNB deploy in the morning.) Server state + `chooseCharadeFor` + decode/reveal loop in preview. | Loop closes solo in preview |
| Tue 26 Aug | Author flow, deck v1 (60 phrases), persistence flush, returning-player `since`. **Decision point:** auth-server stable on the phone, else `signedFetch` to a tiny API on the Contabo box. | Persistence survives restart |
| Wed 27 Aug | Mobile HUD, safe areas, stage camera, audience clones + reactions, theater dressing. | Device checklist green |
| Thu 28 Aug | First deploy to the World; live rounds with two phones; invite; boards. | Two devices, one round |
| Fri 29 Aug | Seeding playtest #1 (friends + Friendzone Discord); deck to 120; perf pass. | ≥ 20 real charades |
| Sat 30 Aug | Blind solo-judge audit; video recorded **before** polish. | Scores recorded |
| Sun 31 Aug | Lowest-axis repair; README; submission text; playtest #2. | — |
| Mon 1 Sep | Buffer. Freeze at 18:00. | RC deployed, testers rejoined |
| Tue 2 Sep 18:00 | ★ Submit on DoraHacks (owner approves and clicks). | Submitted |
| 3–11 Sep | Deploy freeze; daily two-minute in-app check; friends drop in — real people only. | — |

Real build window is ~9 days (BNB obligation 25 Aug, ETHOnline starts 4 Sep).

## 9. Must-ship vs cut ladder
**Must ship:** decode → reveal → author → post loop · real-player ghosts with real looks · persistence
across server restarts and redeploys · six-seat audience · waking screen + foyer · mobile HUD/insets ·
house charade (labelled) · invite link · submission package.
**Cut first → last:** boards presentation (keep raw counts) → live-round race (keep "same charade for all")
→ reaction buttons → theater dressing beyond primitives + lighting → audience reactions (keep idle clones)
→ `since` summary (keep counts in stats). Never cut: the loop, real ghosts, persistence, the waking screen.
**Performance ladder:** props → audience 6→4 → stage camera → textures.

## 10. Risks
| Risk | Mitigation |
|---|---|
| auth-server pre-release flakes on the phone | Pin; day-3 decision point; `signedFetch` fallback with identical data model |
| Blank room during cold start | Foyer walk + Waking screen + retries (built day 1) |
| Nothing real to decode when the judge arrives | Seeding playtests 29 + 31 Aug; house charade as the honest floor |
| Ghost rendering cost | 8-clone budget, 10 m radius, staggered spawns; fallback: audience as `AvatarTexture` portraits |
| Guess feels like a coin flip | Decoys from the same category + suggested emotes per phrase; stats show skill over rounds |
| Deadline timezone ambiguity | Wall is 2 Sep 18:00 |

## 11. Submission package (built 31 Aug, locked 2 Sep)
DoraHacks BUIDL: hook sentence, the three required explanations (mobile, social, return/invite), one
measured number ("> 90 % on High on <device>"), World link, portrait screenshots, 2–3 min phone-recorded
video (solo decode, author, then two phones racing). README: concept, controls, architecture, run-from-
scratch, MIT license, roadmap. Owner approves the text and clicks submit.
