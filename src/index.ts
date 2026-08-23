import { isServer } from '@dcl/sdk/network'
import { startClient } from './client/spike'
import { setupUi } from './client/ui'
import { startServer } from './server/server'

export function main() {
  isServer() ? startServer() : startClient({ onPlatformKnown: setupUi })
}
