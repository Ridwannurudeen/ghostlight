# Ghostlight mobile device acceptance checklist

Run this checklist in the released Decentraland mobile clients on the exact deployment candidate. Desktop
preview and automated tests do not count as device evidence. Any unchecked item is a release blocker unless the
run note names the failure and the owner explicitly accepts it.

## Release decision, recorded 2026-09-02

**Revised the same day.** The first decision, taken at 14:00 UTC, was to ship the already-deployed baseline
(`c0abf00`, entity `bafkreihblrzvm6t3flfwgjbmyybi5gs3dyyhw345iix3qc4nkc3ohlmiyu`, tag `release/friendzone-judging`) and hold
candidate `c49bf1d` because it had no same-commit device acceptance. That afternoon the owner, playing the live
World, could not follow its HOW TO PLAY text - the comprehension defect `c49bf1d` was written to fix. Because a
real-device pass was about to run either way, the owner chose to deploy the candidate first so the pass produces
evidence on the judged build, with the baseline held as a ten-minute rollback.

**Deployed 2026-09-02T16:53:18Z** from `main` at `c905fe0` (scene code `c49bf1d`), tag `release/2026-09-02`.
Live entity `bafkreihydi7utkj5quq5y6tzpf7sw7neurw7lvcnjqqoyyne2bhqscanhy`, bundle `bafybeiakworhgfildiwndehxohcfx4cbatp2wmqsv5rx5idu2qf4yoouyi`.
Verified after upload: `ghostlight.dcl.eth` healthy and accepting users; `authoritativeMultiplayer: true`, no
`fixedAdapter`, no `placesConfig`, parcels `0,0` and `1,0`; the deployed `bin/index.js` contains `HOUSE PRACTICE`
and `RETRY CONNECTION`, which the previous build did not. `npm run preflight` on the candidate: 18 pass, 0 fail.

**Rollback** is `release/friendzone-judging`: `STORAGE_SCHEMA_VERSION` (3), `PROTOCOL_VERSION` (6) and
`src/shared/types.ts` are unchanged between the two builds and the candidate adds no storage keys, so redeploying
the baseline does not cross a schema boundary. The device pass below is the gate that decides whether the rollback
is used. Sep 3-11 is a deploy freeze.

CI is red at `c0abf00` and green on `main`. The failure is lockfile completeness, not a product defect: `npm ci`
rejected `package-lock.json` for missing the `@esbuild/*` platform packages, and `6303e56` added them in a
516-line lockfile-only change alongside `api/vitest.config.mts`. Neither `6303e56` nor `6dfd9b8` touches `src/`,
`assets/`, `scene.json`, or `package.json`.

## First device step - capture diagnostics

- [ ] In the foyer, open `HOW TO PLAY` -> `SETTINGS`, tap `DIAGNOSTICS: OFF` to enable the owner view, return to the
      foyer, and complete one full decode -> reveal -> author -> post loop. Open `TODAY'S BOARDS`, tap `BACK`, then
      open `HOW TO PLAY` -> `SETTINGS`, tap `COPY DIAGNOSTICS`, and paste the
      complete block back into the run record before evaluating anything below. Keep the block unchanged so the
      tested platform, language, inset, frame-time proxy, Transform-entity proxy, avatar count, asset totals, server
      timings, and session loop counts remain one attributable evidence record.

## SDK 7.27 same-commit device acceptance gate

The live World entity `bafkreihydi7utkj5quq5y6tzpf7sw7neurw7lvcnjqqoyyne2bhqscanhy` (tag `release/2026-09-02`,
scene code `c49bf1d`) was deployed on 2026-09-02 on the exact `7.27.1-33086747846.commit-824d240` SDK/runtime pin
before this gate was run; the owner accepted that ordering so the pass produces evidence on the judged build. Check
every item below on that deployed commit. If any item fails, redeploy `release/friendzone-judging` (`c0abf00`,
entity `bafkreihblrzvm6t3flfwgjbmyybi5gs3dyyhw345iix3qc4nkc3ohlmiyu`) before judging opens.

