import { createOpeningController } from './opening'
import { play } from './sound'
import { switchTheaterCamera } from './setup'
import { foyerDoors, marquee } from './theater'

export type OpeningViewState = {
  active: boolean
  instruction: string
}

const EMPTY_OPENING_VIEW: OpeningViewState = { active: false, instruction: '' }

let openingView: OpeningViewState = { ...EMPTY_OPENING_VIEW }
let skipActiveOpening: (() => boolean) | null = null

export function getOpeningViewState() {
  return openingView
}

export function skipOpening() {
  return skipActiveOpening?.() ?? false
}

export function createSceneOpeningController(enterPerformer: () => void, showDecode: () => void) {
  const controller = createOpeningController({
    switchCamera: (camera) => switchTheaterCamera(camera),
    setMarquee: (text) => marquee.setText(text),
    openDoors: () => {
      play('curtain')
      foyerDoors.open()
    },
    enterPerformer,
    showInstruction: (instruction) => {
      openingView = { ...openingView, instruction }
    },
    showDecode: () => {
      openingView = { ...EMPTY_OPENING_VIEW }
      showDecode()
    }
  })

  const sceneController = {
    start(themeLabel: string) {
      openingView = { active: true, instruction: '' }
      const started = controller.start(themeLabel)
      if (!started) openingView = { ...EMPTY_OPENING_VIEW }
      return started
    },
    tick: controller.tick,
    skip: controller.skip,
    isRunning: controller.isRunning,
    hasPlayed: controller.hasPlayed
  }

  skipActiveOpening = sceneController.skip
  return sceneController
}
