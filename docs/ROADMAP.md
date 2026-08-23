# Ghost Charades — Roadmap

*Drafted 2026-08-23 by the owner's two AI builders from three independent inputs: a primary-source research
pass on Decentraland's programs and levers, Codex's roadmap draft, and Claude's. Every external fact below
was verified on 2026-08-23 against the source named; anything we could not verify is marked as such and the
plan does not depend on it.*

---

## 0. Vision

In twelve months Ghost Charades is Decentraland's **asynchronous avatar theater network**: a set of
connected venues where every visit leaves a performance that entertains the next stranger, tours other
creators' Worlds, and grows into duets, troupes, and seasonal shows. It creates a category the platform
does not have — **time-shifted social play** — and it is the conversation layer the mobile client lacks:
no DMs, no voice, no chat API on phones, so mobile players talk to each other through performance. The
Foundation and Regenesis Labs want it to exist because it is the retention engine mobile is missing (a
reason to return when nobody else is online), it showcases the identity economy (real avatars, real
wearables, emotes), and its touring runtime is open-source infrastructure other creators can drop in.

## 1. The landscape, as verified

| Fact | Consequence for this roadmap |
|---|---|
| Friendzone deadline string `2026/09/04 01:00`, no timezone; judging Sep 5–11 solo in the mobile app; winners Sep 13; top 10 "may receive" Discover featuring | Our wall is **Tue 2 Sep 18:00**. Sep 13 is the first external milestone we can cite. Featuring is a target, never a dependency. |
| Discover is curated, no automatic ranking; `#rl-mobile-featuring` is always open; the 30–60 s real-device video is "the most important piece"; the #1 rejection is UI clashing with controls | The trailer is a first-class Phase 0 deliverable. We apply regardless of placement. |
| iOS Discover needs a `#rl-mobile-curation` request (24 h review); Android Discover is unrestricted; deep links and `/world` work on iOS regardless | File the iOS request the day the World goes live. |
| Regenesis Grants Season 1: 29 proposals, 7 funded, ~$32K of an "up to $55K" pool, **~$4.6K average**, all mobile-first, paid in MANA via milestones, terminated after two missed milestones; proposals are public forum threads | Plan a **$4–6K, 90-day, milestone-scoped, open-source** proposal modelled on the public Season 1 threads. Denominate in USD. |
| **Season 2 is not announced** (RFC commits to two seasons in 2026; the July status update is overdue) | No Season 2 date in this plan. Watch forum category 18 and `grantsprogram@dclregenesislabs.xyz`. |
| DAO Community Grants: **no grant proposal since Oct 2024**; docs still say "request a grant in the DAO" (stale) | The DAO is not a funding path. Regenesis is the only live funder. |
| No "Creator Success Program" exists under that name in docs or forum | Treat as non-existent until the organisers name it. |
| Creator Hub Scene Analytics: unique visits, new users, concurrent users, **D7 retention**, playtime, **mobile/desktop split**, WAU, emotes played, CSV export, daily refresh | Our KPI spine — no custom analytics pipeline needed in Phase 1. |
| Events: anyone can post a recurring weekly Event in a World, no LAND needed, Foundation-reviewed in hours, with `highlighted`/`trending` flags | A free weekly traffic lever from day one. The World must still work host-free. |
| Worlds: 100 concurrent users cap; NAME = 100 MANA; Places listing policy says LAND-or-rental, yet 1,610 Worlds are indexed | Capacity is never the constraint; arrival is. Ask the organisers about Places listing rather than assume. |
| **Dead or closed levers:** Quests (repo archived Apr 2025; mobile Daily Quests no ETA), creator Badges (stub API), portable experiences ("not currently supported"), POIs (coordinate-based) | No quests, no badges, no ghost that follows you across Worlds. Touring is a **scene-side component** other creators add, pulling from our API. |
| Emote/wearable publishing: **$100/item today**; DAO-passed reform to $25 (effectively $5 for 6 months) is **not yet enacted** | Phase 3 drops wait for enactment. |
| Platform scale: 33 concurrent users across the top 100 places (sample 2026-08-23); Regenesis's featured Cozy Farm ≈ 500 registered players; DCL Kickoff ≈ 250 | Targets below are calibrated to this, not to app-store fantasies. |
| Regenesis builds the mobile client (June: 65 PRs); paid acquisition paused "until there is content worth arriving to"; guest flow shipped July; iOS IAP built | Our pitch to them is literally "we are the content worth arriving to." |
| Mobile has no gestures, no particles, no dynamic lights, no scene chat; SDK 7.27+ recommended for UI scaling parity (we are pinned to a 7.26.1 auth-server build) | Re-pin to a 7.27 auth-server build in Phase 1, on a branch, with the device checklist. |

