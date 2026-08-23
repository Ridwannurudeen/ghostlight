import { isServer } from '@dcl/sdk/network'
import { startServer } from './server/server'
import { startClient } from './client/spike'
import { setupUi } from './client/ui'

// Day-1 device spike (throwaway): proves on a real phone that the Multiplayer Server wakes and persists,
// that a clone of the player's own avatar renders and loops emotes, what a plain tap on a 3D entity does,
// and whether the invite link copies. Replaced by the real scene once the spec's plan starts.
export function main() {
  if (isServer()) {
    startServer()
    return
  }
  startClient()
  setupUi()
}
