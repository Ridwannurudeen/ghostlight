import { Storage } from '@dcl/sdk/server'
import { room } from '../shared/messages'

const VISITS_KEY = 'spike:v1:visits'

let visits = 0
let hydrated = false

async function hydrate() {
  const stored = await Storage.get<string>(VISITS_KEY)
  const parsed = stored === null ? 0 : parseInt(stored, 10)
  visits = Number.isFinite(parsed) ? parsed : 0
  hydrated = true
  console.log(`[spike-server] hydrated visits=${visits}`)
}

export function startServer() {
  void hydrate()

  room.onMessage('hello', async (data, context) => {
    if (!hydrated) await hydrate()
    visits += 1
    // Storage.set never throws: a false result is a silently lost save unless we look at it.
    const ok = await Storage.set(VISITS_KEY, String(visits))
    console.log(`[spike-server] hello from ${context?.from ?? '?'} (${data.name}) visits=${visits} saved=${ok}`)
    void room.send('pong', { seq: 0, visits: ok ? visits : -visits, serverTime: Date.now() })
  })

  room.onMessage('ping', (data, context) => {
    const to = context?.from
    void room.send('pong', { seq: data.seq, visits, serverTime: Date.now() }, to ? { to: [to] } : undefined)
  })
}
