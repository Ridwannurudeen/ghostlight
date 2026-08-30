import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const uiTest = vi.hoisted(() => ({
  region: 'house',
  canReply: false,
  opening: { active: false, instruction: '' },
  revealPresentation: {
    verdict: null,
    verdictText: '',
    stats: null,
    complete: false,
    selectedAnswerIndex: -1,
    wrongAnswersFaded: false,
    answerRevealed: false,
    phrase: ''
  },
  state: {} as Record<string, unknown>,
  performerBeat: null as 0 | 1 | 2 | null,
  mailRecipients: [] as Array<{ address: string; name: string; isGuest: boolean; title: ''; performedAt: number }>
}))

const uiActions = vi.hoisted(() => ({
  showFoyer: vi.fn(),
  showInvite: vi.fn(),
  showSettings: vi.fn(),
  showHowToPlay: vi.fn(),
  selectGhostMailRecipient: vi.fn(),
  clearGhostMailRecipient: vi.fn(),
  beginGhostMail: vi.fn(),
  beginAuthoring: vi.fn(),
  requestNextCharade: vi.fn(),
  toggleSpotlight: vi.fn(),
  toggleTouringConsent: vi.fn(),
  moreAuthorEmotes: vi.fn(),
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

vi.mock('../src/client/reveal-scene', () => ({
  getRevealViewState: () => uiTest.revealPresentation
}))

vi.mock('../src/client/ghosts', () => ({
  getPerformerBeatIndex: () => uiTest.performerBeat
}))

vi.mock('../src/client/flow', () => ({
  canAnswerBack: () => uiTest.canReply,
  canSendMail: () => uiTest.mailRecipients.length > 0,
  canToggleTouringConsent: (author: Record<string, unknown> | null) =>
    author?.phase === 'confirm' && !author.replyTo && !author.recipient,
  canSpectatorReact: (state: Record<string, unknown>) =>
    state.ready === true &&
    (state.screen === 'foyer' || (state.screen === 'reveal' && state.reveal?.correct === false)) &&
    state.roundCharadeId !== '' &&
    state.pending?.length === 0,
  mailRecipients: () => uiTest.mailRecipients,
  clientFlow: {
    getState: () => uiTest.state,
    canAnswerBack: () => uiTest.canReply,
    guess: vi.fn(),
    toggleSpotlight: uiActions.toggleSpotlight,
    replay: vi.fn(),
    beginAuthoring: uiActions.beginAuthoring,
    beginAnswerBack: vi.fn(),
    backFromAuthor: vi.fn(),
    continueAuthoring: vi.fn(),
    reviseAuthorEmotes: vi.fn(),
    toggleTouringConsent: uiActions.toggleTouringConsent,
    selectAuthorEmote: vi.fn(),
    moreAuthorEmotes: uiActions.moreAuthorEmotes,
    shuffleAuthorPhrase: vi.fn(),
    previewAuthor: vi.fn(),
    postAuthor: vi.fn(),
    toggleReactionMenu: vi.fn(),
    requestNextCharade: uiActions.requestNextCharade,
    showBoards: vi.fn(),
    showFoyer: uiActions.showFoyer,
    showInvite: uiActions.showInvite,
    showSettings: uiActions.showSettings,
    showHowToPlay: uiActions.showHowToPlay,
    selectGhostMailRecipient: uiActions.selectGhostMailRecipient,
    clearGhostMailRecipient: uiActions.clearGhostMailRecipient,
    beginGhostMail: uiActions.beginGhostMail,
    setInviteStatus: uiActions.setInviteStatus,
    reportError: vi.fn()
  }
}))

import {
  COLORS,
  DECODE_VERTICAL_BUDGET,
  REVEAL_VERTICAL_BUDGET,
  formatPerformedAgo,
  localizedAnswers,
  performerPortraitBackground,
  shortWalletAddress,
  uiFontSize,
  uiComponent
} from '../src/client/ui'
import { DEFAULT_CLIENT_SETTINGS, getClientSettings, updateClientSettings } from '../src/client/settings'
import { COPY, LANGUAGES, t, themeLabel } from '../src/shared/i18n'
import { SEASON_ZERO_WEEKS, type SeasonWeek } from '../src/shared/seasons'
import { showPolicyForTimestamp } from '../src/shared/show-policy'

const TEST_NOW = Date.UTC(2026, 7, 23, 12)
const TEST_SHOW_KEY = showPolicyForTimestamp(TEST_NOW)!.showKey

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

function findStaticText(
  node: unknown,
  value: string,
  matches: (props: Record<string, unknown>) => boolean = () => true
): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findStaticText(child, value, matches)
      if (match) return match
    }
    return null
  }
  if (node === null || typeof node !== 'object' || !('type' in node) || !('props' in node)) return null
  const element = node as ElementNode
  if (element.props.value === value && typeof element.props.onMouseDown !== 'function' && matches(element.props)) {
    return element.props
  }
  if (typeof element.type === 'function') return findStaticText(element.type(element.props), value, matches)
  return findStaticText(element.props.children, value, matches)
}

