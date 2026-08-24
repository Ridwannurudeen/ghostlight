import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  inArea: true,
  state: {
    ready: true,
    screen: 'foyer',
    roundCharadeId: 'live-1',
    pending: [] as unknown[]
  },
  triggerEmote: vi.fn(() => Promise.resolve()),
  send: vi.fn(() => Promise.resolve()),
  showLocalReaction: vi.fn()
}))

vi.mock('~system/RestrictedActions', () => ({ triggerEmote: harness.triggerEmote }))
vi.mock('../src/shared/messages', () => ({ room: { send: harness.send } }))
vi.mock('../src/client/setup', () => ({ isPlayerInDecodeArea: () => harness.inArea }))
vi.mock('../src/client/flow', () => ({
  canSpectatorReact: (state: typeof harness.state) =>
    state.ready && state.screen === 'foyer' && state.roundCharadeId !== '' && state.pending.length === 0,
  clientFlow: {
    getState: () => harness.state,
    showLocalReaction: harness.showLocalReaction
  }
}))

import { sendReaction } from '../src/client/reactions'

describe('spectator reaction presses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.inArea = true
    Object.assign(harness.state, { ready: true, screen: 'foyer', roundCharadeId: 'live-1', pending: [] })
  })

  it('relays exactly one selected stamp and mirrors it locally after a real press', async () => {
    await expect(sendReaction('gasp')).resolves.toBe(true)

    expect(harness.triggerEmote).toHaveBeenCalledOnce()
    expect(harness.send).toHaveBeenCalledOnce()
    expect(harness.send).toHaveBeenCalledWith('react', { kind: 'gasp' })
    expect(harness.showLocalReaction).toHaveBeenCalledWith('gasp')
  })

  it.each([
    ['decode', true],
    ['foyer', false]
  ])('does not relay without spectator eligibility (%s)', async (screen, inArea) => {
    harness.state.screen = screen
    harness.inArea = inArea

    await expect(sendReaction('laugh')).resolves.toBe(false)
    expect(harness.triggerEmote).not.toHaveBeenCalled()
    expect(harness.send).not.toHaveBeenCalled()
    expect(harness.showLocalReaction).not.toHaveBeenCalled()
  })
})
