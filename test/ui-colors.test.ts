import { beforeEach, describe, expect, it, vi } from 'vitest'

const uiTest = vi.hoisted(() => ({
  region: 'house',
  canReply: false,
  opening: { active: false, instruction: '' },
  state: {} as Record<string, unknown>,
  mailRecipients: [] as Array<{ address: string; name: string; isGuest: boolean; title: ''; performedAt: number }>
}))

const uiActions = vi.hoisted(() => ({
  showFoyer: vi.fn(),
  showInvite: vi.fn(),
  showSettings: vi.fn(),
  selectGhostMailRecipient: vi.fn(),
  clearGhostMailRecipient: vi.fn(),
  beginGhostMail: vi.fn(),
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
    { kind: 'laugh', emote: 'clap' },
    { kind: 'gasp', emote: 'headexplode' },
    { kind: 'applause', emote: 'clap' }
  ],
  sendReaction: vi.fn(() => Promise.resolve(true))
}))

vi.mock('../src/client/opening-scene', () => ({
  getOpeningViewState: () => uiTest.opening,
  skipOpening: vi.fn()
}))

vi.mock('../src/client/flow', () => ({
  canAnswerBack: () => uiTest.canReply,
  canSendMail: () => uiTest.mailRecipients.length > 0,
  canSpectatorReact: (state: Record<string, unknown>) =>
    state.ready === true &&
    (state.screen === 'foyer' || (state.screen === 'reveal' && state.reveal?.correct === false)) &&
    state.roundCharadeId !== '' &&
    state.pending?.length === 0,
  mailRecipients: () => uiTest.mailRecipients,
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
    showFoyer: uiActions.showFoyer,
    showInvite: uiActions.showInvite,
    showSettings: uiActions.showSettings,
    selectGhostMailRecipient: uiActions.selectGhostMailRecipient,
    clearGhostMailRecipient: uiActions.clearGhostMailRecipient,
    beginGhostMail: uiActions.beginGhostMail,
    setInviteStatus: uiActions.setInviteStatus,
    reportError: vi.fn()
  }
}))

import {
  COLORS,
  REVEAL_VERTICAL_BUDGET,
  formatPerformedAgo,
  localizedAnswers,
  performerPortraitBackground,
  shortWalletAddress,
  uiFontSize,
  uiComponent
} from '../src/client/ui'
import { DEFAULT_CLIENT_SETTINGS, getClientSettings, updateClientSettings } from '../src/client/settings'

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
    ready: true,
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

beforeEach(() => {
  vi.clearAllMocks()
  uiTest.region = 'house'
  uiTest.canReply = false
  uiTest.opening = { active: false, instruction: '' }
  uiTest.mailRecipients = []
  uiTest.state = stateFor('decode')
  updateClientSettings(DEFAULT_CLIENT_SETTINGS)
})