- [ ] From a clean checkout, run `npm ci`, `npm ls @dcl/sdk @dcl/js-runtime --depth=0`, `npm run build`, and
      `npm test`. Both Decentraland packages must resolve to the exact pinned version.
- [ ] Record the commit, resolved package versions, and released Decentraland app versions used on Galaxy A54 High
      and a currently supported iPhone.
- [ ] SDK Commands 7.27 defaults local previews to `@dcl-regenesislabs/bevy-headless-server@latest`, replacing the
      earlier `@dcl/hammurabi-server@next` default. For this gate, select `bevy` with the environment-only
      `DCL_SERVER_ENGINE` control and pin `DCL_SERVER_PACKAGE` to
      `@dcl-regenesislabs/bevy-headless-server@0.1.0-32423386171.commit-d18de13`; record the startup output. Exercise
      authenticated sender identity, enter/leave delivery, and Storage host reads and writes on that engine. Mocked
      tests do not satisfy this check, and the local override does not pin the deployed mobile host.
- [ ] On both devices, record cold authoritative-server wake through `ready`, one decode -> reveal -> author -> post
      loop, full leave and re-entry, and genuine Storage rehydration after server sleep.
- [ ] Record a two-phone shared round, Answer-Back duet, recipient-only Ghost Mail, remote avatar/reward rendering,
      touch-safe controls, camera and audio behavior, and the documented performance pass without an SDK-linked
      regression.
- [ ] The owner reviews the complete evidence and explicitly accepts the candidate for release. Desktop preview,
      automation, or one mobile OS cannot substitute for this evidence.

Any failure blocks release and deployment of the current continuation. Any later SDK pin change restarts the
SDK-compatibility portion of this gate. Device acceptance does not authorize deployment.

## Verified local phone-preview QR gate

SDK Commands 7.27 offers `--mobile` but no host-selection flag. Its generated link uses the first external IPv4,
which may belong to a VPN or virtual adapter. Use this workflow for every local phone run; do not count the SDK's
automatic QR as evidence.

- [ ] Start exactly one preview from the candidate checkout with the pinned `DCL_SERVER_ENGINE` and
      `DCL_SERVER_PACKAGE` values above, plus `npm run start -- --no-browser --no-client -p 8000`. Wait for the
      preview and authoritative server to become ready. Do not start a second preview to generate a QR.
- [ ] In a second terminal, run `node tools/mobile-preview.mjs`. If it reports multiple eligible LAN addresses,
      identify the physical Wi-Fi or Ethernet adapter shared with the phone and rerun with `--host <IPv4>`; never
      choose a VPN, tunnel, link-local, WSL, Hyper-V, or other virtual address.
- [ ] Read the printed payload before scanning. Its `preview=http://<IPv4>:8000` host must exactly match the selected
      physical adapter, and the printed position must match the candidate's `scene.json` base parcel. Save the
      unchanged payload in the run record.
- [ ] On the phone, while connected to the same local network, open the printed `http://<IPv4>:8000/about` URL in a
      browser and record a successful response with `healthy: true`. A laptop-only `/about` check does not satisfy
      this step.
- [ ] Scan the generated QR in the installed Decentraland app and record entry through Ghostlight's ready state.
      Keep this app recording with the commit, adapter name, IPv4, phone network, and app version. QR generation,
      browser reachability, and actual Decentraland connection are three separate checks.

## Hard pre-deploy gates

Do not deploy, record final media, or submit until every item in this section is checked. The House ghost is an
honest fallback, not acceptable release content, and no visitor, guess, reply, performance, or board entry may be
fabricated to satisfy these gates.

- [ ] Confirm the owner controls `ghostlight.dcl.eth`, and confirm the release candidate's `scene.json` has
      `worldConfiguration.name` set to that exact name, `authoritativeMultiplayer: true`, and neither
      `fixedAdapter` nor `placesConfig.optOut`.
