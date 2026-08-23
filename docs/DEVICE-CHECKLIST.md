# Ghost Charades mobile device acceptance checklist

Run this checklist in the released Decentraland mobile clients on the exact deployment candidate. Desktop
preview and automated tests do not count as device evidence. Any unchecked item is a release blocker unless the
run note names the failure and the owner explicitly accepts it.

## Evidence for every run

- [ ] Record the tested commit, World/realm, UTC date and time, network, account roles, device model, OS version,
      Decentraland app version, graphics profile, battery level, and thermal state.
- [ ] Capture one uninterrupted landscape screen recording per device with taps and game audio. Keep separate
      close-up clips for the reveal timeline, two-phone race, title prop, portraits, and invite handoff.
- [ ] For every timing check, record the observed value from video frames; do not write only “looks good.”
- [ ] Run `npm run build` and `npm test` on the recorded commit before opening the candidate.
- [ ] Use the owner's existing QR preview or deployed World. Do not start another preview server.

## Devices and accounts

- [ ] Run the reference pass on a Galaxy A54 using the High graphics profile.
- [ ] Run the control-safe pass on a currently supported iPhone with the current Decentraland iOS client.
- [ ] Prepare two distinct named accounts, one fresh named account, and one guest. Put both phones in the same
      realm before testing shared rounds or remote props.
- [ ] Prepare at least three eligible real-player charades. House content cannot satisfy progression checks.
- [ ] For Scene Stealer and Ghostlight Legend prop checks, use persisted test accounts one qualifying action below
      the documented threshold; do not alter production state during the run.

## Cold start and readiness

- [ ] Fully leave the World on both phones, let the multiplayer instance become cold, then launch the World on one
      phone while recording from before scene entry.
- [ ] The foyer and “The theater is waking up…” appear without an empty primary view, stuck camera, or audio pop.
- [ ] Before “Tonight's ghosts are ready.”, no charade, performer, author screen, reveal beat, request-timeout status,
      or post confirmation appears. Repeated taps cannot advance the flow.
- [ ] The first opening/decode transition occurs only after the ready state, and reconnecting from a dropped
      connection returns to the prior safe screen without duplicating a post or guess.
- [ ] Pair the recording with the automated cold-start assertion. A phone recording can prove the observable gate,
      but cannot prove the exact outbound message list before `ready`.

Evidence: cold-start recording from app launch through the first answer card, plus the automated test result from
the same commit.

## Ten-second opening and theater shell

- [ ] On the first entry of the app session, the opening follows this order: foyer camera at 0.0 s, daily marquee
      by 1.0 s, foyer doors and curtain sound at about 2.5 s, stage camera at about 4.5 s, performer entrance at
      about 6.0 s, “Guess what they're saying” at about 8.0 s, and decode at about 10.0 s.
- [ ] Record each observed beat time. Pass when the order is exact, no beat is skipped or duplicated, and every beat
      lands within 0.35 s of its target after the scene has loaded.
- [ ] Tap SKIP INTRO once before 10 s. It lands cleanly on decode, does not leave the foyer camera or closed doors,
      and the opening does not replay when returning to the foyer in the same session.
- [ ] The foyer doors open smoothly without clipping or a one-frame scale jump. During a reveal, both stage-curtain
      halves twitch together and settle to their prior open position.
- [ ] The primary route shows the generated foyer, doors, marquee, poster frames, seats, proscenium, curtains,
      stage, chandelier, footlights, spotlight, and pedestal with no primitive theater geometry in view.
- [ ] Walk the foyer, theater entrance, front row, and stage edge. There is no collision trap or camera snap.

Evidence: one full opening recording, one skipped opening recording, and wide screenshots from the foyer, house,
and stage.

## Marquee and UTC theme flip

- [ ] Hold each phone at normal arm's length, without zooming. From the foyer route, read the complete
      “TONIGHT'S SHOW: <theme>” within three seconds; no word is clipped, hidden by the camera, or lost against the
      marquee on either device.
