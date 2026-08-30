# Security hardening audit

Audit baseline: `main` at `e05bb9af64ac945ee5753113cdf6022dc66a2bff`, with 245 tests passing. The
reported locations below are the reviewers' baseline coordinates. Duplicate or overlapping findings remain separate
rows so every finding in all three reports has an explicit disposition.

This ledger remains historical evidence for the audited `7.26.1-32239895147.commit-3c77d90` SDK tree. It does not
certify the current `7.27.1-33086747846.commit-824d240` compatibility candidate; its Storage behavior and dependency
tree require the current checks below.

Source report abbreviations:

- **MV** — Message Validation and Access Control Review
- **RI** — Resource Limits and Stored-Data Integrity Review
- **RF** — Rendering, Client Resilience, Dependencies and Fairness Review

| ID | Source report | Severity | Reported file:line | Status |
|---|---|---|---|---|
| MV-01 | MV | CRITICAL | `src/shared/messages.ts:81`; `src/server/server.ts:178,640,650,781` | FIXED (`ee5c75b`) — request IDs, exclusions, application payloads, per-session concurrency, token-bucket admission, replay counts, owner counts, and cache lifetimes are bounded; served answers are consumed. |
| MV-02 | MV | HIGH | `src/server/server.ts:579,612`; `src/shared/pick.ts:31,93`; `src/client/flow.ts:854` | FIXED (`ee5c75b`) — player answer sets use server-private entropy. House performances remain recognizable from the shipped deck, so House guesses are explicitly noncompetitive and cannot win a live round or grant an authoring turn. |
| MV-03 | MV | HIGH | `src/server/server.ts:743,787,1007`; `src/server/state.ts:570` | FIXED (`ee5c75b`) — Ghost Mail posts and guesses do not advance public totals, boards, stamps, titles, or daily progression. |
| MV-04 | MV | HIGH | `src/server/server.ts:656,731,919,1046`; `src/server/state.ts:640` | FIXED (`ee5c75b`) — guest posts, mail, answer-backs, reactions, ranked guesses, title broadcasts, and persistent global effects are rejected or session-local; persisted guest decoder rows are filtered during hydration. |
| MV-05 | MV | HIGH | `src/server/server.ts:806,895` | FIXED (`ee5c75b`) — posts and answer-backs require three distinct valid emotes before any mutation. |
| MV-06 | MV | HIGH | `src/server/rounds.ts:55,74,90`; `src/server/server.ts:411` | FIXED (`ee5c75b`) — rounds snapshot participants, expire after 45 seconds, support abstention, exclude ineligible latecomers, and cannot be extended by an idle joiner. |
| MV-07 | MV | MEDIUM | `src/server/server.ts:510,515,549,957` | FIXED (`ee5c75b`) — presence and monotonic session generations are checked after awaited boundaries and before mutation or targeted follow-up sends; leave cleanup is exception-safe and production callbacks contain rejected promises. |
| MV-08 | MV | LOW | `src/server/server.ts:92,105`; `src/client/flow.ts:868` | FIXED (`afa9022`) — names are NFKC-normalized, trimmed, byte-bounded, stripped of Unicode control/format characters, protected from reserved first-party labels, and bidi-isolated when rendered. |
| RI-01 | RI | CRITICAL | `src/server/storage.ts:113-127`; installed SDK `scene.ts:159-166,239-244`; `player.ts:172-179,257-262` | ACCEPTED — mitigated by fresh reads plus a scoped write/read health sentinel that blocks the reported all-null/all-empty failure path. The pinned SDK still collapses a failed point read to `null` and a failed listing to an empty result (`node_modules/@dcl/sdk/server/storage/scene.js:101,164`; `player.js:106,173`), so an isolated per-key failure remains indistinguishable from a missing key. No exposed status-preserving adapter exists. |
| RI-02 | RI | CRITICAL | `src/server/server.ts:178-187,651-694,781-782` | FIXED (`ee5c75b`) — same disposition and regression coverage as MV-01, including pre-hydration admission and hello/ping traffic. |
| RI-03 | RI | CRITICAL | `src/server/storage.ts:162-225`; `src/server/server.ts:201-209` | ACCEPTED — the exhaustion and unbounded-host-work portions are fixed with atomic admission, 256 entries, 512 KiB total, 128 KiB per value, 32-write batches, bounded retries, rotation, and guaranteed leave cleanup. Residual: one permanently failing historical key still makes the global checkpoint fail after bounded work because operations do not have key-scoped checkpoint manifests. |
| RI-04 | RI | CRITICAL | `src/server/storage.ts:131-143`; `src/server/state.ts:430-436` | FIXED (`22f37ee`) — malformed leaf charades are quarantined; malformed foundational data enters House-only read-only mode instead of blocking hydration or installing writable empty defaults. |
| RI-05 | RI | CRITICAL | `src/server/state.ts:70-80,255-365,389-435` | FIXED (`22f37ee`) — raw values are rejected above 128 KiB before parsing, and every stored array/string/look migration has explicit count and UTF-8 byte limits before materialization. |
| RI-06 | RI | CRITICAL | `src/server/state.ts:372-377,517-529,625-635` | FIXED (`22f37ee`) — live storage is capped at 128 charades per day and 512 across retention; capacity rejection occurs before post mutation. |
| RI-07 | RI | CRITICAL | `src/server/state.ts:570-612` | FIXED (`22f37ee`) — daily decoders retain at most 256 stable-wallet rows; guest and migrated unstable rows cannot enter public boards. |
| RI-08 | RI | CRITICAL | `src/server/state.ts:255-300`; `src/server/storage.ts:4-20`; `src/shared/types.ts:3` | ACCEPTED — future player versions now fail read-only and are never replaced with defaults. A previously deployed binary cannot be made to honor a new rollback sentinel, and the additive-only constraint rules out a breaking namespace migration in this pass. Operational control: never roll back a deployment across storage schema versions. |
| RI-09 | RI | HIGH | `src/server/server.ts:383-404`; `src/server/state.ts:446-455` | FIXED (`ee5c75b`) — hard collection limits precede work; round selection builds one seen set and selects in one pass; board payloads are computed once and fanned out; request admission bounds repeated work. |
| RI-10 | RI | HIGH | `src/server/state.ts:517-529`; `src/server/storage.ts:184-225` | ACCEPTED — batch admission prevents mutation when the complete immediate write set cannot enter the bounded dirty queue, and acknowledgements wait for checkpoints. The pinned Storage API exposes only independent `get`, `set`, `delete`, and listing calls—no transaction or compare-and-swap—so a crash or later capacity failure can still split charade, stats, board, and decoder writes. A correct recoverable two-phase manifest is beyond a safe additive final-pass change. |
| RI-11 | RI | HIGH | `src/server/server.ts:902-915,1004-1017` | FIXED (`ee5c75b`) — all sender, recipient, and author reads complete before mutation; corrupt prerequisites return `storage-unavailable` without consuming the operation; retries checkpoint instead of claiming unverified durability. |
| RI-12 | RI | HIGH | `src/server/state.ts:209-252`; `src/server/server.ts:579-597` | FIXED (`22f37ee`) — migration requires current deck membership, invalid leaves are quarantined, and send-time invalidity immediately falls back to a House charade. |
| RI-13 | RI | HIGH | `src/server/state.ts:625-637` | FIXED (`22f37ee`) — a monotonic accepted UTC-day high-water mark prevents backward-clock pruning or aggregate overwrite. |
| RI-14 | RI | MEDIUM | `src/server/storage.ts:87-100` | FIXED (`22f37ee`) — semaphore release reserves the permit for the next waiter, the queue is bounded, and draining no longer uses repeated array shifts. |
| RI-15 | RI | MEDIUM | `src/server/server.ts:219-231,515-546,957-1036` | FIXED (`ee5c75b`) — same session-generation, cleanup, and stale-response protections as MV-07, including rollover, welcome, prerequisite, charade-reply, and checkpoint races. |
| RI-16 | RI | MEDIUM | `src/server/state.ts:64-67,209-252` | FIXED (`22f37ee`) — stored timestamps must match their shard and stay within a five-minute future-skew allowance; future stamp and daily dates are rejected. |
| RI-17 | RI | LOW | `src/server/state.ts:146-150` | FIXED (`22f37ee`) — stored color channels must be finite SDK-range values from 0 through 1; local avatar previews apply the same rule. |
| RF-01 | RF | CRITICAL | `src/client/flow.ts:678,1185`; `src/client/ui.tsx:591` | FIXED (`2cfb68a`) — each Ghost Mail choice displays a portrait and shortened full wallet discriminator, and sending requires a separate confirmation step. Name normalization and reservation prevent label spoofing. Server recipient authorization remains unchanged and strict. |
| RF-02 | RF | HIGH | `src/server/server.ts:919,992`; `src/server/state.ts:490,570` | FIXED (`ee5c75b`) — same stable-identity and guest exclusion controls as MV-04, including playbill, Crowd Pleaser performances, decoder rows, titles, stamps, and persistent content. |
| RF-03 | RF | HIGH | `src/client/flow.ts:929` | FIXED (`2cfb68a`) — reveal and posted messages carry the originating request ID and are accepted only for the exact pending operation; completed duplicates are ignored. |
| RF-04 | RF | HIGH | `src/shared/messages.ts:171`; `src/client/flow.ts:993` | FIXED (`ee5c75b`) — round start/winner messages carry monotonic round IDs and charade IDs; stale or unrelated broadcasts are ignored. |
| RF-05 | RF | HIGH | `src/shared/messages.ts:50`; `src/client/flow.ts:977`; `src/client/ui.tsx:703`; `src/shared/i18n.ts:767` | FIXED (`2cfb68a`) — external titles are runtime-validated, invalid values become no-title, i18n has a safe fallback, and playbill input/rendering is capped at six. |
| RF-06 | RF | MEDIUM | `src/client/flow.ts:756` | FIXED (`2cfb68a`) — hello sends a normalized 32-byte fallback-capable name and retries negotiation after `protocol-required`; identity authority still comes from the server context/profile snapshot. |
| RF-07 | RF | MEDIUM | `src/client/flow.ts:1245,1395`; `src/client/ghosts.ts:289` | FIXED (`2cfb68a`) — local previews sanitize URNs, colors, body shape, address/name bytes, per-wearable bytes, wearable count, and the 2,800-byte look budget before `AvatarShape` mutation. |
| RF-08 | RF | MEDIUM | `src/client/flow.ts:838` | FIXED (`2cfb68a`) — persisted player progress has a monotonic saturated revision carried by progress, reveal, posted, and since messages; older revisions cannot regress UI or reward state. |
| RF-09 | RF | MEDIUM | `src/client/flow.ts:451`; `src/client/rewards.ts:57` | FIXED (`2cfb68a`) — guest titles are neither broadcast nor rendered, and reward candidates are rebuilt as a stable-wallet-only bounded set. |
| RF-10 | RF | LOW | `src/client/flow.ts:977`; `src/client/ui.tsx:715` | FIXED (`2cfb68a`) — playbill receive and render paths independently cap at six. |
| RF-11 | RF | LOW | `package.json:18`; `package-lock.json:2530,4286` | ACCEPTED — the immutable SDK tree currently reports 15 vulnerable package nodes (`1 critical, 7 high, 5 moderate, 2 low`; registry metadata has grown from the report's 14). `npm audit --omit=dev` reports zero, but that is not treated as proof: `bin/index.js` includes protobuf's minimal reader/writer. It does not include protobuf reflection, parser, JSON-descriptor expansion, or code-generation modules, and the application uses fixed nonrecursive schemas plus semantic bounds. The artifact does not contain `extract-zip`, `esbuild`, `ts-deepmerge`, `cookie`, IPFS, or Catalyst vulnerable modules; Inspector asset-pack code is present, but its vulnerable `ts-deepmerge` dependency is not. No demonstrated player-message exploit exists. The SDK pin cannot be upgraded or overridden in this pass. |
| RF-12 | RF | LOW | `package-lock.json:2530,5100` | ACCEPTED — `npm ls --all` still reports SDK-hoisted `esbuild@0.18.20` invalid for Vitest's Vite 8.2.2 optional path. Vitest is now pinned exactly, `npm ls --depth=0` passes, and build/tests do not use that Vite path. Resolving the peer would require a prohibited SDK-tree override or pin change. |
| RF-13 | RF | LOW | `.github/workflows/ci.yml:3` | FIXED (`36cc514`) — CI declares `contents: read`, disables persisted checkout credentials, pins actions to full verified commit SHAs, uses `npm ci`, and verifies direct dependency installation. |

## Counts

| Severity | Findings | Fixed | Accepted | Disputed |
|---|---:|---:|---:|---:|
| CRITICAL | 10 | 7 | 3 | 0 |
| HIGH | 14 | 13 | 1 | 0 |
| MEDIUM | 8 | 8 | 0 | 0 |
| LOW | 6 | 4 | 2 | 0 |
| **Total** | **38** | **32** | **6** | **0** |

By report: MV has 8 fixed; RI has 13 fixed and 4 accepted; RF has 11 fixed and 2 accepted.

## Accepted residual risk

The remaining storage risks are accepted because the pinned SDK erases some read-error semantics and exposes no
transaction/CAS primitive. The hardening converts the original isolate-exhaustion and silent-default-overwrite paths
into bounded, mostly fail-closed behavior: raw values, collections, dirty bytes, host work, handler concurrency, and
replay state all have hard ceilings; corrupt foundations become read-only; acknowledgements wait for checkpoints.
The residual is temporary write unavailability or a crash-consistency split during an actual storage failure, not an
unbounded attacker-controlled allocation. A permanently failing dirty key can still block later global checkpoints
after bounded work. This is acceptable only with the owner controls below, especially no cross-schema rollback and a
real cold-recovery test before publication.

The dependency residual is accepted because the SDK pin is a non-negotiable compatibility input. Most vulnerable
tooling modules are absent from the built scene. The shipped protobuf subset is limited to fixed-schema minimal
encoding/decoding; recursive or runtime-generated schemas are not used. This does not make the advisory disappear, so
the owner must move to a patched authoritative-multiplayer SDK release in a separately validated future change.

## Only a live deployment or device can confirm

- Targeted multiplayer delivery never fans Ghost Mail payloads to non-recipients in the production transport.
- Production Storage latency, swallowed-error behavior, cold-wake rehydration, partial-write recovery, and abrupt
  disconnect ordering match the installed SDK behavior reviewed here.
- Actual platform enforcement around 4 KB/13 KB messages, 300 messages per second, 40 host calls, the 256 MB isolate,
  and the 60-second settle limit under bounded load.
- Real guest-ID format/normalization and production deduplication behavior.
- Two-device ordering for round start, winner, reveal, abstention, deadline expiry, and disconnect/re-entry races.
- Mobile rendering of bidi/RTL names, duplicate-name wallet discriminators, maximal valid avatars/wearables, safe areas,
  five-control layouts, and the eight-`AvatarShape` ceiling.

## Owner pre-publish checklist

1. Do not roll back a deployed binary across storage schema versions. If a rollback is ever required, stop and design
   a new namespace/copy-forward migration first.
2. On the exact candidate commit, require a clean worktree, the
   `7.27.1-33086747846.commit-824d240` SDK/runtime pins, `npm ci`, `npm run build`, and `npm test` all green; complete
   the SDK compatibility merge gate in `docs/DEVICE-CHECKLIST.md`.
3. Complete `docs/DEVICE-CHECKLIST.md` on the target Android device and a supported iPhone. Include duplicate display
   names, control/bidi-heavy names, the wallet-backed Ghost Mail confirmation, maximal valid looks, and guest controls.
4. In a live World with at least three wallets, verify recipient-only Ghost Mail delivery, private-mail exclusion from
   live rounds/boards/progression, wrong-wallet prevention, two-player round timeout/abstention, and reconnect ordering.
5. Let the server sleep and confirm genuine stored charades, stats, boards, mail, and replies rehydrate without becoming
   writable empty defaults. Repeat while observing a controlled transient Storage failure and recovery.
6. Run bounded production load probes within platform policy and confirm no payload exceeds 4 KB, no host-call rejection
   escapes the handler boundary, and the server remains responsive to other players.
7. On the exact candidate, review `npm audit`, the installed Storage error semantics, and the dependency tree again.
   Treat RI-01, RF-11, and RF-12 as historical dispositions, not candidate proof; do not apply npm's suggested
   downgrade, overrides, or resolutions here.
8. Obtain the owner's explicit approval before deployment, repository publication/push, or submission. This hardening
   pass did not start, deploy, push, or submit anything.