describe('UI colors', () => {
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
        offeredEmotes: ['wave', 'clap', 'dab', 'disco', 'shrug'],
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
  it('disambiguates identical Ghost Mail names by wallet and requires confirmation', () => {
    const alice = `0x${'1'.repeat(40)}`
    const otherAlice = `0x${'2'.repeat(40)}`
    uiTest.mailRecipients = [
      { address: alice, name: 'ALICE', isGuest: false, title: '', performedAt: 0 },
      { address: otherAlice, name: 'ALICE', isGuest: false, title: '', performedAt: 0 }
    ]
    uiTest.state = { ...stateFor('decode'), screen: 'mail', mailRecipient: null }

    const chooser = collectButtons(uiComponent())
    expect(chooser).toHaveLength(3)
    expect(chooser[0].value).toContain(shortWalletAddress(alice))
    expect(chooser[1].value).toContain(shortWalletAddress(otherAlice))
    ;(findButton(uiComponent(), chooser[0].value)?.onMouseDown as (() => void) | undefined)?.()
    expect(uiActions.selectGhostMailRecipient).toHaveBeenCalledWith(alice)
    expect(uiActions.beginGhostMail).not.toHaveBeenCalled()

    uiTest.state = {
      ...uiTest.state,
      mailRecipient: { address: alice, name: 'ALICE' }
    }
    expect(collectButtons(uiComponent()).map(({ value }) => value)).toEqual([
      'CONFIRM RECIPIENT',
      'CHOOSE SOMEONE ELSE'
    ])
    ;(findButton(uiComponent(), 'CONFIRM RECIPIENT')?.onMouseDown as (() => void) | undefined)?.()
    expect(uiActions.beginGhostMail).toHaveBeenCalledTimes(1)
  })

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
        offeredEmotes: ['wave', 'clap', 'dab', 'disco', 'shrug'],
        selectedEmotes: phase === 'confirm' ? ['wave', 'clap', 'dab'] : [],
        shufflesRemaining: 2,
        phase
      }
    }
    expect(collectButtons(uiComponent())).toHaveLength(expected)
  })

  it('offers the four-control reaction menu only from the foyer during a live round', () => {
    uiTest.state = {
      ...stateFor('decode'),
      screen: 'foyer',
      theme: 'food',
      progress: { daily: { stamped: false } },
      playerIsGuest: true,
      boards: { playbill: [] },
      roundCharadeId: 'charade-1',
      pending: [],
      reactionMenuOpen: false
    }
    expect(collectButtons(uiComponent())).toHaveLength(5)

    uiTest.state = { ...uiTest.state, reactionMenuOpen: true }
    expect(collectButtons(uiComponent()).map(({ value }) => value)).toEqual([
      'LAUGH',
      'GASP',
      'APPLAUSE',
      'BACK TO THE SHOW',
      'SETTINGS'
    ])
  })

  it('keeps reaction controls out of an active decode', () => {
    uiTest.state = { ...stateFor('decode'), roundCharadeId: 'charade-1', pending: [] }
    expect(collectButtons(uiComponent()).map(({ value }) => value)).toEqual([
      'ONE',
      'TWO',
      'THREE',
      'REPLAY',
      'MAKE YOUR OWN'
    ])
  })

  it('disables every Make Your Own control for guests', () => {
    for (const screen of ['foyer', 'decode', 'reveal'] as const) {
      uiTest.state = { ...stateFor(screen), playerIsGuest: true }
      const makeButton = collectButtons(uiComponent()).find(({ value }) => value === 'MAKE YOUR OWN')
      if (makeButton) expect(makeButton.disabled, screen).toBe(true)
    }
  })

  it('lets an incorrect round decoder react without stacking reveal actions', () => {
    uiTest.state = { ...stateFor('reveal'), roundCharadeId: 'charade-1' }
    expect(
      collectButtons(uiComponent())
        .map(({ value }) => value)
        .sort()
    ).toEqual(['NEXT GHOST', 'REACT'])

    uiTest.state = { ...uiTest.state, reactionMenuOpen: true }
    expect(collectButtons(uiComponent()).map(({ value }) => value)).toEqual([
      'LAUGH',
      'GASP',
      'APPLAUSE',
      'BACK TO THE SHOW'
    ])
  })

  it('makes a progress notice modal so hidden controls cannot exceed the budget', () => {
    uiTest.state = {
      ...stateFor('decode'),
      screen: 'foyer',
      theme: 'food',
      progress: { daily: { stamped: true } },
      notices: [{ id: 'stamp-1', kind: 'stamp' }]
    }
    expect(collectButtons(uiComponent())).toEqual([{ value: 'TAKE A BOW', disabled: false }])
  })

  it('fits reveal content and its single action row inside the fixed panel', () => {
    const usedHeight = Object.entries(REVEAL_VERTICAL_BUDGET)
      .filter(([key]) => key !== 'panelHeight')
      .reduce((total, [, value]) => total + value, 0)
    expect(usedHeight).toBeLessThanOrEqual(REVEAL_VERTICAL_BUDGET.panelHeight)
    uiTest.state = stateFor('reveal')
    expect(
      collectButtons(uiComponent())
        .map(({ value }) => value)
        .sort()
    ).toEqual(['MAKE YOUR OWN', 'NEXT GHOST'])
  })

  it('keeps the foyer at five controls with settings in the top area', () => {
    uiTest.state = {
      ...stateFor('decode'),
      screen: 'foyer',
      theme: 'food',
      themeLabel: 'Kitchen Capers',
      progress: { daily: { stamped: false } },
      playerIsGuest: true,
      boards: { playbill: [] }
    }

    expect(collectButtons(uiComponent())).toHaveLength(5)
    const settings = findButton(uiComponent(), 'SETTINGS')
    expect(settings?.uiTransform).toMatchObject({ position: { top: 24, right: 28 } })
    expect(settings?.uiTransform).not.toHaveProperty('position.bottom')
    ;(settings?.onMouseDown as (() => void) | undefined)?.()
    expect(uiActions.showSettings).toHaveBeenCalledTimes(1)
  })
})

