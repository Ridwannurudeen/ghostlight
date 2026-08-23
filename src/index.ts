import { engine } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { clientFlow, startClientFlow } from './client/flow'
import {
  clearPerformer,
  clearPreview,
  react as reactAudience,
  replayPerformer,
  setAudience,
  showPerformer,
  showPreview
} from './client/ghosts'
import { createSceneOpeningController } from './client/opening-scene'
import { createSceneRevealController } from './client/reveal-scene'
import { startClientSetup } from './client/setup'
import { duckForReveal, play, restoreAfterReveal } from './client/sound'
import { uiComponent } from './client/ui'
import { startServer } from './server/server'

export function main() {
  if (isServer()) {
    startServer()
    return
  }

  const reveal = createSceneRevealController({ play, duck: duckForReveal, restore: restoreAfterReveal })
  let stagedPerformer: Parameters<typeof showPerformer> | null = null
  let openingReadyForPerformer = false
  const opening = createSceneOpeningController(
    () => {
      openingReadyForPerformer = true
      if (stagedPerformer) {
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

  clientFlow.setEffects({
    showPerformer: (look, emotes) => {
      if (opening.isRunning() && !openingReadyForPerformer) {
        stagedPerformer = [look, emotes]
        return
      }
      showPerformer(look, emotes)
    },
    replayPerformer,
    showPreview,
    beginReveal: reveal.begin,
    resolveReveal: reveal.resolve,
    skipReveal: reveal.skipToEnd,
    cancelReveal: reveal.cancel
  })

  let audience = clientFlow.getState().audience
  let reactionSequence = 0
  let screen = clientFlow.getState().screen
  clientFlow.subscribe((state) => {
    if (state.ready && state.screen === 'foyer' && !opening.hasPlayed() && opening.start('OPENING NIGHT')) {
      clientFlow.requestNextCharade()
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
      if (screen === 'author') clearPerformer()
      if (screen === 'decode' || screen === 'foyer' || screen === 'posted') clearPreview()
    }
  })

  startClientSetup(uiComponent)
  engine.addSystem((deltaSeconds) => opening.tick(deltaSeconds), undefined, 'ghost-charades::opening')
  startClientFlow()
}
