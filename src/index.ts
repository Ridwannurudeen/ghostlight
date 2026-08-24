import { engine } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { onLeaveScene } from '@dcl/sdk/src/players'
import { THEMES } from './shared/config'
import { clientFlow, startClientFlow } from './client/flow'
import {
  clearPerformer,
  clearGhostOfNight,
  clearPreview,
  react as reactAudience,
  replayPerformer,
  setAudience,
  showDuet,
  showPerformer,
  showGhostOfNight,
  showPreview
} from './client/ghosts'
import { createSceneOpeningController } from './client/opening-scene'
import { createSceneRevealController } from './client/reveal-scene'
import { isPlayerInDecodeArea, startClientSetup } from './client/setup'
import { duckForReveal, play, restoreAfterReveal } from './client/sound'
import {
  clearStageRewardProp,
  refreshRewardProps,
  removeRewardProp,
  setRewardProp,
  setStageRewardProp
} from './client/rewards'
import { lights, marquee } from './client/theater'
import { uiComponent } from './client/ui'
import { startServer } from './server/server'

export function main() {
  if (isServer()) {
    startServer()
    return
  }

  const reveal = createSceneRevealController({ play, duck: duckForReveal, restore: restoreAfterReveal })
  let stagedPerformer: Parameters<typeof showPerformer> | null = null
  let stagedDuet: Parameters<typeof showDuet> | null = null
  let openingReadyForPerformer = false
  const opening = createSceneOpeningController(
    () => {
      openingReadyForPerformer = true
      if (stagedDuet) {
        showDuet(...stagedDuet)
        stagedDuet = null
        stagedPerformer = null
      } else if (stagedPerformer) {
        showPerformer(...stagedPerformer)
        stagedPerformer = null
      }
    },
    () => {
      const state = clientFlow.getState()
      if (!state.charade && !state.pending.some((request) => request.kind === 'nextCharade')) {
        clientFlow.requestNextCharade()
      }
    }
  )
  let pedestalGhost: Parameters<typeof showGhostOfNight>[0] | null = null

  function syncPedestalGhost() {
    const screen = clientFlow.getState().screen
    if (pedestalGhost && (screen === 'foyer' || screen === 'since' || screen === 'boards' || screen === 'invite')) {
      showGhostOfNight(pedestalGhost)
    } else {
      clearGhostOfNight()
    }
  }

  clientFlow.setEffects({
    showPerformer: (look, emotes) => {
      if (opening.isRunning() && !openingReadyForPerformer) {
        stagedPerformer = [look, emotes]
        stagedDuet = null
        return
      }
      showPerformer(look, emotes)
    },
    showDuet: (author, reply) => {
      if (opening.isRunning() && !openingReadyForPerformer) {
        stagedDuet = [author, reply]
        stagedPerformer = null
        return
      }
      showDuet(author, reply)
    },
    replayPerformer,
    showPreview,
    clearPreview,
    clearPerformer,
    showReward: setRewardProp,
    showStageReward: setStageRewardProp,
    clearStageReward: clearStageRewardProp,
    showGhostOfNight: (ghost) => {
      pedestalGhost = ghost?.look ?? null
      syncPedestalGhost()
    },
    beginReveal: reveal.begin,
    resolveReveal: reveal.resolve,
    skipReveal: reveal.skipToEnd,
    cancelReveal: reveal.cancel,
    cancelOpening: opening.cancel
  })

  let audience = clientFlow.getState().audience
  let reactionSequence = 0
  let screen = clientFlow.getState().screen
  let theme = ''
  const playedNotices = new Set<string>()
  clientFlow.subscribe((state) => {
    if (state.theme !== theme) {
      theme = state.theme
      const accent = THEMES.find((candidate) => candidate.id === theme)?.accent
      if (accent) lights.setThemeAccent(accent)
      marquee.setText(`TONIGHT'S SHOW: ${state.themeLabel}`)
    }

    for (const notice of state.notices) {
      if (playedNotices.has(notice.id)) continue
      playedNotices.add(notice.id)
      if (state.screen !== 'reveal') play(notice.kind === 'stamp' ? 'stamp' : 'unlock')
    }

    if (state.audience !== audience) {
      audience = state.audience
      setAudience(audience)
    }

    const nextReactionSequence = state.reactionEvent?.sequence ?? 0
    if (state.reactionEvent && nextReactionSequence > reactionSequence) {
      reactionSequence = nextReactionSequence
      reactAudience(state.reactionEvent.kind)
    }

    if (state.screen !== screen) {
      screen = state.screen
      if (screen === 'author' && !state.author?.replyTo) clearPerformer()
      if (screen === 'decode' || screen === 'foyer' || screen === 'posted') clearPreview()
      syncPedestalGhost()
    }
  })

  onLeaveScene((address) => removeRewardProp(address))

  startClientSetup(uiComponent)
  let rewardRefreshElapsed = 0
  engine.addSystem(
    (deltaSeconds) => {
      rewardRefreshElapsed += deltaSeconds
      if (rewardRefreshElapsed >= 1) {
        rewardRefreshElapsed = 0
        refreshRewardProps()
      }
      const state = clientFlow.getState()
      if (
        state.ready &&
        state.screen === 'foyer' &&
        !opening.hasPlayed() &&
        isPlayerInDecodeArea() &&
        opening.start(state.themeLabel)
      ) {
        clientFlow.requestNextCharade()
      }
      opening.tick(deltaSeconds)
    },
    undefined,
    'ghostlight::opening'
  )
  startClientFlow()
}