describe('settings and accessibility', () => {
  it('changes sound, language, and both accessibility modes from a five-control panel', () => {
    uiTest.state = { ...stateFor('decode'), screen: 'settings', theme: 'food' }

    expect(collectButtons(uiComponent())).toHaveLength(5)
    ;(findButton(uiComponent(), 'SOUND: FULL')?.onMouseDown as (() => void) | undefined)?.()
    ;(findButton(uiComponent(), 'ACCESSIBILITY: OFF')?.onMouseDown as (() => void) | undefined)?.()
    ;(findButton(uiComponent(), 'ACCESSIBILITY: REDUCED')?.onMouseDown as (() => void) | undefined)?.()
    ;(findButton(uiComponent(), 'ACCESSIBILITY: LARGE TEXT')?.onMouseDown as (() => void) | undefined)?.()
    ;(findButton(uiComponent(), 'LANGUAGE: English')?.onMouseDown as (() => void) | undefined)?.()

    expect(getClientSettings()).toEqual({
      soundEnabled: false,
      soundVolume: 1,
      language: 'es',
      reducedMotion: true,
      largeText: true,
      diagnosticsEnabled: false
    })
    expect(uiFontSize(20)).toBe(24)
    ;(findButton(uiComponent(), 'VOLVER')?.onMouseDown as (() => void) | undefined)?.()
    expect(uiActions.showFoyer).toHaveBeenCalledTimes(1)
  })

  it('renders null-safe diagnostics in Settings without adding a sixth control', async () => {
    uiTest.state = { ...stateFor('decode'), screen: 'settings', theme: 'food' }
    ;(findButton(uiComponent(), 'DIAGNOSTICS: OFF')?.onMouseDown as (() => void) | undefined)?.()

    expect(() => uiComponent()).not.toThrow()
    expect(collectButtons(uiComponent()).map(({ value }) => value)).toEqual([
      'COPY DIAGNOSTICS',
      'DISABLE DIAGNOSTICS',
      'BACK'
    ])
    ;(findButton(uiComponent(), 'COPY DIAGNOSTICS')?.onMouseDown as (() => void) | undefined)?.()
    await Promise.resolve()
    expect(restrictedActions.copyToClipboard).toHaveBeenCalledWith({
      text: expect.stringMatching(/^GHOSTLIGHT_DIAGNOSTICS v1\n/)
    })
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

describe('localized answer rendering', () => {
  it('renders the same answer ids in the decoder language', () => {
    const charade = {
      ...stateFor('decode').charade,
      answerIds: ['everyday-wake-up-late', 'everyday-brush-your-teeth', 'everyday-miss-the-bus']
    }

    expect(localizedAnswers(charade as never, 'es')).toEqual([
      'Despertarse tarde',
      'Cepillarse los dientes',
      'Perder el autobús'
    ])
    expect(localizedAnswers(charade as never, 'pt')).toEqual([
      'Acordar atrasado',
      'Escovar os dentes',
      'Perder o ônibus'
    ])
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
