# Ghost Charades device checklist

Run this checklist in the real Decentraland mobile app before every deployment candidate. Do not mark a result
from desktop preview. Record the device model, OS/app version, tested commit, date, and measured performance in
the release notes.

## Preparation

- [ ] `npm run build` and `npm test` pass on the exact commit under test.
- [ ] Open the owner's existing QR preview; do not start a second preview process.
- [ ] Use a Galaxy A54 on the High graphics profile for the reference pass.
- [ ] Keep a second mobile client available for the live-round pass.
- [ ] Confirm the preview is using authoritative multiplayer and not an offline fixed adapter.

## Cold start and first ten seconds

- [ ] Fully leave the World, allow the multiplayer isolate to shut down, then re-enter from a cold state.
- [ ] The foyer and “The theater is waking up…” screen appear immediately; no blank room is visible.
- [ ] No decode, author, or post request is sent before the server readiness heartbeat.
- [ ] “Tonight's ghosts are ready.” replaces the waking screen when the server responds.
- [ ] The marked foyer route gives the server time to wake before the player reaches the house.

## Solo loop

- [ ] The first performance is a real player's name/look, or is visibly labelled `HOUSE GHOST`.
- [ ] The performer uses the stored body shape, colours, and wearables.
- [ ] Three emotes loop in order at roughly 2.5-second steps; Replay restarts the sequence.
- [ ] Up to six distinct recent real visitors appear in the audience without a spawn burst.
- [ ] All three answers are legible, at least 96 px tall, and selectable with one thumb.
- [ ] Correct and incorrect guesses reveal the phrase and consistent aggregate counts.
- [ ] House guesses do not change decoder, author, or board counts.
- [ ] Make your own deals a phrase, allows no more than two shuffles, and offers five distinct valid emotes.
- [ ] Selecting three emotes preserves their order; Preview uses the current player's real look.
- [ ] Post confirms that the ghost is ready for the next stranger.
- [ ] Leaving and re-entering preserves the posted charade and player stats.
- [ ] A returning author with new attempts sees the nonzero “Since you left” summary once.

## HUD, camera, and accessibility

- [ ] The movement joystick remains; every native action/gamepad button is hidden.
- [ ] No required control overlaps the mobile interactable inset or bottom-right joystick area.
- [ ] Every screen contains one short instruction and high-contrast text.
- [ ] The stage camera frames the performer on entering the decode area.
- [ ] Leaving the decode area restores the main camera without a stuck or deleted-camera frame.
- [ ] The foyer, theater entrance, stage, and seats have no collision trap.

## Invite and return path

- [ ] Copy invite places `Can you decode my ghost? https://decentraland.org/jump/?realm=ghostcharades.dcl.eth`
      on the clipboard.
- [ ] The HTTPS invite opens the intended World in the installed mobile app.
- [ ] If the HTTPS link does not deep-link, record the result and test `decentraland://?realm=ghostcharades.dcl.eth`
      before changing production copy.
- [ ] Today's boards exclude the House ghost and display only real-player activity.

## Two-client live round

- [ ] Join with two distinct accounts and confirm both clients receive the same round charade.
- [ ] The first correct round guess produces one winner on both clients.
- [ ] The winning client moves into the author flow; the other client remains stable.
- [ ] Laugh, Confused, and Genius trigger the sender's local emote and a visible remote audience reaction.
- [ ] When one client leaves, the active round ends and the remaining client returns to solo behavior.

## Performance and release

- [ ] Performance remains above 90% on the Galaxy A54 High profile during performer plus six-audience playback.
- [ ] No more than eight avatar clones are active and all remain within 10 m of the stage camera.
- [ ] No visible particle effect, dynamic light, or unplanned catalog prop is present.
- [ ] After a deployment, every tester fully leaves and re-enters so no old instance is mistaken for the release.
- [ ] Run one uninterrupted five-minute solo loop and one full two-client round on the deployed candidate.
