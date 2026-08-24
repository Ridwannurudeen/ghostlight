import { beforeEach, describe, expect, it, vi } from 'vitest'

const uiTest = vi.hoisted(() => ({
  region: 'house',
  canReply: false,
  opening: { active: false, instruction: '' },
  state: {} as Record<string, unknown>
}))

const uiActions = vi.hoisted(() => ({
  showInvite: vi.fn(),
  setInviteStatus: vi.fn()
}))

const restrictedActions = vi.hoisted(() => ({ copyToClipboard: vi.fn(() => Promise.resolve()) }))

vi.mock('@dcl/sdk/react-ecs', async () => import('@dcl/react-ecs'))

vi.mock('~system/RestrictedActions', () => restrictedActions)

vi.mock('../src/client/setup', () => ({
  isPlayerInDecodeArea: () => uiTest.region === 'house' || uiTest.region === 'stage'
}))

vi.mock('../src/client/reactions', () => ({
  REACTION_OPTIONS: [
    { kind: 'laugh', label: 'LAUGH', emote: 'clap' },
    { kind: 'confused', label: 'CONFUSED', emote: 'shrug' },
    { kind: 'genius', label: 'GENIUS', emote: 'fistpump' }
  ],
  sendReaction: vi.fn(() => Promise.resolve(true))
}))

vi.mock('../src/client/opening-scene', () => ({
  getOpeningViewState: () => uiTest.opening,
  skipOpening: vi.fn()
}))

vi.mock('../src/client/flow', () => ({
  canAnswerBack: () => uiTest.canReply,
  clientFlow: {
    getState: () => uiTest.state,
    guess: vi.fn(),
    replay: vi.fn(),
    beginAuthoring: vi.fn(),
    beginAnswerBack: vi.fn(),
    backFromAuthor: vi.fn(),
    continueAuthoring: vi.fn(),
    reviseAuthorEmotes: vi.fn(),
    selectAuthorEmote: vi.fn(),
    shuffleAuthorPhrase: vi.fn(),
    previewAuthor: vi.fn(),
    postAuthor: vi.fn(),
    toggleReactionMenu: vi.fn(),
    requestNextCharade: vi.fn(),
    showBoards: vi.fn(),
    showInvite: uiActions.showInvite,
    setInviteStatus: uiActions.setInviteStatus,
    reportError: vi.fn()
  }
}))

import {
  COLORS,
  REVEAL_VERTICAL_BUDGET,
  formatPerformedAgo,
  performerPortraitBackground,
  uiComponent
} from '../src/client/ui'

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

function findButton(node: unknown, value: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findButton(child, value)
      if (match) return match
    }
    return null
  }
  if (node === null || typeof node !== 'object' || !('type' in node) || !('props' in node)) return null
  const element = node as ElementNode
  if (element.props.value === value && typeof element.props.onMouseDown === 'function') return element.props
  if (typeof element.type === 'function') return findButton(element.type(element.props), value)
  return findButton(element.props.children, value)
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
    reactionMenuOpen: false,
    errorCode: '',
    toast: null
  }
}

describe('UI colors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uiTest.region = 'house'
    uiTest.canReply = false
    uiTest.opening = { active: false, instruction: '' }
    uiTest.state = stateFor('decode')
  })

  it('does not let disabled buttons mutate the shared ink color across renders', () => {
    const inkAlpha = COLORS.ink.a

    render(uiComponent())
    render(uiComponent())

    expect(COLORS.ink.a).toBe(inkAlpha)
  })

  it('uses dark readable text for every unselected author emote', () => {
    const phrase = { id: 'phrase', text: 'Walking a dog' }
    uiTest.state = {
      ...stateFor('decode'),
      screen: 'author',
      author: {
        phrase,
        offeredEmotes: ['wave', 'clap', 'dab', 'dance', 'shrug'],
        selectedEmotes: [],
        shufflesRemaining: 2,
        phase: 'emotes'
      }
    }

    const button = findButton(uiComponent(), 'WAVE')
    expect(button?.color).toEqual(COLORS.ink)
  })
})

