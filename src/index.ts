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
import { startClientSetup } from './client/setup'
import { uiComponent } from './client/ui'
import { startServer } from './server/server'

export function main() {
  if (isServer()) {
    startServer()
    return
  }

  clientFlow.setEffects({
    showPerformer,
    replayPerformer,
    showPreview
  })

  let audience = clientFlow.getState().audience
  let reactionSequence = 0
  let screen = clientFlow.getState().screen
  clientFlow.subscribe((state) => {
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
  startClientFlow()
}
