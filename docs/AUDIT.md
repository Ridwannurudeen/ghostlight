# Final adversarial audit disposition

Audit baseline: `main` at `cae5e6b`, with 174 tests passing. This ledger keeps duplicate findings as separate
rows because each of the three independent reports must be accounted for. Line numbers identify the audited
baseline, before this fix pass.

| ID | Severity | Audited location | Status |
|---|---|---|---|
| C-01 | BLOCKER | `src/client/ui.tsx:429`, `:249` | FIXED (`3285294`) — authoring is phased and live reactions replace, rather than stack on, decode controls; every state has at most five buttons. |
| C-02 | BLOCKER | `src/client/ui.tsx:23`, `:287` | FIXED (`3285294`) — reveal uses one exit row and swaps answers for stats; a static vertical-budget regression covers the fixed panel. |
| C-03 | HIGH | `src/client/setup.ts:47`, `src/client/opening-scene.ts:26` | FIXED (`3285294`) — opening and reveal completion, skip, cancel, timeout, and instance replacement release virtual-camera ownership. |
| C-04 | HIGH | `src/client/flow.ts:888`, `src/client/reveal.ts:174` | FIXED (`3285294`) — timed-out guess and round-guess requests cancel and restore the active reveal. |
| C-05 | HIGH | `src/index.ts:118`, `src/client/flow.ts:906`, `src/client/ui.tsx:249` | FIXED (`3285294`) — opening and request/guess runtime boundaries require the physical decode area. |
| C-06 | HIGH | `src/client/ui.tsx:398` | FIXED (`3285294`) — secondary author-emote labels use dark ink; the unselected state has a regression. |
| C-07 | HIGH | `src/client/ui.tsx:367`, `src/client/flow.ts:1081` | FIXED (`3285294`) — reveal exits are centralized; Boards, Foyer, and Invite cancel and restore presentation state. |
| C-08 | HIGH | `src/client/flow.ts:638`, `:1124` | FIXED (`3285294`) — hello/profile/look state requires non-empty identity and avatar base, with continued polling from empty to complete data. |
| C-09 | HIGH | `src/client/ui.tsx:462`, `:606` | FIXED (`3285294`) — the posted-screen action navigates and copies on the first tap, then reports copied or failed state. |
| C-10 | MEDIUM | `src/index.ts:118`, `src/client/flow.ts:336` | FIXED (`3285294`) — a prefetched charade is buffered behind Since You Left until the report is dismissed. |
| C-11 | MEDIUM | `src/client/flow.ts:291`, `:667` | FIXED (`3285294`) — a new instance cancels opening/reveal work and clears instance-scoped UI, requests, performer, preview, reward, round, and audience state. |
| C-12 | MEDIUM | `src/client/flow.ts:1071`, `src/client/ghosts.ts:224` | FIXED (`3285294`) — author-preview cleanup no longer destroys a duet, and Back restores the prior solo/duet performer and stage reward. |
| C-13 | MEDIUM | `src/client/reveal.ts:213` | FIXED (`3285294`) — late outcomes restart outcome-dependent beats with readable relative spacing. |
| C-14 | MEDIUM | `src/client/ghosts.ts:44`, `:83` | FIXED (`3285294`) — an active duet reserves one audience slot, leaving seven custom ghosts plus the remote live player. |
| C-15 | MEDIUM | `src/client/ui.tsx:262`, `src/client/flow.ts:950`, `:384` | FIXED (`3285294`) — pending guesses block regular authoring and author flows record their explicit return screen. |
| C-16 | LOW | `src/client/reveal-scene.ts:143`, `src/index.ts:122` | FIXED (`3285294`) — notice IDs are consumed during reveal, so unlock/stamp audio has one playback. |
| S-01 | BLOCKER | `src/server/state.ts:387`, `src/shared/pick.ts:55` | ACCEPTED — only genuine production accounts can seed eligible content. `f367167` makes three recent current-theme performances, one real duet, cold rehydration, and daily renewal hard release gates; no engagement is synthesized. |
| S-02 | MEDIUM | `src/shared/messages.ts:79`, `src/server/server.ts:504`, `:470` | FIXED (`3285294`) — protocol v2 adds `requestId` to `nextCharade` and `charade`, coalesces identical selections, and ignores stale client replies. |
| S-03 | MEDIUM | `src/server/storage.ts:75`, `src/server/state.ts:553`, `src/server/server.ts:369` | FIXED (`3285294`) — bounded fresh reads plus exact-key listings distinguish confirmed absence; ambiguous, corrupt, or unavailable reads fail closed. |
| S-04 | MEDIUM | `src/server/storage.ts:149`, `src/server/server.ts:817` | FIXED (`3285294`) — checkpoints retry required dirty writes and acknowledgements follow durability; retry replays do not double-account. |
| S-05 | MEDIUM | `src/server/state.ts:572`, `src/server/server.ts:568` | FIXED (`3285294`) — exact seen IDs are retained for every performance still in the active 14-day pool. |
| S-06 | MEDIUM | `src/server/state.ts:507`, `:385` | FIXED (`3285294`) — the full daily decoder aggregate is persisted separately; only outbound boards are sliced to ten. |
| S-07 | MEDIUM | `src/server/server.ts:298`, `:449`, `src/server/state.ts:530` | FIXED (`3285294`) — connected negotiated clients detect UTC rollover and receive refreshed ready, progress, boards, and Ghost-of-the-Night state. |
| S-08 | MEDIUM | `src/server/server.ts:348`, `:329`, `src/server/rounds.ts:54` | FIXED (`3285294`) — foyer entrants do not join rounds; eligible requesters receive targeted active-round state and ineligible latecomers cannot block settlement. |
| S-09 | MEDIUM | `src/server/server.ts:350`, `src/server/state.ts:553` | FIXED (`3285294`) — all scene/player reads, listings, and writes share one 32-call semaphore. |
| S-10 | MEDIUM | `src/server/state.ts:335`, `:439`, `:568` | FIXED (`3285294`) — UTC rollover prunes expired live indexes/charades, inactive stats use a dirty-safe bounded cache, and authored history uses an exact count plus bounded IDs. |
| S-11 | MEDIUM | `src/shared/config.ts:11`, `src/server/server.ts:402`, `:436` | FIXED (`3285294`) — protocol v2 negotiation is tracked separately and gates every stateful handler until leave. |
| S-12 | LOW | `src/server/state.ts:52`, `:178`, `src/shared/messages.ts:87` | FIXED (`3285294`) — wire counters saturate at Int32 max and stored timestamps must be non-negative safe integers in the valid date range; the real codec is exercised. |
| A-01 | BLOCKER | `scene.json:17` | FIXED (`32ae040`) — the candidate declares `worldConfiguration.name: "ghostlight.dcl.eth"`; ownership remains an explicit owner gate. |
| A-02 | BLOCKER | `src/server/state.ts:387`, `src/server/server.ts:522` | ACCEPTED — this duplicates S-01 and cannot be truthfully repaired with repository-generated activity. The hard genuine-content and cold-rehydration gates are in `f367167`. |
| A-03 | HIGH | `src/client/ui.tsx:429` | FIXED (`3285294`) — duplicate of C-01; all-state regressions include live reactions. |
| A-04 | HIGH | `scene.json:18`, `docs/PERFORMANCE.md:17`, `test/asset-budget.test.ts:187` | FIXED (`32ae040`) — two adjacent parcels are declared and exact theater plus capped reward instancing is tested at 16,492 triangles and 79 entities. |
| A-05 | HIGH | `src/client/flow.ts:1124` | FIXED (`3285294`) — duplicate of C-08; empty-to-complete identity and avatar-base recovery is covered. |
| A-06 | HIGH | `scene.json:25`, `src/client/theater.ts:40` | FIXED (`32ae040`) — spawn is moved to the clear foyer and scene/composite values plus all range corners are tested. |
| A-07 | HIGH | `src/shared/config.ts:2`, `src/client/ui.tsx:586` | FIXED (`3285294`, `f367167`) — copy and documentation now describe an honest general World invite, not targeted-charade routing. |
| A-08 | HIGH | `docs/SUBMISSION.md:94` | ACCEPTED — this checkout has no public remote and publication requires owner approval. `f367167` removes broken relative links and hard-gates insertion of verified absolute repository and licence URLs. |
| A-09 | MEDIUM | `src/shared/config.ts:10`, `src/server/state.ts:351` | FIXED (`3285294`, `f367167`) — the intentional 14-day serving window is actively pruned and explicitly documented with a daily renewal gate. |
| A-10 | MEDIUM | `test/integration.test.ts:47` | FIXED (`3285294`) — every registered message round-trips through the pinned SDK codec, Int64/Int32 boundaries are asserted, and encoded envelopes remain below 4 KB. |
| A-11 | MEDIUM | `test/integration.test.ts:423` | FIXED (`3285294`) — cold-start traffic is dropped, repeated two-second heartbeats are advanced, and a post-ready hello recovers the session. |
| A-12 | MEDIUM | `src/client/rewards.ts:50`, `src/server/server.ts:276` | FIXED (`3285294`, `32ae040`) — reward rendering retains the 16 nearest titled visitors plus one reusable stage slot and the exact peak is budget-tested. |
| A-13 | MEDIUM | `tools/audio/build_sounds.py:76` | FIXED (`32ae040`) — room tone is overlap-cropped, MP3 gapless metadata is retained, decoded length/seam are measured, and regenerated output is deterministic. |
| A-14 | LOW | `test/ghosts.test.ts:92` | FIXED (`3285294`) — each test resets modules/mocks and initializes its own ghost system; shuffled-order isolation is covered. |
| A-15 | LOW | `tools/audio/build_sounds.py:248` | FIXED (`32ae040`) — manifest peaks are measured from each encoded/decoded file. |
| A-16 | LOW | `scene.json:8` | FIXED (`32ae040`) — the missing deprecated favicon and empty email scaffold fields are removed from scene and composite metadata. |

