import type { Language } from '../shared/i18n'
import { hasPerformerCompletedSequence } from './ghosts'
import { createOpeningController } from './opening'
import { play } from './sound'
import { releaseTheaterCamera, switchTheaterCamera } from './setup'
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
  let cameraHeld = false
  let waitingForPerformer = false

  function releaseCamera() {
    if (!cameraHeld) return
    cameraHeld = false
    waitingForPerformer = false
    releaseTheaterCamera()
  }

  const controller = createOpeningController({
    switchCamera: (camera) => {
      cameraHeld = true
      switchTheaterCamera(camera)
    },
    setMarquee: (text) => marquee.setText(text),
    openDoors: () => {
      play('curtain')
      foyerDoors.open()
    },
    enterPerformer: () => {
      waitingForPerformer = true
      enterPerformer()
    },
    showInstruction: (instruction) => {
      openingView = { ...openingView, instruction }
    },
    showDecode: () => {
      openingView = { ...EMPTY_OPENING_VIEW }
      showDecode()
    }
  })

  const sceneController = {
    start(themeLabel: string, language: Language = 'en') {
      openingView = { active: true, instruction: '' }
      const started = controller.start(themeLabel, language)
      if (!started) openingView = { ...EMPTY_OPENING_VIEW }
      return started
    },
    tick(deltaSeconds: number) {
      controller.tick(deltaSeconds)
      if (waitingForPerformer && hasPerformerCompletedSequence()) releaseCamera()
    },
    skip: controller.skip,
    cancel() {
      const cancelled = controller.cancel()
      const hadSceneOwnership = cameraHeld || openingView.active
      openingView = { ...EMPTY_OPENING_VIEW }
      releaseCamera()
      return cancelled || hadSceneOwnership
    },
    isRunning: controller.isRunning,
    hasPlayed: controller.hasPlayed
  }

  skipActiveOpening = sceneController.skip
  return sceneController
}