- [ ] Publish the source repository, then record working absolute public HTTPS URLs for both the repository and
      its `LICENSE`. Do not paste a relative repository or licence link into the submission form.
- [ ] In the deployed production World, create at least three genuine human-authored charades from distinct
      accounts other than the fresh judge account. All three must be less than 14 days old and match the current
      UTC theme. Create at least one genuine Answer-Back duet; a House ghost does not count.
- [ ] Let the authoritative server instance sleep, re-enter from a fresh named account, and prove production
      Storage rehydrates the three real current-theme charades and the real duet. The fresh account must receive
      real-player content rather than only House content.
- [ ] Record each seeded performance's author, phrase/theme, UTC creation time, and duet status. Check this ledger
      daily through judging and renew genuine content before it reaches the 14-day serving boundary.
- [ ] Run the uncoached comprehension gate with five fresh testers who have not watched the owner or another tester.
      Before making a first guess, each tester must independently explain all four facts: a prior player received
      one secret phrase; that player left three ordered clues; the clues are START, ACTION, and REACTION; and exactly
      one answer card is true. Every tester must then complete decode -> fair authoring -> full preview -> post.
      The answer cards must remain unavailable until the first complete three-beat sequence. Record explanations,
      completion, and any coaching separately. Correct-answer rate alone does not satisfy this gate.

## Evidence for every run

- [ ] Record the tested commit, World/realm, UTC date and time, network, account roles, device model, OS version,
      Decentraland app version, graphics profile, battery level, and thermal state.
- [ ] Capture one uninterrupted landscape screen recording per device with taps and game audio. Keep separate
      close-up clips for the reveal timeline, two-phone race, title prop, portraits, and invite handoff.
- [ ] For every timing check, record the observed value from video frames; do not write only “looks good.”
- [ ] Run `npm run build` and `npm test` on the recorded commit before opening the candidate.
- [ ] Use the owner's one verified QR preview or deployed World. For local runs, attach the payload, phone `/about`
      check, and Decentraland connection evidence from the QR gate above. Do not start another preview server.

## Devices and accounts

- [ ] Run the reference pass on a Galaxy A54 using the High graphics profile.
- [ ] Run the control-safe pass on a currently supported iPhone with the current Decentraland iOS client.
- [ ] Prepare two distinct named accounts, one fresh named account, and one guest. Put both phones in the same
      realm before testing shared rounds or remote props.
- [ ] Use the verified production content from the hard pre-deploy gate. House content can satisfy signed-in public
      guess-progression checks—decoded, first-try correct, daily, and revision—but cannot satisfy
      release-readiness checks. Guest and Ghost Mail guesses remain excluded from progression.
- [ ] For Scene Stealer and Ghostlight Legend prop checks, use persisted test accounts one qualifying action below
      the documented threshold; do not alter production state during the run.

## Cold start and readiness

- [ ] Fully leave the World on both phones, let the multiplayer instance become cold, then launch the World on one
      phone while recording from before scene entry.
- [ ] The foyer and “The theater is waking up…” appear without an empty primary view, stuck camera, or audio pop.
- [ ] During the first 12 seconds and before “Tonight's ghosts are ready.”, no charade, performer, author screen,
      reveal beat, request-timeout status, or post confirmation appears. Repeated taps cannot advance the flow.
- [ ] If the first authoritative ready state has still not arrived at 12 seconds, the waking screen exposes Retry and
      HOUSE PRACTICE. Open practice: it labels itself PRACTICE / NON-SCORING, shows the assigned House phrase before
      playback, switches to a clear stage-camera view before the fixed START / ACTION / REACTION sequence, and keeps
      Retry and Back available. Replay it, then use Back and verify the performer clears and the player camera returns.
      Repeat with Retry followed by authoritative ready. Neither path may send a gameplay request or change score,
      progress, notices, boards, saved state, or server content.