## Counts

| Severity | Findings | Fixed | Accepted | Disputed |
|---|---:|---:|---:|---:|
| BLOCKER | 5 | 3 | 2 | 0 |
| HIGH | 13 | 12 | 1 | 0 |
| MEDIUM | 21 | 21 | 0 | 0 |
| LOW | 5 | 5 | 0 | 0 |
| **Total** | **44** | **41** | **3** | **0** |

By report: CLIENT 16 fixed; SERVER/SHARED 11 fixed and 1 accepted; ASSETS/TESTS/DOCS 14 fixed and 2 accepted.

## Only a device or production can verify

- Android/iOS safe areas, five-control presentation, touch reach, font fallback, legibility, joystick access, and
  camera control while physically walking between foyer and stage.
- Real mobile audio latency, reveal mixing/ducking, and whether the measured gapless room-tone boundary is inaudible.
- Clipboard and HTTPS/decentraland deep-link handoff on current Android and iOS clients.
- Cold server wake, dropped mobile traffic, reconnect ordering, actual Storage persistence after server sleep, and
  live UTC-midnight refresh without reconnecting.
- Two-phone round races, Answer-Back choreography, remote reward attachment, name-tag behavior, and mobile avatar
  animation throttling at the seven-custom-plus-one-live budget.
- The Galaxy A54 High-profile score above 90% through the documented stress pass.
- World-name ownership, public repository/licence URLs, and a production pool containing at least three eligible
  genuine current-theme performances plus a genuine duet throughout judging.

