import { room } from '../shared/messages'

const INSTANCE_ID = String(Date.now())

export function startServer() {
  room.onMessage('hello', (_data, context) => {
    const to = context?.from
    if (to) {
      void room.send('ready', { instanceId: INSTANCE_ID, serverTime: Date.now() }, { to: [to] })
    }
  })

  room.onMessage('ping', (data, context) => {
    const to = context?.from
    if (to) {
      void room.send('pong', { seq: data.seq }, { to: [to] })
    }
  })
}
