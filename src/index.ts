import { engine } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { onLeaveScene } from '@dcl/sdk/src/players'
import { THEMES } from './shared/config'
import { t, themeLabel } from './shared/i18n'
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
import { startClientSetup } from './client/setup'
import { getClientSettings, subscribeClientSettings } from './client/settings'
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
      const presentedLook = clientFlow.getState().charade?.isHouse
        ? { ...look, name: t('decode.houseGhost', getClientSettings().language) }
        : look
      if (opening.isRunning() && !openingReadyForPerformer) {
        stagedPerformer = [presentedLook, emotes]
        stagedDuet = null
        return
      }
      showPerformer(presentedLook, emotes)
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
    showRetryBeat: (beatIndex) => reveal.retry(beatIndex),
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
    canAdvanceReveal: reveal.canAdvance,
    skipReveal: reveal.skipToEnd,
    cancelReveal: reveal.cancel,
    cancelOpening: opening.cancel
  })

  let audience = clientFlow.getState().audience
  let reactionSequence = 0
  let screen = clientFlow.getState().screen
  let theme = ''
  let language = getClientSettings().language
  const playedNotices = new Set<string>()

  function syncMarquee() {
    const state = clientFlow.getState()
    marquee.setText(t('marquee.tonightShow', language, { theme: themeLabel(state.theme, language) }))
  }

  clientFlow.subscribe((state) => {
    if (state.theme !== theme) {
      theme = state.theme
      const accent = THEMES.find((candidate) => candidate.id === theme)?.accent
      if (accent) lights.setThemeAccent(accent)
      syncMarquee()
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

  subscribeClientSettings((settings) => {
    if (settings.language === language) return
    language = settings.language
    syncMarquee()
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
        opening.start(themeLabel(state.theme, language), language)
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