## 2. Phase 0 — Opening Night (Aug 24 → Sep 2 lock)

**Deliverable:** the "Opening Night" build. **Gate:** a first-time mobile player completes watch → guess →
reveal → author → post without instruction, on a real Android, at > 90 % Performance on the High profile.

The reviewed functional core (`d157934`, 113 tests) is frozen. Every hour goes to what the judge sees.

| Day | Lands (gate) | Owner-only |
|---|---|---|
| Sun 24 | **Reveal choreography** (the one thing): stage freeze, emissive shift, answers vanish, camera push, ghost bow, audience react, reset — ten consecutive runs without desync | Phone test #1 of the current build (baseline) |
| Mon 25 | **Sound**: curtain, tick, tension sting, hit/miss, applause/gasp, unlock flourish, room tone — outcome readable with the screen covered | BNB deploy a.m.; **buy the NAME** |
| Tue 26 | **Theater shell**: Blender-scripted proscenium, curtain, seat rows, footlights + catalog props, one coherent haunted-vaudeville identity — no primitive in the primary view | — |
| Wed 27 | **Custom UI + cold open**: playbill-style answer cards, one dominant action, control-safe placement; 10-second playable intro; first deploy to the World; `#rl-mobile-curation` request | Phone test #2 |
| Thu 28 | **Tonight's Show**: daily theme, marquee palette, poster, curated pool, completion stamp; portrait playbill of recent real performers (`AvatarTexture`) | — |
| Fri 29 | **Progression**: applause meter, titles (Understudy → Scene Stealer → Ghostlight Legend), three `AvatarAttach` reward props; **performance pass** on the weakest phone | Playtest #1 (friends + Friendzone Discord); weekly Event posted |
| Sat 30 | **Answer-Back Duets** (asynchronous): decode, then record your own three-emote reply; the next visitor watches both | — |
| Sun 31 | Integration and performance only; nothing new | Two full phone runs; playtest #2 |
| Mon 1 | Blind judge audit (a stranger, five minutes, no coaching); repair the lowest of the seven criteria; submission text; README | **Trailer captured on device** (30–90 s, no editor footage) |
| Tue 2 18:00 | **Lock.** Verify the deployed commit; stage the package | Approve and submit |
| Sep 3–11 | Deploy freeze; daily two-minute in-app check; friends drop in — real people only | — |

Cut list (already decided): no more work on live-race edge cases, phrase-deck expansion, board depth, invite
polish, or obscure persistence paths. They work; they stay.

## 3. Phase 1 — Featured (Sep 3 → Sep 30)

**Deliverable:** "Season Zero: The Haunted Opening." **Gate:** 250 unique visitors, 100 completed
performances, seven consecutive days without a progression-loss or session-blocking incident.

- **Judging week (Sep 5–11).** Clean judging build; a separately tested hotfix branch; patch only critical
  mobile or persistence failures. Friends in the World at the strongest hour, never bots. Creator Hub
  Analytics read daily.
- **Sep 3: file `#rl-mobile-featuring`** with the device trailer, the novel-mechanic statement, touch-safe
  screenshots, performance evidence on Android and iOS, a moderation summary. Featuring is not assumed.
- **Sep 13 onward: Season Zero**, four weekly themes — First Impressions · Main Character Energy ·
  Fashionably Haunted · Final Encore — each with 25–40 curated prompts, one title, one prop, a Sunday finale
  posted as a recurring Event. Gate: four themes on schedule, < 2 % of prompts quarantined.
- **Community seeding from Sep 14:** three recurring appointments a week (creator preview, public show,
  finale); recruit 20 DCL creators as the founding audience with trackable invite links. Gate: ten creators
  author a charade, five return in a later week.
- **Ghost Mail v1 (Sep 20):** send a charade to a specific person; they decode it on their next visit and
  answer back in emotes. The mobile client has no DMs — this is the feature that makes the product a
  conversation layer, and it is the headline of every application that follows.