- [ ] The first opening/decode transition occurs only after the ready state, and reconnecting from a dropped
      connection returns to the prior safe screen without duplicating a post or guess.
- [ ] Re-enter with a named account that has pending genuine tries, solves, or replies. The Since You Left report
      remains visible until acknowledged even if the first charade arrives, then dismissal enters the buffered decode.
- [ ] Pair the recording with the automated cold-start assertion. A phone recording can prove the observable gate,
      but cannot prove the exact outbound message list before `ready`.

Evidence: cold-start recording from app launch through the first answer card, plus the automated test result from
the same commit.

## Four-second opening and theater shell

- [ ] On a fresh session, remain in the foyer without entering the house or stage. Once the ready state arrives,
      the opening begins on its own; it neither starts during the waking state nor waits for stage entry.
- [ ] On the first entry of the app session, the opening follows this order: foyer camera and assigned-phrase /
      three-beat instruction at 0.0 s, daily marquee by 0.5 s, foyer doors and curtain sound at about 1.0 s,
      stage camera at about 1.75 s, then the opening overlay closes before performer entrance and decode at about
      4.0 s. No part of the first START clue is hidden by the overlay. The stage camera remains through the complete
      first 7.5-second START / ACTION / REACTION sequence, then releases automatically.
- [ ] Record each observed beat time. Pass when the order is exact, no beat is skipped or duplicated, and every beat
      lands within 0.35 s of its target after the scene has loaded.
- [ ] Tap START NOW once before 4 s. It lands cleanly on decode, switches to the stage camera without opening a hidden
      second overlay, holds that camera through the first complete sequence, releases it afterward, and does not
      replay the opening when returning to the foyer in the same session.
- [ ] The foyer doors open smoothly without clipping or a one-frame scale jump. During a reveal, both stage-curtain
      halves twitch together and settle to their prior open position.
- [ ] The primary route shows the generated foyer, doors, marquee, poster frames, seats, proscenium, curtains,
      stage, chandelier, footlights, spotlight, and pedestal with no primitive theater geometry in view.
- [ ] Across ten fresh entries, every randomized spawn lands inside the clear foyer area rather than outside the
      venue or inside a model. Answer controls cannot submit until the player reaches the physical decode area and
      become unavailable again after walking away. On entry, they also remain unavailable until the performer has
      completed START, ACTION, and REACTION once; the second-chance answer remains available after its single-beat
      replay.
- [ ] Walk the foyer, theater entrance, front row, and stage edge. There is no collision trap or camera snap.

Evidence: one full opening recording, one skipped opening recording, and wide screenshots from the foyer, house,
and stage.

## Marquee and UTC theme flip

- [ ] Hold each phone at normal arm's length, without zooming. From the foyer route, read the complete
      “TONIGHT'S SHOW: {theme}” within three seconds; no word is clipped, hidden by the camera, or lost against the
      marquee on either device.
- [ ] Confirm the marquee, UI border/ribbon accent, and house-light accent agree for the current theme.
- [ ] For the midnight test, enter with both phones before 00:00 UTC and keep one phone connected so the server
      instance stays alive. After 00:00 UTC, fully leave and re-enter on the other phone without redeploying.
- [ ] The re-entering phone advances exactly one step in the rotation: Everyday Escapades → Big Feelings → Kitchen
      Capers → Decentraland Life → Pop Spectacles → Awkward Moments → Everyday Escapades. Its marquee and accents
      update together.
- [ ] Without reconnecting, the phone that stayed online also receives the new theme, reset daily progress and
      boards, and the current or cleared Ghost of the Night. No yesterday label, rank, stamp progress, or pedestal
      survives the rollover.

Evidence: natural-scale foyer photos from Android and iOS, plus before/after-midnight recordings showing the UTC
clock, unchanged commit, and both theme labels.

## Reveal choreography and audio latency

