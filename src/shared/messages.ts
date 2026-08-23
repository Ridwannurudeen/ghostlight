import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

// Day-1 spike protocol. Every payload must be a Schemas.Map (plain objects fail binary serialization).
export const Messages = {
  hello: Schemas.Map({ name: Schemas.String }),
  ping: Schemas.Map({ seq: Schemas.Int }),
  pong: Schemas.Map({ seq: Schemas.Int, visits: Schemas.Int, serverTime: Schemas.Int })
}

export const room = registerMessages(Messages)