describe('mobile control budget', () => {
  it.each([
    ['phrase', 3],
    ['emotes', 5],
    ['confirm', 4]
  ] as const)('keeps author %s phase within five buttons', (phase, expected) => {
    uiTest.state = {
      ...stateFor('decode'),
      screen: 'author',
      author: {
        phrase: { id: 'phrase', text: 'Walking a dog' },
        offeredEmotes: ['wave', 'clap', 'dab', 'dance', 'shrug'],
        selectedEmotes: phase === 'confirm' ? ['wave', 'clap', 'dab'] : [],
        shufflesRemaining: 2,
        phase
      }
    }
    expect(collectButtons(uiComponent())).toHaveLength(expected)
  })

  it('replaces live-round answers with the four-control reaction menu', () => {
    uiTest.state = { ...stateFor('decode'), roundCharadeId: 'charade-1', reactionMenuOpen: false }
    expect(collectButtons(uiComponent())).toHaveLength(5)

    uiTest.state = { ...uiTest.state, reactionMenuOpen: true }
    expect(collectButtons(uiComponent()).map(({ value }) => value)).toEqual([
      'LAUGH',
      'CONFUSED',
      'GENIUS',
      'BACK TO ANSWERS'
    ])
  })

  it('fits reveal content and its single action row inside the fixed panel', () => {
    const usedHeight = Object.entries(REVEAL_VERTICAL_BUDGET)
      .filter(([key]) => key !== 'panelHeight')
      .reduce((total, [, value]) => total + value, 0)
    expect(usedHeight).toBeLessThanOrEqual(REVEAL_VERTICAL_BUDGET.panelHeight)
    uiTest.state = stateFor('reveal')
    expect(collectButtons(uiComponent()).map(({ value }) => value).sort()).toEqual(['MAKE YOUR OWN', 'NEXT GHOST'])
  })
})

describe('invite handoff', () => {
  it('copies an honest general World invite on the posted screen first tap', async () => {
    uiTest.state = stateFor('posted')
    const button = findButton(uiComponent(), 'COPY INVITE')
    ;(button?.onMouseDown as (() => void) | undefined)?.()
    await Promise.resolve()

    expect(uiActions.showInvite).toHaveBeenCalledTimes(1)
    expect(restrictedActions.copyToClipboard).toHaveBeenCalledWith({
      text: 'Join me for Ghostlight: https://decentraland.org/jump/?realm=ghostlight.dcl.eth'
    })
    expect(uiActions.setInviteStatus).toHaveBeenCalledWith('copied')
  })
})

describe('playbill time', () => {
  it('formats recent performances against the server-aligned clock', () => {
    const now = Date.UTC(2026, 7, 23, 12)
    expect(formatPerformedAgo(now - 20_000, now)).toBe('JUST NOW')
    expect(formatPerformedAgo(now - 3 * 60_000, now)).toBe('3M AGO')
    expect(formatPerformedAgo(now - 3 * 3_600_000, now)).toBe('3H AGO')
    expect(formatPerformedAgo(now - 2 * 86_400_000, now)).toBe('2D AGO')
  })

  it('uses avatarTexture for players and a real local texture for guests', () => {
    expect(performerPortraitBackground({ address: '0xPlayer', isGuest: false })).toMatchObject({
      avatarTexture: { userId: '0xPlayer' },
      textureMode: 'stretch'
    })
    expect(performerPortraitBackground({ address: 'guest-session', isGuest: true })).toMatchObject({
      texture: { src: 'assets/ui/card_selected.png' },
      textureMode: 'stretch'
    })
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

  it('shows answer-back only for an eligible revealed charade', () => {
    uiTest.region = 'stage'
    uiTest.state = stateFor('reveal')
    uiTest.canReply = true
    expect(collectButtons(uiComponent())).toContainEqual({ value: 'ANSWER BACK', disabled: false })

    uiTest.canReply = false
    expect(collectButtons(uiComponent()).some((button) => button.value === 'ANSWER BACK')).toBe(false)
  })
})