function collectStaticText(node: unknown, values: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectStaticText(child, values))
    return values
  }
  if (node === null || typeof node !== 'object' || !('type' in node) || !('props' in node)) return values

  const element = node as ElementNode
  if (typeof element.props.value === 'string' && typeof element.props.onMouseDown !== 'function') {
    values.push(element.props.value)
  }
  if (typeof element.type === 'function') {
    collectStaticText(element.type(element.props), values)
    return values
  }
  collectStaticText(element.props.children, values)
  return values
}

function stateFor(screen: 'decode' | 'reveal' | 'posted') {
  const charade = {
    id: 'charade-1',
    authorName: 'Author',
    answers: ['One', 'Two', 'Three'],
    isHouse: false,
    setRound: 2,
    setSize: 5,
    setScore: 200,
    setStreak: 1
  }
  return {
    ready: true,
    serverClockOffset: 0,
    showKey: TEST_SHOW_KEY,
    season: null,
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
    spotlightEnabled: false,
    errorCode: '',
    toast: null
  }
}

function foyerState() {
  return {
    ...stateFor('decode'),
    screen: 'foyer',
    theme: 'food',
    themeLabel: 'Kitchen Capers',
    progress: { daily: { stamped: false } },
    playerIsGuest: false,
    boards: { topDecoders: [], hardestGhosts: [], playbill: [], ghostOfNightId: '' }
  }
}

function seasonMetadata(week: SeasonWeek) {
  return {
    id: 'season-zero',
    weekId: week.id,
    startsAt: week.eligibility.startsAt,
    endsAt: week.eligibility.endsAt,
    titleId: week.title.id,
    propId: week.prop.id,
    finale: {
      id: week.finale.id,
      startsAt: week.finale.window.startsAt,
      endsAt: week.finale.window.endsAt
    }
  }
}

function authorState(selectedEmotes: string[]) {
  return {
    ...stateFor('decode'),
    screen: 'author',
    theme: 'food',
    author: {
      phrase: { id: 'phrase', text: 'Walking a dog' },
      offeredEmotes: ['wave', 'clap', 'dab', 'disco', 'shrug'],
      emotePage: 0,
      selectedEmotes,
      shufflesRemaining: 2,
      touringConsent: false,
      phase: selectedEmotes.length === 3 ? 'confirm' : 'emotes'
    }
  }
}

function hintText(node: unknown) {
  return (
    collectStaticText(node).find(
      (value) =>
        findStaticText(node, value, (props) => {
          const transform = props?.uiTransform as Record<string, unknown> | undefined
          return (
            transform?.flex === 1 &&
            props?.fontSize === uiFontSize(18) &&
            props.font === 'monospace' &&
            props.textAlign === 'middle-left'
          )
        }) !== null
    ) ?? null
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW)
  uiTest.region = 'house'
  uiTest.canReply = false
  uiTest.opening = { active: false, instruction: '' }
  uiTest.revealPresentation = {
    verdict: null,
    verdictText: '',
    stats: null,
    complete: false,
    selectedAnswerIndex: -1,
    wrongAnswersFaded: false,
    answerRevealed: true,
    phrase: ''
  }
  uiTest.mailRecipients = []
  uiTest.performerBeat = null
  uiTest.state = stateFor('decode')
  updateClientSettings(DEFAULT_CLIENT_SETTINGS)
})