- [ ] Run ten consecutive reveals, including the first reveal of the visit, one set-opening/finale/milestone reveal,
      at least three routine correct, three routine incorrect, and one NEXT GHOST tap before a timeline ends. No run
      desynchronizes the UI, performer, camera, lights, curtains, or audio.
- [ ] The first reveal of a visit or set, a finale, and a title/stamp milestone use the full eight-second sequence
      below. A routine reveal uses the compact sequence: lock at 0.0 s, sting at about 0.6 s, verdict at about 1.0 s,
      audience/performer reaction at about 1.7 s, stats at about 2.3 s, and a clean completion at about 3.0 s.
- [ ] At the guess tap (0.0 s), answers lock, tick and drumroll start, room tone ducks, lights enter tension, and the
      curtain edges twitch.
- [ ] At about 1.2 s, the current performer pose freezes and the camera pushes in.
- [ ] At about 2.0 s, the sting plays, wrong answers fade, and the spotlight becomes white.
- [ ] At about 2.6 s, a correct guess shows green light, hit sound, floating “YOU GOT IT,” and audience claps; an
      incorrect guess shows red light, miss sound, “{AUTHOR} MEANT: {PHRASE},” and audience shrugs.
- [ ] At about 4.0 s, the performer waves; correct plays applause and incorrect plays gasp.
- [ ] At about 6.0 s, aggregate stats and title progress appear. At about 7.5 s, stage camera, house lights, performer
      playback, room-tone volume, faded cards, and floating text reset cleanly.
- [ ] When stats replace the answer cards, the single exit row remains fully visible. MAKE YOUR OWN and any eligible
      ANSWER BACK action keep their complete 96 px source-layout targets; no lower action is clipped or hidden behind
      another row.
- [ ] NEXT GHOST during a running reveal skips to the same clean end state once. No late timer changes the next
      ghost's camera, lights, UI, or sound.
- [ ] While a guess is awaiting its authoritative result, MAKE YOUR OWN cannot open authoring. A delayed round
      winner can enter its intended author flow without making BACK reopen an inert reveal.
- [ ] On a throttled connection, delay the authoritative result past the normal verdict time. Verdict, bow, stats,
      and cleanup remain visibly spaced after arrival instead of collapsing into one frame. Then drop both the
      original guess and retry responses: timeout restores camera, performer, lights, curtains, and room tone.
- [ ] From a 60 fps recording with audio, measure guess-tap to first tick/drumroll onset over five attempts. Pass
      when the worst observed latency is at most 250 ms and no cue is dropped or doubled.
- [ ] With the screen covered, a second tester identifies hit versus miss from sound alone in at least five of six
      mixed trials. Curtain, unlock, and stamp cues are distinct from both outcomes.
- [ ] Leave room tone playing for at least 30 seconds with headphones. No click, pause, level jump, or doubled edge
      is audible at either loop boundary.

Evidence: a timestamp sheet for all ten runs, the worst latency measurement, one correct clip, one incorrect clip,
one interrupted clip, and the covered-screen result.

## Author, progression, stamps, and remote props

- [ ] Authoring deals a phrase and allows no more than two shuffles. It labels the three beats START, ACTION, and
      REACTION; offers exactly two phrase-specific choices for the current beat; rejects repeated or off-beat
      emotes; preserves the chosen 1–2–3 order; and previews the named player's current look. POST remains disabled
      after three selections and becomes available only after the complete preview has played.
- [ ] Immediately after tapping PREVIEW, repeatedly tap the disabled POST position through START and ACTION. No post
      request is sent. POST becomes available only after REACTION completes. Then change or undo an emote, preview
      again, and confirm the old completion cannot authorize the revised sequence.
- [ ] From both regular and Answer-Back authoring, tap BACK before preview. The exact prior solo performer or duet
      and its earned stage reward return; no performer disappears and no stale preview remains.
