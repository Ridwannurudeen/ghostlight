import { isServer } from '@dcl/sdk/network'
import { startClientFlow } from './client/flow'
import { startClientSetup } from './client/setup'
import { uiComponent } from './client/ui'
import { startServer } from './server/server'

export function main() {
  if (isServer()) {
    startServer()
    return
  }

  startClientSetup(uiComponent)
  startClientFlow()
}
