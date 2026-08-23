import { beforeEach, describe, expect, it, vi } from 'vitest'

const uiTest = vi.hoisted(() => ({
  region: 'house',
  opening: { active: false, instruction: '' },
  state: {} as Record<string, unknown>
}))

vi.mock('@dcl/sdk/react-ecs', async () => import('@dcl/react-ecs'))

vi.mock('~system/RestrictedActions', () => ({
  copyToClipboard: vi.fn()
}))

vi.mock('../src/client/setup', () => ({
  getCurrentTheaterRegion: () => uiTest.region
}))

vi.mock('../src/client/reactions', () => ({
  REACTION_OPTIONS: [],
  sendReaction: vi.fn()
}))

vi.mock('../src/client/opening-scene', () => ({
  getOpeningViewState: () => uiTest.opening,
  skipOpening: vi.fn()
}))

vi.mock('../src/client/flow', () => ({
  clientFlow: {
    getState: () => uiTest.state,
    guess: vi.fn(),
    replay: vi.fn(),
    beginAuthoring: vi.fn(),
    requestNextCharade: vi.fn(),
    showBoards: vi.fn(),
    showInvite: vi.fn()
  }
}))

import { COLORS, uiComponent } from '../src/client/ui'

type ElementNode = {
  type: string | ((props: Record<string, unknown>) => unknown)
  props: Record<string, unknown>
}

type ButtonProps = {
  value: string
  disabled: boolean
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

function collectButtons(node: unknown, buttons: ButtonProps[] = []): ButtonProps[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectButtons(child, buttons))
    return buttons
  }
  if (node === null || typeof node !== 'object' || !('type' in node) || !('props' in node)) return buttons

  const element = node as ElementNode
  if (typeof element.props.value === 'string' && typeof element.props.onMouseDown === 'function') {
    buttons.push({ value: element.props.value, disabled: element.props.disabled === true })
  }
  if (typeof element.type === 'function') {
    collectButtons(element.type(element.props), buttons)
    return buttons
  }
  collectButtons(element.props.children, buttons)
  return buttons
}

function stateFor(screen: 'decode' | 'reveal' | 'posted') {
  const charade = {
    id: 'charade-1',
    authorName: 'Author',
    answers: ['One', 'Two', 'Three'],
    isHouse: false
  }
  return {
    screen,
    charade,
    reveal:
      screen === 'reveal'
        ? {
            charadeId: charade.id,
            correct: false,
            phrase: 'Answer one',
            stats: { total: 1, correct: 0 },
            yourScore: 0
          }
        : null,
    pending: screen === 'decode' ? [{ requestId: 'request-1', kind: 'guess', sentAt: 0, retries: 0 }] : [],
    roundCharadeId: '',
    errorCode: '',
    toast: null
  }
}

describe('UI colors', () => {
  beforeEach(() => {
    uiTest.region = 'house'
    uiTest.opening = { active: false, instruction: '' }
    uiTest.state = stateFor('decode')
  })

  it('does not let disabled buttons mutate the shared ink color across renders', () => {
    const inkAlpha = COLORS.ink.a

    render(uiComponent())
    render(uiComponent())

    expect(COLORS.ink.a).toBe(inkAlpha)
  })
})

describe('cold-open overlay', () => {
  it('hides decode controls behind one clear skip action', () => {
    uiTest.region = 'house'
    uiTest.opening = { active: true, instruction: "Guess what they're saying" }
    uiTest.state = stateFor('decode')

    const buttons = collectButtons(uiComponent())

    expect(buttons).toEqual([{ value: 'SKIP INTRO', disabled: false }])
  })
})

describe('decode region gates', () => {
  beforeEach(() => {
    uiTest.opening = { active: false, instruction: '' }
  })

  it.each([
    ['reveal', 'house', 'NEXT GHOST', false, 'NEXT GHOST'],
    ['reveal', 'stage', 'NEXT GHOST', false, 'NEXT GHOST'],
    ['reveal', 'foyer', 'NEXT GHOST', true, 'WALK TO THE STAGE'],
    ['reveal', 'outside', 'NEXT GHOST', true, 'WALK TO THE STAGE'],
    ['posted', 'house', 'DECODE ANOTHER', false, 'DECODE ANOTHER'],
    ['posted', 'stage', 'DECODE ANOTHER', false, 'DECODE ANOTHER'],
    ['posted', 'foyer', 'DECODE ANOTHER', true, 'WALK TO THE STAGE'],
    ['posted', 'outside', 'DECODE ANOTHER', true, 'WALK TO THE STAGE']
  ] as const)('gates %s action in the %s region', (screen, region, originalLabel, disabled, expectedLabel) => {
    uiTest.region = region
    uiTest.state = stateFor(screen)

    const buttons = collectButtons(uiComponent())

    expect(buttons).toContainEqual({ value: expectedLabel, disabled })
    if (disabled) expect(buttons.some((button) => button.value === originalLabel)).toBe(false)
  })
})
