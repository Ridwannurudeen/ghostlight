import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

// Day-1 spike protocol. Every payload must be a Schemas.Map (plain objects fail binary serialization).
// Schemas.Int is a 32-bit write: never put Date.now() in one.
export const Messages = {
  hello: Schemas.Map({ name: Schemas.String }),
  // Sent only to the player who said hello: did the visit counter persist and read back?
  helloAck: Schemas.Map({ visits: Schemas.Int, saved: Schemas.Boolean, readBack: Schemas.Boolean }),
  ping: Schemas.Map({ seq: Schemas.Int }),
  pong: Schemas.Map({ seq: Schemas.Int })
}

export const room = registerMessages(Messages)