afterEach(() => {
  vi.restoreAllMocks()
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
        emotePage: 0,
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
  it('renders beat structure as non-interactive chips and highlights the performing beat', () => {
    uiTest.state = authorState(['wave'])
    const authorUi = uiComponent()
    expect(collectButtons(authorUi)).toHaveLength(5)
    expect(findStaticText(authorUi, 'SETUP · WAVE')).not.toBeNull()

    uiTest.state = stateFor('decode')
    uiTest.performerBeat = 1
    expect(findStaticText(uiComponent(), 'ACTION', (props) => props.color === COLORS.ink)).not.toBeNull()
  })

  it('fits decode labels and five 96px controls inside the fixed panel', () => {
    const usedHeight = Object.entries(DECODE_VERTICAL_BUDGET)
      .filter(([key]) => key !== 'panelHeight')
      .reduce((total, [, value]) => total + value, 0)

    expect(usedHeight).toBeLessThanOrEqual(DECODE_VERTICAL_BUDGET.panelHeight)
  })

  it('shows returning authors how many players understood their ghost in every language', () => {
    uiTest.state = {
      ...foyerState(),
      screen: 'since',
      since: { triedYou: 5, gotYou: 3, replies: 1, mail: 2, rank: 0 }
    }

    const expected = {
      en: '3 OF 5 UNDERSTOOD YOUR GHOST. 1 answered back, and 2 Ghost Mail waited.',
      es: '3 DE 5 ENTENDIERON TU FANTASMA. 1 respondieron y esperaban 2 Ghost Mail.',
      pt: '3 DE 5 ENTENDERAM SEU FANTASMA. 1 responderam e havia 2 Ghost Mail.'
    } as const

    for (const language of LANGUAGES) {
      updateClientSettings({ language })
      expect(collectStaticText(uiComponent()), language).toContain(expected[language])
    }
  })

  it('labels the empty Crowd Pleaser board honestly in every language', () => {
    uiTest.state = {
      ...foyerState(),
      screen: 'boards',
      serverClockOffset: 0
    }

    const expected = {
      en: ['CROWD PLEASER', 'NEEDS 3 GUESSES'],
      es: ['FAVORITO DEL PÚBLICO', 'REQUIERE 3 INTENTOS'],
      pt: ['FAVORITO DO PÚBLICO', 'PRECISA DE 3 TENTATIVAS']
    } as const

    for (const language of LANGUAGES) {
      updateClientSettings({ language })
      const text = collectStaticText(uiComponent())
      expect(text, language).toEqual(expect.arrayContaining([...expected[language]]))
    }
  })

  it('renders the exact localized hint for every core state and no hint on other screens', () => {
    const cases = [
      { name: 'foyer far', region: 'outside', state: foyerState(), key: 'hint.foyerFar' },
      { name: 'foyer stage', region: 'stage', state: foyerState(), key: 'hint.foyerStage' },
      { name: 'decode', region: 'stage', state: stateFor('decode'), key: 'hint.decode' },
      { name: 'reveal', region: 'stage', state: stateFor('reveal'), key: 'hint.reveal' },
      { name: 'author choosing', region: 'stage', state: authorState(['wave', 'clap']), key: 'author.chooseThree' },
      {
        name: 'author ready',
        region: 'stage',
        state: authorState(['wave', 'clap', 'dab']),
        key: 'hint.authorReady'
      },
      { name: 'posted', region: 'stage', state: stateFor('posted'), key: 'hint.posted' }
    ] as const

    for (const language of LANGUAGES) {
      updateClientSettings({ language })
      for (const hintCase of cases) {
        uiTest.region = hintCase.region
        uiTest.state = hintCase.state
        expect(hintText(uiComponent()), `${language}:${hintCase.name}`).toBe(COPY[language][hintCase.key])
      }
    }

    updateClientSettings({ language: 'en' })
    for (const screen of ['waking', 'since', 'boards', 'invite', 'mail', 'howToPlay', 'settings'] as const) {
      uiTest.state = {
        ...foyerState(),
        screen,
        since: null,
        serverClockOffset: 0,
        inviteStatus: 'idle',
        mailRecipient: null
      }
      expect(hintText(uiComponent()), screen).toBeNull()
    }
  })

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
    ['confirm', 5]
  ] as const)('keeps author %s phase within five buttons', (phase, expected) => {
    uiTest.state = {
      ...stateFor('decode'),
      screen: 'author',
      author: {
        phrase: { id: 'phrase', text: 'Walking a dog' },
        offeredEmotes: ['wave', 'clap', 'dab', 'disco', 'shrug'],
        emotePage: 0,
        selectedEmotes: phase === 'confirm' ? ['wave', 'clap', 'dab'] : [],
        shufflesRemaining: 2,
        touringConsent: false,
        phase
      }
    }
    const component = uiComponent()
    const buttons = collectButtons(component)
    expect(buttons).toHaveLength(expected)
    if (phase === 'emotes') {
      expect(buttons.map(({ value }) => value)).toEqual(['WAVE', 'CLAP', 'DAB', 'DISCO', 'MORE'])
      for (const { value } of buttons) {
        expect(findButton(component, value)?.uiTransform).toMatchObject({ minHeight: 96, height: 96 })
        expect(findButton(component, value)?.uiTransform).not.toHaveProperty('position.bottom')
        expect(findButton(component, value)?.uiTransform).not.toHaveProperty('position.right')
      }
      ;(findButton(component, 'MORE')?.onMouseDown as (() => void) | undefined)?.()
      expect(uiActions.moreAuthorEmotes).toHaveBeenCalledTimes(1)
    } else if (phase === 'confirm') {
      expect(buttons.map(({ value }) => value)).toEqual([
        'PREVIEW',
        'ALLOW TOUR TO OTHER WORLDS · OFF',
        'POST',
        'CHANGE EMOTES',
        'BACK'
      ])
      for (const { value } of buttons) {
        expect(findButton(component, value)?.uiTransform).toMatchObject({ minHeight: 72, height: 72 })
      }
      ;(findButton(component, 'ALLOW TOUR TO OTHER WORLDS · OFF')?.onMouseDown as (() => void) | undefined)?.()
      expect(uiActions.toggleTouringConsent).toHaveBeenCalledTimes(1)
    }
  })

  it('shows touring consent only for ordinary confirmation, never Ghost Mail or Answer Back', () => {
    const ordinary = authorState(['wave', 'clap', 'dab'])
    uiTest.state = {
      ...ordinary,
      author: { ...(ordinary.author as Record<string, unknown>), touringConsent: true }
    }
    expect(collectButtons(uiComponent()).map(({ value }) => value)).toContain('ALLOW TOUR TO OTHER WORLDS · ON')

    for (const privateDraft of [
      { ...(ordinary.author as Record<string, unknown>), replyTo: 'charade-1', touringConsent: true },
      {
        ...(ordinary.author as Record<string, unknown>),
        recipient: { address: '0xRecipient', name: 'Recipient' },
        touringConsent: true
      }
    ]) {
      uiTest.state = { ...ordinary, author: privateDraft }
      const buttons = collectButtons(uiComponent())
      expect(buttons).toHaveLength(4)
      expect(buttons.some(({ value }) => value.includes('OTHER WORLDS'))).toBe(false)
    }
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
      'HOW TO PLAY'
    ])
  })

  it('keeps reaction controls out of an active decode', () => {
    uiTest.state = { ...stateFor('decode'), roundCharadeId: 'charade-1', pending: [] }
    expect(collectButtons(uiComponent()).map(({ value }) => value)).toEqual([
      'SPOTLIGHT ×2',
      'REPLAY',
      'ONE',
      'TWO',
      'THREE'
    ])
    expect(collectStaticText(uiComponent())).toContain('GHOST 2/5 · STREAK 1 · SCORE 200')
    expect(findButton(uiComponent(), 'MAKE YOUR OWN')).toBeNull()
    expect(findButton(uiComponent(), 'SPOTLIGHT ×2')?.variant).toBe('secondary')
    ;(findButton(uiComponent(), 'SPOTLIGHT ×2')?.onMouseDown as (() => void) | undefined)?.()
    expect(uiActions.toggleSpotlight).toHaveBeenCalledTimes(1)

    uiTest.state = { ...uiTest.state, spotlightEnabled: true }
    expect(findButton(uiComponent(), 'SPOTLIGHT ×2')?.variant).toBe('primary')
  })

  it('does not invent Show Set status for a legacy charade without authoritative fields', () => {
    const legacy = stateFor('decode')
    uiTest.state = {
      ...legacy,
      pending: [],
      charade: {
        id: 'legacy-charade',
        authorName: 'Author',
        answers: ['One', 'Two', 'Three'],
        isHouse: false
      }
    }

    expect(collectStaticText(uiComponent()).some((value) => value.startsWith('GHOST 1/5 · STREAK'))).toBe(false)
  })

  it('disables every Make Your Own control for guests', () => {
    for (const screen of ['foyer', 'decode', 'reveal'] as const) {
      uiTest.state = { ...stateFor(screen), playerIsGuest: true }
      const makeButton = collectButtons(uiComponent()).find(({ value }) => value === 'MAKE YOUR OWN')
      if (makeButton) expect(makeButton.disabled, screen).toBe(true)
    }
  })

  it('keeps authoring reachable when an incorrect round decoder can react', () => {
    uiTest.state = { ...stateFor('reveal'), roundCharadeId: 'charade-1' }
    expect(
      collectButtons(uiComponent())
        .map(({ value }) => value)
        .sort()
    ).toEqual(['MAKE YOUR OWN', 'NEXT GHOST', 'REACT'])

    uiTest.state = { ...uiTest.state, reactionMenuOpen: true }
    expect(collectButtons(uiComponent()).map(({ value }) => value)).toEqual([
      'LAUGH',
      'GASP',
      'APPLAUSE',
      'BACK TO THE SHOW'
    ])
  })

  it('blocks every reveal action until the second-miss phrase is visible', () => {
    uiTest.canReply = true
    uiTest.revealPresentation = {
      verdict: 'miss',
      verdictText: 'THE GHOST GOT YOU',
      stats: null,
      complete: false,
      selectedAnswerIndex: 0,
      wrongAnswersFaded: true,
      answerRevealed: false,
      phrase: 'One'
    }
    uiTest.state = { ...stateFor('reveal'), roundCharadeId: 'charade-1', reactionMenuOpen: true }

    expect(collectButtons(uiComponent())).toEqual([
      { value: 'NEXT GHOST', disabled: true },
      { value: 'MAKE YOUR OWN', disabled: true }
    ])

    uiTest.revealPresentation.answerRevealed = true
    expect(collectButtons(uiComponent()).map(({ value, disabled }) => ({ value, disabled }))).toEqual([
      { value: 'LAUGH', disabled: false },
      { value: 'GASP', disabled: false },
      { value: 'APPLAUSE', disabled: false },
      { value: 'BACK TO THE SHOW', disabled: false }
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

  it('replaces the completed finale with an authoritative two-action set scorecard', () => {
    uiTest.state = {
      ...stateFor('reveal'),
      playerIsGuest: false,
      reveal: {
        charadeId: 'charade-1',
        correct: true,
        phrase: 'One',
        stats: { total: 1, correct: 1 },
        yourScore: 1,
        setRound: 5,
        setSize: 5,
        setScore: 600,
        setStreak: 2,
        setBestStreak: 3,
        setUnderstood: 4,
        setComplete: true,
        isFinale: true
      }
    }
    uiTest.revealPresentation = { ...uiTest.revealPresentation, complete: true }

    const component = uiComponent()
    expect(collectStaticText(component)).toEqual(
      expect.arrayContaining(['SET COMPLETE', 'FINAL SCORE · 600', 'BEST STREAK · 3', 'UNDERSTOOD · 4/5'])
    )
    expect(collectButtons(component)).toEqual([
      { value: 'PLAY ANOTHER SET', disabled: false },
      { value: 'LEAVE A GHOST', disabled: false }
    ])
    for (const value of ['PLAY ANOTHER SET', 'LEAVE A GHOST']) {
      expect(findButton(component, value)?.uiTransform).toMatchObject({ minHeight: 96, height: 96 })
    }
    ;(findButton(component, 'PLAY ANOTHER SET')?.onMouseDown as (() => void) | undefined)?.()
    ;(findButton(component, 'LEAVE A GHOST')?.onMouseDown as (() => void) | undefined)?.()
    expect(uiActions.requestNextCharade).toHaveBeenCalledTimes(1)
    expect(uiActions.beginAuthoring).toHaveBeenCalledTimes(1)

    uiTest.state = {
      ...uiTest.state,
      reveal: { ...(uiTest.state.reveal as Record<string, unknown>), setScore: undefined }
    }
    expect(collectStaticText(uiComponent())).not.toContain('SET COMPLETE')
  })

  it('keeps the foyer at five controls with how to play in the top area', () => {
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
    const howToPlay = findButton(uiComponent(), 'HOW TO PLAY')
    expect(howToPlay?.uiTransform).toMatchObject({ minHeight: 96, position: { top: 24, right: 28 } })
    expect(howToPlay?.uiTransform).not.toHaveProperty('position.bottom')
    ;(howToPlay?.onMouseDown as (() => void) | undefined)?.()
    expect(uiActions.showHowToPlay).toHaveBeenCalledTimes(1)
  })

  it('disables every show-dependent control while the canonical schedule is missing or stale', () => {
    const recipient = {
      address: `0x${'1'.repeat(40)}`,
      name: 'ALICE',
      isGuest: false,
      title: '' as const,
      performedAt: TEST_NOW
    }
    uiTest.region = 'stage'
    uiTest.mailRecipients = [recipient]

    uiTest.state = {
      ...foyerState(),
      showKey: '',
      playerAddress: `0x${'2'.repeat(40)}`
    }
    let component = uiComponent()
    for (const value of ['DECODE A GHOST', 'MAKE YOUR OWN', 'GHOST MAIL']) {
      expect(findButton(component, value), `foyer:${value}`).toMatchObject({ disabled: true })
    }
    uiTest.state = { ...uiTest.state, reactionMenuOpen: true }
    expect(findButton(uiComponent(), 'LAUGH')).toBeNull()

    uiTest.state = { ...stateFor('decode'), showKey: '', pending: [] }
    component = uiComponent()
    for (const value of ['SPOTLIGHT ×2', 'REPLAY', 'ONE', 'TWO', 'THREE']) {
      expect(findButton(component, value), `decode:${value}`).toMatchObject({ disabled: true })
    }

    uiTest.canReply = true
    uiTest.revealPresentation = { ...uiTest.revealPresentation, answerRevealed: true }
    uiTest.state = { ...stateFor('reveal'), showKey: '', playerIsGuest: false, reactionMenuOpen: true }
    component = uiComponent()
    expect(findButton(component, 'LAUGH')).toBeNull()
    expect(findButton(component, 'ANSWER BACK')).toBeNull()
    expect(findButton(component, 'NEXT GHOST')).toMatchObject({ disabled: true })
    expect(findButton(component, 'MAKE YOUR OWN')).toMatchObject({ disabled: true })

    uiTest.revealPresentation = { ...uiTest.revealPresentation, complete: true }
    uiTest.state = {
      ...stateFor('reveal'),
      showKey: '',
      playerIsGuest: false,
      reveal: {
        charadeId: 'charade-1',
        correct: true,
        phrase: 'One',
        stats: { total: 1, correct: 1 },
        yourScore: 1,
        setRound: 5,
        setSize: 5,
        setScore: 600,
        setStreak: 2,
        setBestStreak: 3,
        setUnderstood: 4,
        setComplete: true,
        isFinale: true
      }
    }
    component = uiComponent()
    expect(findButton(component, 'PLAY ANOTHER SET')).toMatchObject({ disabled: true })
    expect(findButton(component, 'LEAVE A GHOST')).toMatchObject({ disabled: true })

    uiTest.revealPresentation = { ...uiTest.revealPresentation, complete: false }
    uiTest.state = { ...stateFor('posted'), showKey: '' }
    expect(findButton(uiComponent(), 'DECODE ANOTHER')).toMatchObject({ disabled: true })

    uiTest.state = {
      ...authorState([]),
      showKey: '',
      author: { ...(authorState([]).author as Record<string, unknown>), phase: 'phrase' }
    }
    component = uiComponent()
    expect(findButton(component, 'CHOOSE EMOTES')).toMatchObject({ disabled: true })
    expect(findButton(component, 'SHUFFLE PHRASE · 2')).toMatchObject({ disabled: true })

    uiTest.state = { ...authorState([]), showKey: '' }
    component = uiComponent()
    for (const value of ['WAVE', 'CLAP', 'DAB', 'DISCO', 'MORE']) {
      expect(findButton(component, value), `author-emotes:${value}`).toMatchObject({ disabled: true })
    }

    uiTest.state = { ...authorState(['wave', 'clap', 'dab']), showKey: '' }
    component = uiComponent()
    for (const value of ['PREVIEW', 'POST', 'CHANGE EMOTES']) {
      expect(findButton(component, value), `author-confirm:${value}`).toMatchObject({ disabled: true })
    }

    uiTest.state = {
      ...stateFor('decode'),
      screen: 'mail',
      showKey: '',
      mailRecipient: { address: recipient.address, name: recipient.name }
    }
    expect(findButton(uiComponent(), 'CONFIRM RECIPIENT')).toMatchObject({ disabled: true })

    const first = SEASON_ZERO_WEEKS[0]
    vi.spyOn(Date, 'now').mockReturnValue(first.eligibility.endsAt)
    uiTest.state = {
      ...foyerState(),
      showKey: `season-zero:${first.id}`,
      season: seasonMetadata(first)
    }
    component = uiComponent()
    expect(findButton(component, 'DECODE A GHOST')).toMatchObject({ disabled: true })
    expect(findButton(component, 'MAKE YOUR OWN')).toMatchObject({ disabled: true })
    const currentPolicy = showPolicyForTimestamp(first.eligibility.endsAt)!
    const staleFoyerText = collectStaticText(component)
    expect(staleFoyerText).not.toContain(t('foyer.show', 'en', { theme: first.name.en.toUpperCase() }))
    expect(staleFoyerText).toContain(
      t('foyer.show', 'en', { theme: themeLabel(currentPolicy.legacyTheme.id, 'en').toUpperCase() })
    )
    uiTest.state = {
      ...stateFor('decode'),
      showKey: `season-zero:${first.id}`,
      season: seasonMetadata(first),
      pending: []
    }
    component = uiComponent()
    for (const value of ['ONE', 'TWO', 'THREE']) {
      expect(findButton(component, value), `stale-decode:${value}`).toMatchObject({ disabled: true })
    }
  })

  it('renders a valid weekly show name locally without presenting planned title, prop, or finale rewards', () => {
    const week = SEASON_ZERO_WEEKS[0]
    vi.spyOn(Date, 'now').mockReturnValue(week.eligibility.startsAt)
    uiTest.state = {
      ...foyerState(),
      showKey: `season-zero:${week.id}`,
      season: seasonMetadata(week),
      themeLabel: 'UNTRUSTED SERVER SHOW'
    }

    for (const language of LANGUAGES) {
      updateClientSettings({ language })
      const text = collectStaticText(uiComponent())
      expect(text, language).toContain(t('foyer.show', language, { theme: week.name[language].toUpperCase() }))
      expect(
        text.some((value) => value.includes('UNTRUSTED SERVER SHOW')),
        language
      ).toBe(false)
      expect(text, `${language}:planned-title`).not.toContain(week.title.label[language])
      expect(text, `${language}:planned-prop`).not.toContain(week.prop.label[language])
      expect(text, `${language}:planned-finale`).not.toContain(week.finale.label[language])
    }
  })

  it('falls back to the localized legacy theme when Season Zero metadata is mismatched', () => {
    const week = SEASON_ZERO_WEEKS[0]
    vi.spyOn(Date, 'now').mockReturnValue(week.eligibility.startsAt)
    const policy = showPolicyForTimestamp(week.eligibility.startsAt)!
    uiTest.state = {
      ...foyerState(),
      showKey: `season-zero:${week.id}`,
      season: { ...seasonMetadata(week), titleId: SEASON_ZERO_WEEKS[1].title.id },
      themeLabel: 'UNTRUSTED SERVER SHOW'
    }

    for (const language of LANGUAGES) {
      updateClientSettings({ language })
      const text = collectStaticText(uiComponent())
      expect(text, language).toContain(
        t('foyer.show', language, { theme: themeLabel(policy.legacyTheme.id, language).toUpperCase() })
      )
      expect(text, language).not.toContain(t('foyer.show', language, { theme: week.name[language].toUpperCase() }))
    }
  })

  it('renders every localized how-to line with two 96px navigation controls', () => {
    uiTest.state = { ...stateFor('decode'), screen: 'howToPlay', theme: 'food' }
    const keys = [
      'howToPlay.walk',
      'howToPlay.watch',
      'howToPlay.guess',
      'howToPlay.leave',
      'howToPlay.realPlayers'
    ] as const

    for (const language of LANGUAGES) {
      updateClientSettings({ language })
      const text = collectStaticText(uiComponent())
      for (const key of keys) expect(text, `${language}:${key}`).toContain(COPY[language][key])
    }

    updateClientSettings({ language: 'en' })
    const buttons = collectButtons(uiComponent())
    expect(buttons).toEqual([
      { value: 'SETTINGS', disabled: false },
      { value: 'BACK', disabled: false }
    ])
    for (const value of ['SETTINGS', 'BACK']) {
      expect(findButton(uiComponent(), value)?.uiTransform).toMatchObject({ minHeight: 96, height: 96 })
    }
    ;(findButton(uiComponent(), 'SETTINGS')?.onMouseDown as (() => void) | undefined)?.()
    ;(findButton(uiComponent(), 'BACK')?.onMouseDown as (() => void) | undefined)?.()
    expect(uiActions.showSettings).toHaveBeenCalledTimes(1)
    expect(uiActions.showFoyer).toHaveBeenCalledTimes(1)
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
    ;(findButton(uiComponent(), 'CÓMO JUGAR')?.onMouseDown as (() => void) | undefined)?.()
    expect(uiActions.showHowToPlay).toHaveBeenCalledTimes(1)
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
    ['reveal', 'house', 'NEXT GHOST'],
    ['reveal', 'stage', 'NEXT GHOST'],
    ['posted', 'house', 'DECODE ANOTHER'],
    ['posted', 'stage', 'DECODE ANOTHER']
  ] as const)('keeps the %s action enabled in the %s region', (screen, region, expectedLabel) => {
    uiTest.region = region
    uiTest.state = stateFor(screen)

    expect(collectButtons(uiComponent())).toContainEqual({ value: expectedLabel, disabled: false })
  })

  it('keeps DECODE A GHOST actionable in the stage area', () => {
    uiTest.region = 'stage'
    uiTest.state = foyerState()

    expect(collectButtons(uiComponent())).toContainEqual({ value: 'DECODE A GHOST', disabled: false })
    expect(findStaticText(uiComponent(), 'WALK TO THE STAGE')).toBeNull()
  })

  it.each([
    ['foyer', foyerState()],
    ['reveal', stateFor('reveal')],
    ['posted', stateFor('posted')]
  ] as const)('uses a static 96px stage instruction instead of a disabled button on %s', (_screen, state) => {
    uiTest.region = 'outside'
    uiTest.state = state

    const component = uiComponent()
    const instruction = findStaticText(component, 'WALK TO THE STAGE')

    expect(findButton(component, 'WALK TO THE STAGE')).toBeNull()
    expect(instruction?.uiTransform).toMatchObject({ minHeight: 96, height: 96 })
    expect(instruction?.uiTransform).not.toHaveProperty('position.bottom')
    expect(collectButtons(component).length).toBeLessThanOrEqual(5)
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

describe('second-chance decode controls', () => {
  it('shows two original-index answers and exactly four 96px controls', () => {
    updateClientSettings({ language: 'en' })
    uiTest.region = 'stage'
    uiTest.state = {
      ...stateFor('decode'),
      spotlightEnabled: true,
      retry: {
        charadeId: 'charade-1',
        removedAnswerIndex: 1,
        replayBeatIndex: 2,
        spotlight: true
      },
      pending: []
    }

    const component = uiComponent()
    const buttons = collectButtons(component)

    expect(buttons).toEqual([
      { value: 'SPOTLIGHT · −100 ON MISS', disabled: true },
      { value: 'REPLAY', disabled: false },
      { value: 'ONE', disabled: false },
      { value: 'THREE', disabled: false }
    ])
    for (const button of buttons) {
      expect(findButton(component, button.value)?.uiTransform).toMatchObject({ minHeight: 96, height: 96 })
    }
    expect(findStaticText(component, 'SECOND CHANCE')).not.toBeNull()
    expect(
      findStaticText(component, 'SECOND CHANCE · Watch the spotlighted beat. Pick one of the two left.')
    ).not.toBeNull()
  })
})