- [ ] Confirm the marquee, UI border/ribbon accent, and house-light accent agree for the current theme.
- [ ] For the midnight test, enter with both phones before 00:00 UTC and keep one phone connected so the server
      instance stays alive. After 00:00 UTC, fully leave and re-enter on the other phone without redeploying.
- [ ] The re-entering phone advances exactly one step in the rotation: Everyday Escapades → Big Feelings → Kitchen
      Capers → Decentraland Life → Pop Spectacles → Awkward Moments → Everyday Escapades. Its marquee and accents
      update together.

Evidence: natural-scale foyer photos from Android and iOS, plus before/after-midnight recordings showing the UTC
clock, unchanged commit, and both theme labels.

## Reveal choreography and audio latency

- [ ] Run ten consecutive reveals, including at least three correct, three incorrect, and one NEXT GHOST tap before
      the timeline ends. No run desynchronizes the UI, performer, camera, lights, curtains, or audio.
- [ ] At the guess tap (0.0 s), answers lock, tick and drumroll start, room tone ducks, lights enter tension, and the
      curtain edges twitch.
- [ ] At about 1.2 s, the current performer pose freezes and the camera pushes in.
- [ ] At about 2.0 s, the sting plays, wrong answers fade, and the spotlight becomes white.
- [ ] At about 2.6 s, a correct guess shows green light, hit sound, floating “YOU GOT IT,” and audience claps; an
      incorrect guess shows red light, miss sound, “<AUTHOR> MEANT: <PHRASE>,” and audience shrugs.
- [ ] At about 4.0 s, the performer waves; correct plays applause and incorrect plays gasp.
- [ ] At about 6.0 s, aggregate stats and title progress appear. At about 7.5 s, stage camera, house lights, performer
      playback, room-tone volume, faded cards, and floating text reset cleanly.
- [ ] NEXT GHOST during a running reveal skips to the same clean end state once. No late timer changes the next
      ghost's camera, lights, UI, or sound.
- [ ] From a 60 fps recording with audio, measure guess-tap to first tick/drumroll onset over five attempts. Pass
      when the worst observed latency is at most 250 ms and no cue is dropped or doubled.
- [ ] With the screen covered, a second tester identifies hit versus miss from sound alone in at least five of six
      mixed trials. Curtain, unlock, and stamp cues are distinct from both outcomes.

Evidence: a timestamp sheet for all ten runs, the worst latency measurement, one correct clip, one incorrect clip,
one interrupted clip, and the covered-screen result.

## Author, progression, stamps, and remote props

- [ ] Authoring deals a phrase, allows no more than two shuffles, offers five distinct emotes, preserves the selected
      order as 1–2–3, previews the named player's current look, and enables POST only after three selections.
- [ ] On a fresh named account, the first successful post shows the Understudy unlock card and unlock sound. The
      second phone sees the top hat attached to that account, not to itself.
- [ ] Repeat the remote observation for Scene Stealer (mask on head) and Ghostlight Legend (trophy in right hand)
      using threshold-ready test accounts. Props do not float, attach to the wrong avatar, or disappear when the
      observer changes camera.
- [ ] Fully leave and re-enter after each unlock. The same title and reward prop restore without another qualifying
      action or duplicate unlock card.
- [ ] On one named account in one UTC day, complete three real-player decodes and one post. The action crossing the
      threshold shows “DAILY SHOW COMPLETE,” plays the stamp sound once, and adds the stamp in the foyer.
- [ ] Decode or post once more, then reconnect. The stamp remains saved and neither the card nor sound repeats.

Evidence: unlock and stamp recordings, a second-phone prop recording for all three titles, and reconnect clips.

## Playbill portraits and Ghost of the Night

- [ ] Open TODAY'S BOARDS after named and guest accounts have performed. The playbill shows no more than the six
      most recent performers with name, title or NEW GHOST, and a plausible JUST NOW/minutes/hours age.
