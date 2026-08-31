import { engine } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { onLeaveScene } from '@dcl/sdk/src/players'
import { THEMES } from './shared/config'
import { seasonZeroShowLabel, t, themeLabel } from './shared/i18n'
import { clientFlow, startClientFlow, type ClientFlowState } from './client/flow'
import { acceptedShowPolicy, showPolicyForTimestamp } from './shared/show-policy'
import {
  clearPerformer,
  clearGhostOfNight,
  clearPreview,
  react as reactAudience,
  replayPerformer,
  setAudience,
  showDuet,
  showAuthorBeat,
  showPerformer,
  showGhostOfNight,
  showPreview
} from './client/ghosts'
import { createSceneOpeningController } from './client/opening-scene'
import { createSceneRevealController } from './client/reveal-scene'
import { releaseTheaterCamera, startClientSetup, switchTheaterCamera } from './client/setup'
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

function currentShowPolicy(state: ClientFlowState) {
  return showPolicyForTimestamp(Date.now() + state.serverClockOffset)
}

function hasCurrentShowSchedule(
  state: ClientFlowState,
  policy: ReturnType<typeof showPolicyForTimestamp> = currentShowPolicy(state)
) {
  return state.ready && acceptedShowPolicy(policy, state.showKey, state.season) !== null
}

function currentShowLabel(
  state: ClientFlowState,
  language: Parameters<typeof themeLabel>[1],
  policy: ReturnType<typeof showPolicyForTimestamp> = currentShowPolicy(state)
) {
  const weeklyLabel = hasCurrentShowSchedule(state, policy) ? seasonZeroShowLabel(state.season, language) : null
  return weeklyLabel ?? themeLabel(policy?.legacyTheme.id ?? state.theme, language)
}

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
      if (
        hasCurrentShowSchedule(state) &&
        !state.charade &&
        !state.pending.some((request) => request.kind === 'nextCharade')
      ) {
        clientFlow.requestOpeningCharade()
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
    showAuthorBeat,
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
    restoreReveal: reveal.restore,
    canAdvanceReveal: reveal.canAdvance,
    skipReveal: reveal.skipToEnd,
    cancelReveal: reveal.cancel,
    cancelOpening: () => {
      stagedPerformer = null
      stagedDuet = null
      openingReadyForPerformer = false
      return opening.cancel()
    },
    acquirePracticeCamera: () => switchTheaterCamera('stage'),
    releasePracticeCamera: releaseTheaterCamera
  })

  let audience = clientFlow.getState().audience
  let reactionSequence = 0
  let screen = clientFlow.getState().screen
  let theme = ''
  let language = getClientSettings().language
  let marqueeText = ''
  const playedNotices = new Set<string>()

  function syncMarquee() {
    const state = clientFlow.getState()
    const text = t('marquee.tonightShow', language, { theme: currentShowLabel(state, language) })
    if (text === marqueeText) return
    marqueeText = text
    marquee.setText(text)
  }

  clientFlow.subscribe((state) => {
    const themeChanged = state.theme !== theme
    if (themeChanged) {
      theme = state.theme
      const accent = THEMES.find((candidate) => candidate.id === theme)?.accent
      if (accent) lights.setThemeAccent(accent)
    }
    syncMarquee()

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
      const policy = currentShowPolicy(state)
      syncMarquee()
      if (
        hasCurrentShowSchedule(state, policy) &&
        state.screen === 'foyer' &&
        !opening.hasPlayed() &&
        opening.start(currentShowLabel(state, language, policy), language)
      ) {
        clientFlow.requestOpeningCharade()
      }
      opening.tick(deltaSeconds)
    },
    undefined,
    'ghostlight::opening'
  )
  startClientFlow()
}
