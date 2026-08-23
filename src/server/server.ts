import { Storage } from '@dcl/sdk/server'
import { room } from '../shared/messages'

const VISITS_KEY = 'spike:v1:visits'

let visits = 0
// One hydration for the lifetime of the isolate, shared by startup and every handler.
let hydration: Promise<void> | undefined

function hydrate(): Promise<void> {
  if (!hydration) {
    hydration = Storage.get<string>(VISITS_KEY).then((stored) => {
      const parsed = stored === null ? 0 : parseInt(stored, 10)
      visits = Number.isFinite(parsed) ? parsed : 0
      console.log(`[spike-server] hydrated visits=${visits}`)
    })
  }
  return hydration
}

export function startServer() {
  void hydrate()

  room.onMessage('hello', async (data, context) => {
    await hydrate()
    visits += 1
    // Storage.set never throws: a false result is a silently lost save unless we look at it.
    const saved = await Storage.set(VISITS_KEY, String(visits))
    // A true from set() is not a round-trip; read the key back, bypassing the cache.
    const back = await Storage.get<string>(VISITS_KEY, { fresh: true })
    const readBack = back === String(visits)
    console.log(
      `[spike-server] hello from ${context?.from ?? '?'} (${data.name}) visits=${visits} saved=${saved} readBack=${readBack}`
    )
    const to = context?.from
    void room.send('helloAck', { visits, saved, readBack }, to ? { to: [to] } : undefined)
  })

  room.onMessage('ping', (data, context) => {
    const to = context?.from
    void room.send('pong', { seq: data.seq }, to ? { to: [to] } : undefined)
  })
}
