import { describe, expect, it, vi } from 'vitest'

vi.mock('@dcl/sdk/react-ecs', async () => import('@dcl/react-ecs'))

vi.mock('~system/RestrictedActions', () => ({
  copyToClipboard: vi.fn()
}))

vi.mock('../src/client/setup', () => ({
  getCurrentTheaterRegion: () => 'house'
}))

vi.mock('../src/client/reactions', () => ({
  REACTION_OPTIONS: [],
  sendReaction: vi.fn()
}))

vi.mock('../src/client/flow', () => ({
  clientFlow: {
    getState: () => ({
      screen: 'decode',
      charade: {
        id: 'charade-1',
        authorName: 'Author',
        answers: ['One', 'Two', 'Three'],
        isHouse: false
      },
      pending: [{ requestId: 'request-1', kind: 'guess', sentAt: 0, retries: 0 }],
      roundCharadeId: '',
      errorCode: '',
      toast: null
    }),
    guess: vi.fn(),
    replay: vi.fn(),
    beginAuthoring: vi.fn()
  }
}))

import { COLORS, uiComponent } from '../src/client/ui'

type ElementNode = {
  type: string | ((props: Record<string, unknown>) => unknown)
  props: Record<string, unknown>
}

function render(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(render)
    return
  }
  if (node === null || typeof node !== 'object' || !('type' in node) || !('props' in node)) return

  const element = node as ElementNode
  if (typeof element.type === 'function') {
    render(element.type(element.props))
    return
  }
  render(element.props.children)
}

describe('UI colors', () => {
  it('does not let disabled buttons mutate the shared ink color across renders', () => {
    const inkAlpha = COLORS.ink.a

    render(uiComponent())
    render(uiComponent())

    expect(COLORS.ink.a).toBe(inkAlpha)
  })
})