- **SDK re-pin** to a 7.27 auth-server build on a branch, validated against the device checklist.
- **Grant readiness (by Sep 25):** a public-proposal-quality packet — playable World, trailer, clean repo and
  tests, architecture diagram, Creator Hub funnel and D7 data, creator testimonials, moderation design,
  90-day milestones, itemised USD budget ($4–6K), and one proposed open-source contribution (the touring
  runtime). Filed the day a Regenesis window opens. Every claim links to an artefact.

## 4. Phase 2 — The Show Network (Oct → Dec)

**Deliverable:** "Ghost Charades Network Beta." **Gate:** three connected venues, five external creators,
600 monthly visitors, 99 % successful cross-World ghost retrieval.

Build order (ranked):
1. **Network spine (Oct 1–18).** Our API on the VPS, reached via `signedFetch` with verified addresses:
   shared ghost pool, moderation queue, season state, analytics export. The hosted Multiplayer Server stays
   the real-time authority inside each World; Storage becomes the per-World cache. Launch three Worlds —
   the flagship haunted theater, a comedy club, a street-corner stage — sharing one moderated pool with
   venue-specific themes and boards. Gate: a ghost authored in one venue appears in another within 60 s with
   consent and attribution preserved.
2. **Spectator mode (Oct 19–31).** Reaction stamps, applause intensity, prediction voting, canned announcer
   lines — nothing that depends on chat or voice. Gate: ≥ 20 % of spectators send a reaction.
3. **Creator Studio v1 (Nov 1–15).** Validated phrase-pack authoring, preview, scheduling, rating,
   localisation fields, moderation status. Spanish and Portuguese decks first. Gate: three outside creators
   publish packs without touching source.
4. **Ghost Touring Kit (Nov 16–30), open source.** A drop-in SDK component that requests an eligible ghost,
   renders within strict avatar limits, runs the performance, returns the result, exposes theme hooks. Gate:
   two creators integrate it into existing Worlds in under two hours each.
5. **Season One: World Tour (December).** Weekly venue brackets, a Dec 27 Gala finale where the season's
   best charades replay on the big stage; three-person **troupes**; chained duets; a voice-free charades
   language of combo moves (setup, reversal, emphasis, punchline); the **living dictionary** — weekly posts
   on how the community expresses phrases ("73 % use headexplode for Monday"). Gate: 15 % duet rate, 5 %
   troupe rate, 50 player-created combo performances.

Only when verified and cheap: one fashion-week or music-night themed show (cosmetic, participatory); a
temporary partner LAND installation in Genesis City for December foot traffic. No LAND purchase before
retention proves out. No quests, no badges — the platform has neither.

## 5. Phase 3 — Economy and sustainability (Q1 2027)

**Deliverable:** "Creator Economy v1." **Gate by Mar 31:** three revenue sources, five paid creators, three
months of runway, and the core loop still free.

- **January:** one show collection — performer prop, audience prop, finale wearable, creator emote pack —
  published **after** the fee reform enacts ($25/item, ~$5 effective) or scoped to the $100/item reality if
  it has not. Purchases express identity; they never improve odds or progression.
- **February:** two sponsored show nights. Sponsors fund a set, a phrase pack, a collectible, a prize pool;
  creative control stays with us; sponsored content is labelled. Gate: each covers production cost and
  brings 100 attributable visitors.
- **March:** creator payouts from pack sales, commissions, and touring-kit engagements, with an auditable
  ledger. Apply for Regenesis funding against completed milestones. Target $25K across programs; the plan
  survives at $0.
- **Never:** a token, pay-to-win, paid answers, intrusive ads, gambling, tradable scores, behavioural-data
  sales, fees for watching, guessing, authoring, or inviting, or any fabricated engagement.

## 6. Technical roadmap

- **Phase 0:** reviewed core frozen; presentation layer (choreography, sound, assets, UI) added beside it;
  real-device smoke tests added to the 113 unit tests; asset budget per GLB; CI blocks on build, tests,
  asset budget.
- **Phase 1:** funnel, persistence, reconnect, and server-sleep tests; SDK 7.27 re-pin on a branch; Ghost
  Mail data model (`v2` records with recipient, lineage, consent).