## Owner's exact pre-deploy and release checklist

1. Confirm ownership of `ghostlight.dcl.eth`; verify `scene.json` still has that exact `worldConfiguration.name`,
   `authoritativeMultiplayer: true`, parcels `0,0` and `1,0`, and no `fixedAdapter` or `placesConfig.optOut`.
2. Publish this repository, verify its public HTTPS repository and `LICENSE` URLs, and replace the preparation note
   in `docs/SUBMISSION.md`. Do not invent or retain relative links.
3. On the exact candidate commit, require a clean worktree, the pinned
   `7.27.1-33086747846.commit-824d240` SDK/runtime versions, `npm ci`, `npm run build`, and `npm test` all green;
   complete the SDK compatibility merge gate in `docs/DEVICE-CHECKLIST.md`.
4. Obtain the owner's explicit approval before merge or deployment. Do not start a second preview server and do not
   use `fixedAdapter` or opt out of Places. Any later SDK pin change invalidates the evidence and restarts acceptance.
5. In the deployed World, create at least three genuine current-theme charades less than 14 days old from distinct
   real accounts other than the fresh judge, plus at least one genuine Answer-Back duet. Never fabricate activity.
6. Let the server sleep, then use a fresh named account to prove that production Storage rehydrates and serves the
   genuine performances and duet instead of a House-only venue. Record authors, themes, UTC ages, and duet status.
7. Complete every item in `docs/DEVICE-CHECKLIST.md` on Galaxy A54 High and a supported iPhone, including the full
   solo loop, two-phone race/duet, clipboard handoff, midnight refresh, cold wake, audio, and greater-than-90%
   performance evidence.
8. Check the real-content ledger daily through judging and renew genuine current-theme performances before the
   14-day serving boundary.
9. Fill only the two owner slots, `<WORLD LINK>` and `<MEASURED: ...>`, add the verified absolute public links, and
   capture the six screenshots plus real-device video from the exact tested commit.
10. Obtain explicit owner approval again before any DoraHacks submission, Discord featuring post, repository push,
    or other external publication action.