- [ ] On a fresh named account, the first successful post shows the Understudy unlock card and unlock sound. The
      second phone sees the top hat attached to that account, not to itself.
- [ ] Repeat the remote observation for Scene Stealer (mask on head) and Ghostlight Legend (trophy in right hand)
      using threshold-ready test accounts. Props do not float, attach to the wrong avatar, or disappear when the
      observer changes camera.
- [ ] Fully leave and re-enter after each unlock. The same title and reward prop restore without another qualifying
      action or duplicate unlock card.
- [ ] On one named account in one UTC day, complete three public decodes—player-authored or House—and one post.
      The action crossing the threshold shows “DAILY SHOW COMPLETE,” plays the stamp sound once, and adds the stamp
      in the foyer.
- [ ] Decode or post once more, then reconnect. The stamp remains saved and neither the card nor sound repeats.

Evidence: unlock and stamp recordings, a second-phone prop recording for all three titles, and reconnect clips.

## Playbill portraits, Crowd Pleaser, and Ghost of the Night

- [ ] Open TODAY'S BOARDS after named and guest accounts have performed. The playbill shows no more than the six
      most recent performers with name, title or NEW GHOST, and a plausible JUST NOW/minutes/hours age.
- [ ] Named accounts show their own portrait. Guest performers show the designed card placeholder rather than a
      blank, stale, or another player's face.
- [ ] Among real-player performances with at least three guesses, the one closest to a 60% solve rate appears first
      as Crowd Pleaser and its author appears on the Ghost of the Night pedestal with the correct look. More guesses
      break an equal-distance tie. With no qualifying performance, the board and pedestal show no winner. House
      content never occupies the pedestal or boards.

Evidence: one boards screenshot containing a named portrait and guest placeholder, plus a pedestal screenshot.

## Answer-Back duet and full share loop

- [ ] Account A posts a charade and opens COPY INVITE. Account B follows the general World invite, then continues
      until the server serves A's charade. B sees ANSWER BACK only after the reveal; A, the House ghost, and an
      already-replied charade cannot reply to themselves.
- [ ] In answer-back authoring, the fixed phrase remains visible and no shuffle control is exposed. Three emotes
      keep their chosen order, preview uses B's look, and SEND REPLY produces the answer-back confirmation.
- [ ] Re-enter as A after B replies. “Since you left” includes the answered-back count exactly once.
- [ ] Serve the replied charade to an eligible account that has not seen it. Both performer names appear, the author
      and replier occupy distinct stage positions, and their three-emote sequences alternate author first, then
      replier, at roughly 2.5-second steps. REPLAY restarts with the author's first emote.
- [ ] Guessing the duet freezes the alternating sequence and completes the normal reveal without overlap, clipping,
      a stranded replier, or a ninth avatar clone. The following solo charade removes the replier slot.

Evidence: one continuous A-post → B-decode → B-answer-back recording, A's reconnect summary, and a full duet clip.

## Two-phone first-answer race and reactions

- [ ] With two named accounts present and a player-authored charade served, both phones receive the same round
      charade and show the same answer set.
- [ ] Count down off camera and tap the correct answer on both phones as closely together as possible. Exactly one
      account is announced as winner and enters authoring; the other remains responsive on the resolved reveal.
- [ ] Repeat with the opposite phone deliberately tapping first. The winning account changes accordingly; no client
      posts, guesses, or authors twice.
- [ ] LAUGH, GASP, and APPLAUSE trigger the sender's local emote and a visible remote audience reaction.
- [ ] When one phone leaves, the round ends and the remaining phone returns to stable solo behavior.

Evidence: side-by-side video of both races and one reaction from each phone.

## Android and iOS control-safe pass

- [ ] The movement joystick remains usable and every native action/gamepad button is hidden on Android and iOS.
- [ ] From the foyer, tap the top-right HOW TO PLAY control. It shows exactly five readable lines covering the walk,
      prior player, one secret phrase, START/ACTION/REACTION order, exactly one true answer, own charade, and real
      previous player. Verify all five in English, Spanish, and Portuguese at normal arm's length; use SETTINGS and
      its HOW TO PLAY link to change languages, and confirm BACK returns to the foyer.