- [ ] Named accounts show their own portrait. Guest performers show the designed card placeholder rather than a
      blank, stale, or another player's face.
- [ ] The hardest eligible real-player ghost appears on the Ghost of the Night pedestal in foyer/boards views with
      the correct look. House content never occupies the pedestal or boards.

Evidence: one boards screenshot containing a named portrait and guest placeholder, plus a pedestal screenshot.

## Answer-Back duet and full share loop

- [ ] Account A posts a charade and opens COPY INVITE. Account B follows the invite, decodes A's charade, and sees
      ANSWER BACK only after the reveal; A, the House ghost, and an already-replied charade cannot reply to themselves.
- [ ] In answer-back authoring, the phrase stays fixed, SAME PHRASE is disabled as a shuffle, three emotes keep their
      chosen order, preview uses B's look, and SEND REPLY produces the answer-back confirmation.
- [ ] Re-enter as A after B replies. “Since you left” includes the answered-back count exactly once.
- [ ] Serve the replied charade to an eligible account that has not seen it. Both performer names appear, the author
      and replier occupy distinct stage positions, and their three-emote sequences alternate author first, then
      replier, at roughly 2.5-second steps. REPLAY restarts with the author's first emote.
- [ ] Guessing the duet freezes the alternating sequence and completes the normal reveal without overlap, clipping,
      a stranded replier, or a ninth avatar clone. The following solo charade removes the replier slot.

Evidence: one continuous A-post → B-decode → B-answer-back recording, A's reconnect summary, and a full duet clip.

## Two-phone first-answer race and reactions

- [ ] With two named accounts present, both phones receive the same round charade and show the same answer set.
- [ ] Count down off camera and tap the correct answer on both phones as closely together as possible. Exactly one
      account is announced as winner and enters authoring; the other remains responsive on the resolved reveal.
- [ ] Repeat with the opposite phone deliberately tapping first. The winning account changes accordingly; no client
      posts, guesses, or authors twice.
- [ ] LAUGH, CONFUSED, and GENIUS trigger the sender's local emote and a visible remote audience reaction.
- [ ] When one phone leaves, the round ends and the remaining phone returns to stable solo behavior.

Evidence: side-by-side video of both races and one reaction from each phone.

## Android and iOS control-safe pass

- [ ] The movement joystick remains usable and every native action/gamepad button is hidden on Android and iOS.
- [ ] In foyer, decode, reveal, author, posted, boards, invite, and notice overlays, no required control intersects the
      notch/Dynamic Island, home indicator, interactable inset, or bottom-right joystick area.
- [ ] Every action target is comfortably thumb-selectable, every answer is legible without zoom, and rapid taps do
      not activate an adjacent control.
- [ ] Camera transitions do not steal touch input or leave either client locked to the foyer, stage, or reveal camera.

Evidence: Android and iOS screenshots of foyer, decode, author, reveal, and invite, plus a short movement-and-tap
recording. Retain the iOS set for the mobile curation/featuring packet.

## Invite copy and open

- [ ] COPY INVITE changes the UI to the copied confirmation and places exactly
      `Can you decode my ghost? https://decentraland.org/jump/?realm=ghostcharades.dcl.eth` on the clipboard.
- [ ] Paste into a neutral notes field to verify the text, then tap the HTTPS link from a real messaging app on both
      Android and iOS. It opens the installed Decentraland client at `ghostcharades.dcl.eth`.
- [ ] If HTTPS fails to deep-link, record the OS/app behavior and separately test
      `decentraland://?realm=ghostcharades.dcl.eth`; do not change production copy during the checklist.

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
performance. The automated suite must separately prove the exact pre-`ready` outbound message list, the eight-slot
`AvatarShape` ceiling under simultaneous replier/pedestal allocation, asset triangle/material/size budgets, UTC
selection logic, and persistence writes. A release needs both forms of evidence from the same commit.