- **Phase 2:** the VPS API (Node + Postgres; p95 < 250 ms; error rate < 1 %); versioned records for
  performance, author, venue, pack, sequence, eligibility window, moderation state, touring consent, duet
  lineage, season, outcomes; contract tests across every World and API version; load tests; moderation
  tests; touring-kit compatibility fixtures; structured logs, dashboards, alerts on error rate, storage
  growth, queue depth, cross-World latency. Never secrets or unnecessary personal data.
- **Hard budgets, every phase:** ≤ 8 full-rate avatar clones; messages < 8 KB; no gameplay dependency on
  particles or dynamic lights; audience animation degrades before core play; 30 FPS on the weakest
  maintained phone; playable within 8 s of scene load after the server wakes.
- **Moderation, before any open publishing:** curated decks only; profile-name filter; rate limits;
  duplicate detection; report button; shadow-hide by address; quarantine; moderator audit log; deletion
  handling; touring strictly opt-in at authoring time.

## 7. Team and capacity

The owner owns product judgement, architecture, releases, creator relationships, and the final quality bar.
AI builders (Codex builds, Claude verifies and reviews, Fable 5 audits) handle implementation, tests, asset
scripting, content tooling, QA matrices, analytics queries, release prep — every output owner-reviewed.
Scripted Blender assets carry Phase 0. **Bring in a human environment artist and a sound designer by Sep 15,
conditional on funding**, for a fixed four-week pass (three venue identities, reward props, sonic logo, crowd
cues, mix). Reserve the first $1,500–3,000 of prize, sponsor, or grant money for it; without funding, reduce
venue count rather than ship weak art.

## 8. Metrics (calibrated to real platform scale)

| Gate | Target |
|---|---|
| Sep 2 | > 90 % fresh-tester loop completion; > 90 % Performance on High; zero critical mobile defects; trailer shipped |
| Sep 30 | 250 unique visitors; D1 25 %; D7 10 %; 0.35 charades authored per visitor; 20 Ghost Mails sent |
| Nov 30 | 450 monthly visitors; D7 12 %; 10 % duet rate; 12 % invite conversion; 3 venues live |
| Dec 31 | 600 monthly visitors; D7 15 %; 15 % duet rate; 5 active creators; Gala held |
| Mar 31 | 1,500 monthly visitors; D7 18 %; 10 creators; 3 revenue sources |
| Programs | one Discover placement; one Regenesis acceptance ($4–6K); $25K total target, $0 assumed |

Retention percentages are only reported for cohorts of ≥ 100 identifiable visitors; below that, counts.

## 9. Risks

| Risk | Standing mitigation |
|---|---|
| Pre-release SDK / platform change | Pinned versions; adapter layer; contract tests; a single-World fallback always playable |
| Mobile client gaps (no chat, voice, particles, lights, gestures) | Design only on verified capabilities; weekly Android + iOS runs |
| Moderation failure | Curated first; quarantine; rate limits; report/block; opt-in touring |
| Empty-venue spiral | Async ghosts, Ghost Mail, daily show, weekly Events, seeded friends, invite attribution |
| Weak art direction | One strong identity first; paid specialists before more venues |
| Single-maintainer burnout | Monthly scope locks; automated releases; documented ops; creator self-service; no fourth venue before reliability gates |
| Grant / featuring dependence | Budgets assume neither; MANA-denominated awards lose USD value — ask in USD |
| "Quiz fatigue" | Duets, troupes, the combo language, Ghost Mail — the mechanic must keep growing |

## 10. The ten decisions for the owner

1. **Category:** commit to "asynchronous avatar theater network." *(Recommended)*
2. **Phase 0 centrepiece:** the reveal choreography is untouchable; cut anything else first. *(Recommended)*
3. **Art direction:** haunted vaudeville, warm theatrical light, playful ghosts. *(Recommended)*
4. **Content policy:** curated now; trusted creators publish later; never open submission. *(Recommended)*
5. **Ghost consent:** cross-World touring is explicit opt-in at authoring time. *(Recommended)*
6. **Cadence after launch:** weekly themes, monthly finales — not daily content. *(Recommended)*
7. **Architecture trigger:** shared persistence moves to the VPS **before** the second World. *(Recommended)*
8. **Creator product:** open-source the touring runtime; monetise premium content and commissions. *(Recommended)*
9. **First money:** human art, sound, and device coverage before more code. *(Recommended)*
10. **Commitment:** fund a measured six-month continuation now with a March renewal gate on D7 retention,
    creator activity, and runway. *(Recommended)*