- [ ] Without reopening the guide, the persistent one-line hint changes across foyer away from the stage, foyer at
      the stage, decode, reveal, author with fewer than three emotes, author with three emotes, and posted. Each hint
      remains readable and follows the selected language.
- [ ] Outside the house or stage area, WALK TO THE STAGE is a clear, non-clickable 96 px source-layout instruction
      rather than a disabled button. Tapping it does nothing; walking into the decode area replaces it with active
      DECODE A GHOST.
- [ ] In foyer, decode, reveal, author, posted, boards, invite, and notice overlays, no required control intersects the
      notch/Dynamic Island, home indicator, interactable inset, or bottom-right joystick area.
- [ ] No screen exposes more than five game buttons at once. Author selection advances to confirmation after the
      third emote, and opening the REACTIONS menu replaces the other secondary controls instead of stacking a row.
- [ ] Every required action renders with a source-layout target at least 96 px tall, remains comfortably
      thumb-selectable on both devices, and does not activate an adjacent control during rapid taps. Record any
      platform scaling observed rather than treating source-layout pixels as a physical measurement.
- [ ] Camera transitions do not steal touch input or leave either client locked to the foyer, stage, or reveal camera.

Evidence: Android and iOS screenshots of foyer away from and at the stage, HOW TO PLAY in all three languages,
decode, author, reveal, and invite, plus a short hint-transition and movement-and-tap recording. Retain the iOS set
for the mobile curation/featuring packet.

## Invite copy and open

- [ ] The posted screen's first COPY INVITE tap changes the UI to the copied confirmation and places exactly
      `Join me for Ghostlight: https://decentraland.org/jump/?realm=ghostlight.dcl.eth` on the clipboard.
- [ ] Paste into a neutral notes field to verify the text, then tap the HTTPS link from a real messaging app on both
      Android and iOS. It opens the installed Decentraland client at `ghostlight.dcl.eth`.
- [ ] If HTTPS fails to deep-link, record the OS/app behavior and separately test
      `decentraland://?realm=ghostlight.dcl.eth`; do not change production copy during the checklist.

Evidence: clipboard paste screenshots and start-to-arrival recordings for Android and iOS.

## Performance and release gate

- [ ] On Galaxy A54 High, Performance stays above 90% during five minutes at rest, ten reveal runs, audience spawn,
      a duet, title/stamp overlays, and camera transitions. Record the minimum observed percentage for each phase.
- [ ] At the visual peak, the duet uses two stage performers and no more than six audience/pedestal clones. Ghost of
      the Night replaces an audience slot when present; no ninth `AvatarShape` appears.
- [ ] There is no sustained hitch, audio dropout, texture pop-in after warm-up, particle effect, dynamic light, or
      unplanned catalog prop. All important performers and name tags remain readable from the stage camera.
- [ ] Run one uninterrupted five-minute solo loop and one full two-phone round on the deployed candidate. Every
      tester fully leaves and re-enters afterward so an old instance cannot be mistaken for the release.

Evidence: performance-HUD recordings at rest, reveal, and duet peak; the recorded minima; and the deployed World
re-entry clip.

## What device evidence cannot prove

The physical-device run validates behavior, timing, readability, controls, cross-client visibility, and measured
performance. The automated suite must separately prove the exact pre-`ready` outbound message list, the server's
7,500 ms post-send first-guess deadline and immediate retry exemption, the eight-slot `AvatarShape` ceiling under
simultaneous replier/pedestal allocation, the 16-player reward cap plus stage slot, the
79-entity/16,492-triangle conservative peak, asset triangle/material/size budgets, UTC selection logic, and
persistence writes. A release needs both forms of evidence from the same commit.
