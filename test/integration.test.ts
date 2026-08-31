import { describe, expect, it, vi } from 'vitest'

const ecsHarness = vi.hoisted(() => ({
  nextEntity: 0,
  activeAvatars: new Map<number, { id: string; expressionTriggerId?: string; expressionTriggerTimestamp?: number }>(),
  systems: new Map<string, (deltaSeconds: number) => void>()
}))

vi.mock('@dcl/sdk/server', () => ({
  Storage: {
    get: async () => null,
    set: async () => true,
    player: {
      get: async () => null,
      set: async () => true
    }
  }
}))

vi.mock('@dcl/sdk/ecs', () => ({
  AvatarBase: {},
  AvatarEquippedData: {},
  PlayerIdentityData: {},
  AvatarShape: {
    createOrReplace: (entity: number, value: { id: string }) => {
      ecsHarness.activeAvatars.set(entity, { ...value })
    },
    deleteFrom: (entity: number) => {
      ecsHarness.activeAvatars.delete(entity)
    },
    getMutable: (entity: number) => ecsHarness.activeAvatars.get(entity)!
  },
  Transform: {
    create: vi.fn(),
    createOrReplace: vi.fn()
  },
  engine: {
    addEntity: () => ++ecsHarness.nextEntity,
    addSystem: (system: (deltaSeconds: number) => void, _priority: unknown, name = '') => {
      ecsHarness.systems.set(name, system)
    },
    getEntitiesWith: () => []
  },
  Schemas: {
    Map: (value: unknown) => value,
    Array: (value: unknown) => value,
    Optional: (value: unknown) => value,
    String: 'string',
    Boolean: 'boolean',
    Number: 'number',
    Int: 'int',
    Int64: 'int64'
  }
}))

vi.mock('@dcl/sdk/math', () => ({
  Quaternion: {
    fromEulerDegrees: vi.fn(() => ({})),
    Identity: vi.fn(() => ({}))
  }
}))

vi.mock('@dcl/sdk/network', () => ({
  registerMessages: () => ({
    send: vi.fn(),
    onMessage: vi.fn(),
    onReady: vi.fn(),
    isReady: () => false
  })
}))

vi.mock('@dcl/sdk/src/players', () => ({
  getPlayer: () => null,
  onEnterScene: vi.fn(),
  onLeaveScene: vi.fn()
}))

vi.mock('../src/client/theater', () => ({
  AUDIENCE_POSITIONS: Array.from({ length: 6 }, () => ({})),
  STAGE_PERFORMER_POSITION: {},
  STAGE_PREVIEW_POSITION: {},
  GHOST_OF_NIGHT_POSITION: { pedestal: true }
}))

import {
  createFlowRuntime,
  type FlowEffects,
  type GhostEmotes,
  type OutboundMessage,
  type ServerMessage
} from '../src/client/flow'
import {
  hasPerformerCompletedSequence,
  setAudience,
  showDuet,
  showGhostOfNight,
  showPerformer,
  showPreview
} from '../src/client/ghosts'
import { OPENING_INSTRUCTION, createOpeningController, type OpeningEffects } from '../src/client/opening'
import { createRevealController, type RevealClock, type RevealEffects, type RevealOutcome } from '../src/client/reveal'
import { EMOTE_STEP_SECONDS, INVITE_URL, MAX_GHOSTS, themeForTimestamp } from '../src/shared/config'
import { DECK, PLAYABLE_DECK, canonicalPerformance } from '../src/shared/deck'
import { SEASON_ZERO_END_AT, SEASON_ZERO_WEEKS } from '../src/shared/seasons'
import { showPolicyForTimestamp } from '../src/shared/show-policy'
import { createServerProtocol, type ProtocolSend } from '../src/server/server'
import { GhostlightState, dayKey } from '../src/server/state'
import {
  PLAYER_STATS_KEY,
  RECENT_VISITORS_KEY,
  charadeKey,
  createStorageRepository,
  indexKey
} from '../src/server/storage'
import { FIXED_NOW, FakeStorage, deferred, makeCharade, makeLook, makeStats } from './test-helpers'

type FlowRuntime = ReturnType<typeof createFlowRuntime>
type ServerProtocol = ReturnType<typeof createServerProtocol>
type ServerEnvelope = { type: string; data: unknown; to?: string[] }
type ServerData<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>['data']
type FakeRoomClient = {
  address: string
  runtime: FlowRuntime
  messages: OutboundMessage[]
  cursor: number
}

class FakeRevealClock implements RevealClock {
  currentTime = 0
  private nextTimer = 0
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  now = () => this.currentTime

  setTimeout(run: () => void, delayMilliseconds: number) {
    const timer = ++this.nextTimer
    this.timers.set(timer, { at: this.currentTime + delayMilliseconds, run })
    return timer
  }

  clearTimeout(timer: number) {
    this.timers.delete(timer)
  }

  advanceTo(milliseconds: number) {
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= milliseconds)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0]
      if (!next) break
      const [timerId, timer] = next
      this.timers.delete(timerId)
      this.currentTime = timer.at
      timer.run()
    }
    this.currentTime = milliseconds
  }
}

class FakeRoom {
  readonly serverMessages: ServerEnvelope[] = []

  private readonly clients = new Map<string, FakeRoomClient>()
  private readonly droppedServerMessageTypes = new Set<string>()
  private protocol: ServerProtocol | null = null

  connectProtocol(protocol: ServerProtocol) {
    this.protocol = protocol
  }

  connectClient(address: string, runtime: FlowRuntime) {
    this.clients.set(address.toLowerCase(), { address, runtime, messages: [], cursor: 0 })
  }

  disconnectClient(address: string) {
    this.clients.delete(address.toLowerCase())
  }

  senderFor(address: string) {
    return (message: OutboundMessage) => {
      this.getClient(address).messages.push(message)
    }
  }

  messagesFrom(address: string) {
    return this.getClient(address).messages
  }

  dropClientMessages(address: string) {
    const client = this.getClient(address)
    client.cursor = client.messages.length
  }

  dropNextServerMessage(type: string) {
    this.droppedServerMessageTypes.add(type)
  }

  readonly sendFromServer: ProtocolSend = async (type, data, to) => {
    this.serverMessages.push({ type, data, to })
    if (this.droppedServerMessageTypes.delete(type)) return
    const recipients = to ? to.map((address) => this.clients.get(address.toLowerCase())) : [...this.clients.values()]
    for (const client of recipients) {
      if (client) this.deliverToClient(client.runtime, type, data)
    }
  }

  async pumpClient(address: string) {
    if (!this.protocol) throw new Error('Fake room protocol is not connected')
    const client = this.getClient(address)
    while (client.cursor < client.messages.length) {
      const message = client.messages[client.cursor++]
      switch (message.type) {
        case 'hello':
          await this.protocol.handleHello(message.data, client.address)
          break
        case 'ping':
          await this.protocol.handlePing(message.data, client.address)
          break
        case 'nextCharade':
          await this.protocol.handleNextCharade(message.data, client.address)
          break
        case 'guess':
          await this.protocol.handleGuess(message.data, client.address)
          break
        case 'roundGuess':
          await this.protocol.handleRoundGuess(message.data, client.address)
          break
        case 'post':
          await this.protocol.handlePost(message.data, client.address)
          break
      }
    }
  }

  private getClient(address: string) {
    const client = this.clients.get(address.toLowerCase())
    if (!client) throw new Error(`Fake room client is not connected: ${address}`)
    return client
  }

  private deliverToClient(runtime: FlowRuntime, type: string, data: unknown) {
    switch (type) {
      case 'ready':
        runtime.receive({ type, data: data as ServerData<'ready'> })
        break
      case 'showSchedule':
        runtime.receive({ type, data: data as ServerData<'showSchedule'> })
        break
      case 'pong':
        runtime.receive({ type, data: data as ServerData<'pong'> })
        break
      case 'progress':
        runtime.receive({ type, data: data as ServerData<'progress'> })
        break
      case 'playerTitle':
        runtime.receive({ type, data: data as ServerData<'playerTitle'> })
        break
      case 'charade':
        runtime.receive({ type, data: data as ServerData<'charade'> })
        break
      case 'charadeReply':
        runtime.receive({ type, data: data as ServerData<'charadeReply'> })
        break
      case 'retry':
        runtime.receive({ type, data: data as ServerData<'retry'> })
        break
      case 'reveal':
        runtime.receive({ type, data: data as ServerData<'reveal'> })
        break
      case 'posted':
        runtime.receive({ type, data: data as ServerData<'posted'> })
        break
      case 'since':
        runtime.receive({ type, data: data as ServerData<'since'> })
        break
      case 'audience':
        runtime.receive({ type, data: data as ServerData<'audience'> })
        break
      case 'boards':
        runtime.receive({ type, data: data as ServerData<'boards'> })
        break
      case 'ghostOfNight':
        runtime.receive({ type, data: data as ServerData<'ghostOfNight'> })
        break
      case 'roundStart':
        runtime.receive({ type, data: data as ServerData<'roundStart'> })
        break
      case 'roundWinner':
        runtime.receive({ type, data: data as ServerData<'roundWinner'> })
        break
      case 'requestError':
        runtime.receive({ type, data: data as ServerData<'requestError'> })
        break
      case 'error':
        runtime.receive({ type, data: data as ServerData<'error'> })
        break
      default:
        throw new Error(`Unexpected server message: ${type}`)
    }
  }
}

function createRevealHarness() {
  const clock = new FakeRevealClock()
  const events: string[] = []
  const record = (event: string) => events.push(`${clock.currentTime}:${event}`)
  const effects: RevealEffects = {
    playSound: (name) => record(`sound:${name}`),
    lockAnswers: () => record('answers:lock'),
    setLights: (mood) => record(`lights:${mood}`),
    duckAudio: () => record('audio:duck'),
    twitchCurtains: () => record('curtains:twitch'),
    freezePerformer: () => record('performer:freeze'),
    setCamera: (camera) => record(`camera:${camera}`),
    releaseCamera: () => record('camera:release'),
    fadeWrongAnswers: () => record('answers:fade-wrong'),
    setSpotlightColor: (color) => record(`spotlight:${color}`),
    showFloatingVerdict: (text) => record(`floating:${text}`),
    showGhostGotYou: (text) => record(`got-you:${text}`),
    showMissVerdictCard: (text) => record(`card:${text}`),
    reactAudience: (reaction) => record(`audience:${reaction}`),
    playPerformerEmote: (emote) => record(`performer:${emote}`),
    showStats: (stats) => record(`stats:${stats.correct}/${stats.total}`),
    animateTitleProgress: (progress, unlockedTitle) => record(`title:${progress}:${unlockedTitle}`),
    resetRevealVisuals: () => record('visuals:reset'),
    restoreAudio: () => record('audio:restore'),
    complete: () => record('complete')
  }
  return { clock, events, controller: createRevealController(effects, clock) }
}

function selectCanonicalAuthorPerformance(runtime: FlowRuntime) {
  const draft = runtime.getState().author
  expect(draft).not.toBeNull()
  const performance = canonicalPerformance(draft!.phrase)
  expect(performance).not.toBeNull()
  for (const emote of performance!) expect(runtime.selectAuthorEmote(emote)).toBe(true)
}

const FIRST_GUESS_DELAY_MILLISECONDS = EMOTE_STEP_SECONDS * 3 * 1_000

function completeGhostSequence() {
  const ghostSystem = ecsHarness.systems.get('ghostlight::ghosts')
  if (!ghostSystem) throw new Error('Ghost system is not initialized')
  ghostSystem(EMOTE_STEP_SECONDS)
  ghostSystem(EMOTE_STEP_SECONDS)
  ghostSystem(EMOTE_STEP_SECONDS)
}

describe('full experience integration', () => {
  it('rehydrates transient house-only startup on a later heartbeat and refreshes persisted progress', async () => {
    const playerAddress = '0xRecoveryPlayer'
    let timestamp = FIXED_NOW
    const storage = new FakeStorage()
    const persisted = makeCharade('recovered-charade')
    storage.putJSON(indexKey(dayKey(FIXED_NOW)), [persisted.id])
    storage.putJSON(charadeKey(persisted.id), persisted)
    storage.putPlayerJSON(
      playerAddress.toLowerCase(),
      PLAYER_STATS_KEY,
      makeStats({ decoded: 7, correct: 5, daily: { day: '2026-08-23', decoded: 7, authored: 0, stamped: false } })
    )
    storage.getErrors.add(charadeKey(persisted.id))
    storage.getValuesErrors.add(charadeKey(persisted.id))
    const repository = createStorageRepository(storage)
    const state = new GhostlightState(repository, () => timestamp)
    await state.hydrate()
    const writesAfterHydration = storage.writes.length

    const room = new FakeRoom()
    let transportReady = false
    const runtime = createFlowRuntime({
      send: room.senderFor(playerAddress),
      now: () => FIXED_NOW,
      createRequestId: () => 'recovery-request',
      getProfile: () => ({ address: playerAddress, name: 'Recovery Player', isGuest: false }),
      getLook: () => makeLook(playerAddress, 'Recovery Player'),
      isTransportReady: () => transportReady
    })
    const protocol = createServerProtocol({
      state,
      send: room.sendFromServer,
      snapshotLook: async (address) => makeLook(address, 'Recovery Player'),
      flush: repository.flushNow,
      now: () => FIXED_NOW,
      instanceId: 'storage-recovery-server',
      lookAttempts: 1,
      lookRetryMilliseconds: 0
    })
    room.connectProtocol(protocol)
    room.connectClient(playerAddress, runtime)
    await protocol.handleEnter(playerAddress)
    transportReady = true
    runtime.tick(0)
    await room.pumpClient(playerAddress)

    expect(state.isReadOnly).toBe(true)
    expect(state.getPool()).toEqual([])
    expect(runtime.getState()).toMatchObject({ ready: false, screen: 'waking', progress: { daily: { decoded: 0 } } })
    expect(storage.writes).toHaveLength(writesAfterHydration)

    storage.getErrors.clear()
    storage.getValuesErrors.clear()
    timestamp += 2_000
    runtime.tick(10)
    await room.pumpClient(playerAddress)

    expect(state.isReadOnly).toBe(false)
    expect(state.getPool()).toEqual([persisted])
    expect(runtime.getState()).toMatchObject({ ready: true, progress: { daily: { decoded: 7 } } })
    const recoveryWrites = storage.writes.slice(writesAfterHydration).map(({ scope, key }) => ({ scope, key }))
    expect(recoveryWrites).toHaveLength(2)
    expect(recoveryWrites).toEqual(
      expect.arrayContaining([
        { scope: 'scene', key: RECENT_VISITORS_KEY },
        { scope: 'player', key: PLAYER_STATS_KEY }
      ])
    )
  })

  it('closes opening through answer-back and invite while preserving cold-start and avatar budgets', async () => {
    const playerAddress = '0xDecoder'
    const replierAddress = '0xReplier'
    let timestamp = FIXED_NOW
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const state = new GhostlightState(repository, () => timestamp)
    await state.hydrate()
    const targetPhrase = PLAYABLE_DECK[0]
    const target = makeCharade('opening-target', {
      author: { address: '0xAuthor', name: 'Maya' },
      phraseId: targetPhrase.id,
      emotes: canonicalPerformance(targetPhrase)!
    })
    state.upsertCharade(target)

    const readyGate = deferred<void>()
    const room = new FakeRoom()
    const reveal = createRevealHarness()
    const openingEvents: string[] = []
    let requestSequence = 0
    let transportReady = false
    let opening!: ReturnType<typeof createOpeningController>
    let stagedPerformer: { look: ReturnType<typeof makeLook>; emotes: GhostEmotes } | null = null
    let performerEntered = false

    const flowEffects: FlowEffects = {
      showPerformer: (look, emotes) => {
        if (opening.isRunning() && !performerEntered) {
          stagedPerformer = { look, emotes }
          return
        }
        showPerformer(look, emotes)
      },
      showDuet,
      showPreview,
      beginReveal: () => reveal.controller.begin(),
      resolveReveal: (result, charade) => {
        const outcome: RevealOutcome = {
          correct: result.correct,
          authorName: charade.authorName,
          phrase: result.phrase,
          stats: result.stats,
          titleProgress: result.nextUnlock.progress,
          unlockedTitle: result.titleUnlocked ? result.title : '',
          stampAwarded: result.stampAwarded,
          ...(result.attempt !== undefined ? { attempt: result.attempt } : {}),
          ...(result.correct && result.attempt === 2 ? { hitText: 'SECOND CHANCE · +50' } : {}),
          ...(!result.correct && result.attempt === 2 ? { gotYouText: 'THE GHOST GOT YOU' } : {})
        }
        reveal.controller.resolve(outcome)
      },
      skipReveal: reveal.controller.skipToEnd,
      cancelReveal: reveal.controller.cancel
    }
    const runtime = createFlowRuntime({
      send: room.senderFor(playerAddress),
      now: () => timestamp,
      createRequestId: () => `integration-${++requestSequence}`,
      getProfile: () => ({ address: playerAddress, name: 'Decoder', isGuest: false }),
      getLook: () => makeLook(playerAddress, 'Decoder'),
      isTransportReady: () => transportReady,
      canGuess: hasPerformerCompletedSequence,
      effects: flowEffects
    })

    const openingEffects: OpeningEffects = {
      switchCamera: (camera) => openingEvents.push(`camera:${camera}`),
      setMarquee: (text) => openingEvents.push(`marquee:${text}`),
      openDoors: () => openingEvents.push('doors:open'),
      enterPerformer: () => {
        performerEntered = true
        openingEvents.push('performer:enter')
        if (stagedPerformer) {
          showPerformer(stagedPerformer.look, stagedPerformer.emotes)
          stagedPerformer = null
        }
      },
      showInstruction: (text) => openingEvents.push(`instruction:${text}`),
      showDecode: () => openingEvents.push('decode')
    }
    opening = createOpeningController(openingEffects)

    let audience = runtime.getState().audience
    runtime.subscribe((nextState) => {
      if (nextState.audience !== audience) {
        audience = nextState.audience
        setAudience(audience)
      }
      if (nextState.ready && nextState.showKey !== '' && nextState.screen === 'foyer' && !opening.hasPlayed()) {
        if (opening.start(nextState.themeLabel)) runtime.requestNextCharade()
      }
    })

    const protocol = createServerProtocol({
      state,
      send: room.sendFromServer,
      snapshotLook: async (address) =>
        makeLook(
          address,
          address.toLowerCase() === playerAddress.toLowerCase()
            ? 'Decoder'
            : address.toLowerCase() === replierAddress.toLowerCase()
              ? 'Replier'
              : 'Maya'
        ),
      ready: readyGate.promise,
      flush: repository.flushNow,
      now: () => timestamp,
      instanceId: 'integration-server',
      lookAttempts: 1,
      lookRetryMilliseconds: 0,
      random: () => 0.5
    })
    room.connectProtocol(protocol)
    room.connectClient(playerAddress, runtime)

    runtime.tick(10)
    expect(runtime.getState()).toMatchObject({ ready: false, transportReady: false, screen: 'waking' })
    expect(room.messagesFrom(playerAddress)).toEqual([])
    expect(room.serverMessages).toEqual([])
    expect(opening.hasPlayed()).toBe(false)

    transportReady = true
    runtime.tick(0)
    expect(room.messagesFrom(playerAddress).map((message) => message.type)).toEqual(['hello', 'ping'])
    room.dropClientMessages(playerAddress)
    for (let heartbeat = 0; heartbeat < 6; heartbeat += 1) {
      runtime.tick(2)
      room.dropClientMessages(playerAddress)
    }
    expect(room.serverMessages).toEqual([])

    readyGate.resolve()
    runtime.tick(2)
    await protocol.handleEnter(playerAddress)
    await room.pumpClient(playerAddress)
    expect(room.messagesFrom(playerAddress).filter((message) => message.type === 'hello')).toHaveLength(9)
    expect(runtime.getState()).toMatchObject({ ready: true, transportReady: true, screen: 'decode' })
    expect(runtime.getState().charade?.id).toBe(target.id)
    expect(opening.isRunning()).toBe(true)

    opening.tick(10)
    const theme = themeForTimestamp(timestamp)
    expect(openingEvents).toEqual([
      'camera:foyer',
      `instruction:${OPENING_INSTRUCTION}`,
      `marquee:TONIGHT'S SHOW: ${theme.label}`,
      'doors:open',
      'camera:stage',
      'decode',
      'performer:enter'
    ])
    expect(opening.isRunning()).toBe(false)

    const served = runtime.getState().charade!
    const phrase = DECK.find((candidate) => candidate.id === target.phraseId)!
    const correctAnswerIndex = served.answers.indexOf(phrase.text)
    expect(correctAnswerIndex).toBeGreaterThanOrEqual(0)
    expect(runtime.guess(correctAnswerIndex)).toBe(false)
    timestamp += FIRST_GUESS_DELAY_MILLISECONDS
    completeGhostSequence()
    expect(runtime.guess(correctAnswerIndex)).toBe(true)
    expect(reveal.controller.getStatus()).toBe('running')
    await room.pumpClient(playerAddress)
    expect(runtime.getState().errorCode).toBe('')
    expect(runtime.getState()).toMatchObject({
      screen: 'reveal',
      reveal: { charadeId: target.id, correct: true, phraseId: target.phraseId }
    })

    reveal.clock.advanceTo(8_000)
    expect(reveal.controller.getStatus()).toBe('complete')
    expect(reveal.events).toContain('2600:floating:YOU GOT IT')
    expect(reveal.events.at(-1)).toBe('8000:complete')

    expect(runtime.beginAuthoring()).toBe(true)
    expect(runtime.getState().screen).toBe('author')
    const authoredDraft = runtime.getState().author!
    expect(authoredDraft.replyTo).toBeUndefined()
    selectCanonicalAuthorPerformance(runtime)
    expect(runtime.previewAuthor()).toBe(true)
    expect(runtime.postAuthor()).toBe(false)
    completeGhostSequence()
    expect(runtime.postAuthor()).toBe(true)
    await room.pumpClient(playerAddress)

    const authoredCharadeId = runtime.getState().postedCharadeId
    expect(runtime.getState()).toMatchObject({
      screen: 'posted',
      postedCharadeId: authoredCharadeId,
      postedReplyTo: ''
    })
    const authoredCharade = state.getCharade(authoredCharadeId)!
    expect(authoredCharade).toMatchObject({
      id: authoredCharadeId,
      author: { address: playerAddress, name: 'Decoder' },
      phraseId: authoredDraft.phrase.id
    })
    expect(target.id).not.toBe(authoredCharadeId)
    expect(state.getCharade(target.id)?.reply).toBeUndefined()
    expect(
      room
        .messagesFrom(playerAddress)
        .filter((message) => message.type === 'nextCharade' || message.type === 'guess' || message.type === 'post')
        .map((message) => message.type)
    ).toEqual(['nextCharade', 'guess', 'post'])

    storage.putPlayerJSON(
      replierAddress.toLowerCase(),
      PLAYER_STATS_KEY,
      makeStats({ name: 'Replier', seen: [target.id] })
    )
    await protocol.handleLeave(playerAddress)
    room.disconnectClient(playerAddress)

    const replierReveal = createRevealHarness()
    let replierRequestSequence = 0
    let replierTransportReady = false
    const replierRuntime = createFlowRuntime({
      send: room.senderFor(replierAddress),
      now: () => timestamp,
      createRequestId: () => `replier-${++replierRequestSequence}`,
      getProfile: () => ({ address: replierAddress, name: 'Replier', isGuest: false }),
      getLook: () => makeLook(replierAddress, 'Replier'),
      isTransportReady: () => replierTransportReady,
      canGuess: hasPerformerCompletedSequence,
      effects: {
        showPerformer,
        showDuet,
        showPreview,
        beginReveal: () => replierReveal.controller.begin(),
        resolveReveal: (result, charade) => {
          replierReveal.controller.resolve({
            correct: result.correct,
            authorName: charade.authorName,
            phrase: result.phrase,
            stats: result.stats,
            titleProgress: result.nextUnlock.progress,
            unlockedTitle: result.titleUnlocked ? result.title : '',
            stampAwarded: result.stampAwarded,
            ...(result.attempt !== undefined ? { attempt: result.attempt } : {}),
            ...(result.correct && result.attempt === 2 ? { hitText: 'SECOND CHANCE · +50' } : {}),
            ...(!result.correct && result.attempt === 2 ? { gotYouText: 'THE GHOST GOT YOU' } : {})
          })
        },
        skipReveal: replierReveal.controller.skipToEnd,
        cancelReveal: replierReveal.controller.cancel
      }
    })
    room.connectClient(replierAddress, replierRuntime)
    await protocol.handleEnter(replierAddress)
    replierTransportReady = true
    replierRuntime.tick(0)
    await room.pumpClient(replierAddress)
    expect(replierRuntime.getState()).toMatchObject({ ready: true, screen: 'foyer' })

    expect(replierRuntime.requestNextCharade()).toBe(true)
    await room.pumpClient(replierAddress)
    expect(replierRuntime.getState()).toMatchObject({ screen: 'decode', charade: { id: authoredCharadeId } })
    const servedAuthoredCharade = replierRuntime.getState().charade!
    const authoredPhrase = DECK.find((candidate) => candidate.id === authoredCharade.phraseId)!
    const authoredAnswerIndex = servedAuthoredCharade.answers.indexOf(authoredPhrase.text)
    expect(authoredAnswerIndex).toBeGreaterThanOrEqual(0)
    expect(replierRuntime.guess(authoredAnswerIndex)).toBe(false)
    timestamp += FIRST_GUESS_DELAY_MILLISECONDS
    completeGhostSequence()
    expect(replierRuntime.guess(authoredAnswerIndex)).toBe(true)
    await room.pumpClient(replierAddress)
    expect(replierRuntime.getState()).toMatchObject({
      screen: 'reveal',
      reveal: { charadeId: authoredCharadeId, correct: true, phraseId: authoredCharade.phraseId }
    })
    replierReveal.clock.advanceTo(8_000)
    expect(replierReveal.controller.getStatus()).toBe('complete')

    expect(replierRuntime.canAnswerBack()).toBe(true)
    expect(replierRuntime.beginAnswerBack()).toBe(true)
    expect(replierRuntime.getState()).toMatchObject({
      screen: 'author',
      author: { phrase: authoredPhrase, replyTo: authoredCharadeId }
    })
    const answerBackDraft = replierRuntime.getState().author!
    selectCanonicalAuthorPerformance(replierRuntime)
    expect(replierRuntime.previewAuthor()).toBe(true)
    expect(replierRuntime.postAuthor()).toBe(false)
    completeGhostSequence()
    expect(replierRuntime.postAuthor()).toBe(true)
    await room.pumpClient(replierAddress)
    expect(replierRuntime.getState()).toMatchObject({
      screen: 'posted',
      postedCharadeId: authoredCharadeId,
      postedReplyTo: authoredCharadeId
    })
    expect(state.getCharade(authoredCharadeId)?.reply).toMatchObject({ address: replierAddress, name: 'Replier' })
    expect(
      room
        .messagesFrom(replierAddress)
        .filter((message) => message.type === 'nextCharade' || message.type === 'guess' || message.type === 'post')
        .map((message) => message.type)
    ).toEqual(['nextCharade', 'guess', 'post'])

    replierRuntime.showInvite()
    replierRuntime.setInviteStatus('copied')
    expect(replierRuntime.getState()).toMatchObject({ screen: 'invite', inviteStatus: 'copied' })
    expect(INVITE_URL).toBe('https://decentraland.org/jump/?realm=ghostlight.dcl.eth')

    await repository.flushNow()
    const restartedRepository = createStorageRepository(storage)
    const restartedState = new GhostlightState(restartedRepository, () => timestamp)
    await restartedState.hydrate()
    const restored = restartedState.getCharade(authoredCharadeId)!
    expect(restored).toMatchObject({ author: { address: playerAddress, name: 'Decoder' } })
    expect(restored.reply).toMatchObject({ address: replierAddress, name: 'Replier' })

    const requestedAudience = Array.from({ length: 6 }, (_, index) => makeLook(`audience-${index}`))
    setAudience(requestedAudience)
    const ghostSystem = ecsHarness.systems.get('ghostlight::ghosts')!
    for (let index = 0; index < requestedAudience.length; index += 1) ghostSystem(1 / 3)
    showDuet(
      { look: restored.author, emotes: restored.emotes },
      { look: restored.reply!.look, emotes: restored.reply!.emotes }
    )
    showGhostOfNight(makeLook('hardest', 'Ghost of the Night'))

    const activeAvatarIds = [...ecsHarness.activeAvatars.values()].map((avatar) => avatar.id).sort()
    expect(requestedAudience).toHaveLength(6)
    expect(ecsHarness.nextEntity).toBe(MAX_GHOSTS)
    expect(ecsHarness.activeAvatars.size).toBe(MAX_GHOSTS - 1)
    expect(activeAvatarIds).toEqual(
      [playerAddress, replierAddress, 'hardest', ...requestedAudience.slice(0, 4).map((look) => look.address)].sort()
    )
  })

  it('acknowledges one persisted ordinary post after its response is dropped and the server restarts', async () => {
    const playerAddress = '0xRestartAuthor'
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const state = new GhostlightState(repository, () => FIXED_NOW)
    await state.hydrate()
    const room = new FakeRoom()
    let transportReady = false
    let requestSequence = 0
    const runtime = createFlowRuntime({
      send: room.senderFor(playerAddress),
      now: () => FIXED_NOW,
      createRequestId: () => `restart-${++requestSequence}`,
      getProfile: () => ({ address: playerAddress, name: 'Restart Author', isGuest: false }),
      getLook: () => makeLook(playerAddress, 'Restart Author'),
      isTransportReady: () => transportReady,
      effects: { showPreview }
    })
    const protocol = createServerProtocol({
      state,
      send: room.sendFromServer,
      snapshotLook: async (address) => makeLook(address, 'Restart Author'),
      flush: repository.flushNow,
      now: () => FIXED_NOW,
      instanceId: 'post-server-1',
      lookAttempts: 1,
      lookRetryMilliseconds: 0,
      random: () => 0.5
    })
    room.connectProtocol(protocol)
    room.connectClient(playerAddress, runtime)
    await protocol.handleEnter(playerAddress)
    transportReady = true
    runtime.tick(0)
    await room.pumpClient(playerAddress)

    expect(runtime.beginAuthoring()).toBe(true)
    selectCanonicalAuthorPerformance(runtime)
    expect(runtime.previewAuthor()).toBe(true)
    expect(runtime.postAuthor()).toBe(false)
    completeGhostSequence()
    room.dropNextServerMessage('posted')
    expect(runtime.postAuthor()).toBe(true)
    const originalPost = room.messagesFrom(playerAddress).findLast((message) => message.type === 'post')!
    await room.pumpClient(playerAddress)

    const droppedPosted = room.serverMessages.findLast((message) => message.type === 'posted')!
    const charadeId = (droppedPosted.data as ServerData<'posted'>).charadeId
    expect(runtime.getState()).toMatchObject({ screen: 'author', pending: [{ kind: 'post' }] })
    expect(state.getCharade(charadeId)).not.toBeNull()
    expect(state.playerStats.get(playerAddress.toLowerCase())).toMatchObject({
      authoredCount: 1,
      daily: { authored: 1 }
    })

    await repository.flushNow()
    const restartedRepository = createStorageRepository(storage)
    const restartedState = new GhostlightState(restartedRepository, () => FIXED_NOW)
    await restartedState.hydrate()
    const restartedProtocol = createServerProtocol({
      state: restartedState,
      send: room.sendFromServer,
      snapshotLook: async (address) => makeLook(address, 'Restart Author'),
      flush: restartedRepository.flushNow,
      now: () => FIXED_NOW,
      instanceId: 'post-server-2',
      lookAttempts: 1,
      lookRetryMilliseconds: 0,
      random: () => 0.5
    })
    room.connectProtocol(restartedProtocol)
    await restartedProtocol.handleEnter(playerAddress)
    await room.pumpClient(playerAddress)

    const posts = room.messagesFrom(playerAddress).filter((message) => message.type === 'post')
    expect(posts).toEqual([originalPost, originalPost])
    expect(runtime.getState()).toMatchObject({ screen: 'posted', postedCharadeId: charadeId, pending: [] })
    expect(restartedState.getCharade(charadeId)).not.toBeNull()
    expect(restartedState.playerStats.get(playerAddress.toLowerCase())).toMatchObject({
      authoredCount: 1,
      daily: { authored: 1 }
    })
  })

  it('runs recovery and stages the ghost victory before revealing a second-miss phrase', async () => {
    const authorAddress = `0x${'a'.repeat(40)}`
    const recoveryAddress = `0x${'1'.repeat(40)}`
    const missAddress = `0x${'2'.repeat(40)}`
    let timestamp = FIXED_NOW
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const state = new GhostlightState(repository, () => timestamp)
    await state.hydrate()
    const targetPhrase = PLAYABLE_DECK[0]
    const target = makeCharade('retry-target', {
      author: { address: authorAddress, name: 'Maya' },
      phraseId: targetPhrase.id,
      emotes: canonicalPerformance(targetPhrase)!
    })
    state.upsertCharade(target)

    const room = new FakeRoom()
    const protocol = createServerProtocol({
      state,
      send: room.sendFromServer,
      snapshotLook: async (address) =>
        makeLook(
          address,
          address.toLowerCase() === recoveryAddress.toLowerCase()
            ? 'Recovery Decoder'
            : address.toLowerCase() === missAddress.toLowerCase()
              ? 'Miss Decoder'
              : 'Maya'
        ),
      flush: repository.flushNow,
      now: () => timestamp,
      instanceId: 'retry-integration-server',
      lookAttempts: 1,
      lookRetryMilliseconds: 0,
      random: () => 0.5
    })
    room.connectProtocol(protocol)

    const connectDecoder = async (address: string, name: string) => {
      const reveal = createRevealHarness()
      const retryBeats: number[] = []
      let transportReady = false
      let requestSequence = 0
      const runtime = createFlowRuntime({
        send: room.senderFor(address),
        now: () => timestamp,
        createRequestId: () => `${name.toLowerCase().replaceAll(' ', '-')}-${++requestSequence}`,
        getProfile: () => ({ address, name, isGuest: false }),
        getLook: () => makeLook(address, name),
        isTransportReady: () => transportReady,
        canGuess: hasPerformerCompletedSequence,
        effects: {
          showPerformer,
          showRetryBeat: (beatIndex) => retryBeats.push(beatIndex),
          beginReveal: (_charade, _answerIndex, options) => reveal.controller.begin(options),
          resolveReveal: (result, charade) => {
            reveal.controller.resolve({
              correct: result.correct,
              authorName: charade.authorName,
              phrase: result.phrase,
              stats: result.stats,
              titleProgress: result.nextUnlock.progress,
              unlockedTitle: result.titleUnlocked ? result.title : '',
              stampAwarded: result.stampAwarded,
              ...(result.attempt !== undefined ? { attempt: result.attempt } : {}),
              ...(result.correct && result.attempt === 2 ? { hitText: 'SECOND CHANCE · +50' } : {}),
              ...(!result.correct && result.attempt === 2 ? { gotYouText: 'THE GHOST GOT YOU' } : {})
            })
          },
          skipReveal: reveal.controller.skipToEnd,
          cancelReveal: reveal.controller.cancel
        }
      })
      room.connectClient(address, runtime)
      await protocol.handleEnter(address)
      transportReady = true
      runtime.tick(0)
      await room.pumpClient(address)
      expect(runtime.getState()).toMatchObject({ ready: true, screen: 'foyer' })
      expect(runtime.requestNextCharade()).toBe(true)
      await room.pumpClient(address)
      expect(runtime.getState()).toMatchObject({ screen: 'decode', charade: { id: target.id } })
      return { runtime, reveal, retryBeats }
    }

    const phrase = DECK.find((candidate) => candidate.id === target.phraseId)!
    const recovery = await connectDecoder(recoveryAddress, 'Recovery Decoder')
    const recoveryCharade = recovery.runtime.getState().charade!
    const recoveryCorrectIndex = recoveryCharade.answers.indexOf(phrase.text)
    const recoveryWrongIndex = recoveryCharade.answers.findIndex((_, index) => index !== recoveryCorrectIndex)
    const recoveryStatsBefore = structuredClone(state.playerStats.get(recoveryAddress.toLowerCase())!)
    const guessesBefore = structuredClone(state.getCharade(target.id)!.guesses)

    expect(recovery.runtime.guess(recoveryWrongIndex)).toBe(false)
    timestamp += FIRST_GUESS_DELAY_MILLISECONDS
    completeGhostSequence()
    expect(recovery.runtime.guess(recoveryWrongIndex)).toBe(true)
    await room.pumpClient(recoveryAddress)
    expect(recovery.runtime.getState()).toMatchObject({
      screen: 'decode',
      retry: { charadeId: target.id, removedAnswerIndex: recoveryWrongIndex },
      reveal: null
    })
    expect(recovery.reveal.controller.getStatus()).toBe('idle')
    expect(recovery.retryBeats).toEqual([recovery.runtime.getState().retry!.replayBeatIndex])
    expect(state.playerStats.get(recoveryAddress.toLowerCase())).toEqual(recoveryStatsBefore)
    expect(state.getCharade(target.id)?.guesses).toEqual(guessesBefore)
    const retryPayload = room.serverMessages.find(
      (message) => message.type === 'retry' && message.to?.[0].toLowerCase() === recoveryAddress.toLowerCase()
    )!.data as Record<string, unknown>
    expect(Object.keys(retryPayload).sort()).toEqual([
      'charadeId',
      'removedAnswerIndex',
      'replayBeatIndex',
      'requestId'
    ])
    expect(JSON.stringify(retryPayload)).not.toContain(phrase.id)
    expect(JSON.stringify(retryPayload)).not.toContain(phrase.text)

    expect(recovery.runtime.guess(recoveryCorrectIndex)).toBe(true)
    await room.pumpClient(recoveryAddress)
    expect(recovery.runtime.getState()).toMatchObject({
      screen: 'reveal',
      retry: null,
      reveal: { charadeId: target.id, correct: true, attempt: 2, scoreDelta: 50, setScore: 50 }
    })
    recovery.reveal.clock.advanceTo(2_600)
    expect(recovery.reveal.events).toContain('2600:floating:SECOND CHANCE · +50')
    expect(state.playerStats.get(recoveryAddress.toLowerCase())).toMatchObject({
      decoded: 1,
      correct: 0,
      seen: [target.id],
      showSet: { round: 1, score: 50, streak: 0, bestStreak: 0, understood: 0 }
    })
    expect(state.getCharade(target.id)?.guesses).toEqual({ total: 1, correct: 0 })
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 0, retryStates: 0 })
    await protocol.handleLeave(recoveryAddress)
    room.disconnectClient(recoveryAddress)

    const miss = await connectDecoder(missAddress, 'Miss Decoder')
    const missCharade = miss.runtime.getState().charade!
    const missCorrectIndex = missCharade.answers.indexOf(phrase.text)
    const missWrongIndexes = missCharade.answers.map((_, index) => index).filter((index) => index !== missCorrectIndex)
    expect(miss.runtime.guess(missWrongIndexes[0])).toBe(false)
    timestamp += FIRST_GUESS_DELAY_MILLISECONDS
    completeGhostSequence()
    expect(miss.runtime.guess(missWrongIndexes[0])).toBe(true)
    await room.pumpClient(missAddress)
    expect(miss.runtime.getState()).toMatchObject({
      screen: 'decode',
      retry: { charadeId: target.id, removedAnswerIndex: missWrongIndexes[0] },
      reveal: null
    })
    expect(miss.runtime.guess(missWrongIndexes[0])).toBe(false)
    expect(miss.runtime.guess(missWrongIndexes[1])).toBe(true)
    await room.pumpClient(missAddress)
    expect(miss.runtime.getState()).toMatchObject({
      screen: 'reveal',
      retry: null,
      reveal: { charadeId: target.id, correct: false, attempt: 2, scoreDelta: 0, setScore: 0 }
    })

    miss.reveal.clock.advanceTo(2_600)
    expect(miss.reveal.events).toContain('2600:sound:laugh')
    expect(miss.reveal.events).toContain('2600:got-you:THE GHOST GOT YOU')
    expect(miss.reveal.events).toContain('2600:audience:laugh')
    expect(miss.reveal.events).toContain('2600:performer:fistpump')
    expect(miss.reveal.events.some((event) => event.includes('card:'))).toBe(false)
    miss.reveal.clock.advanceTo(4_000)
    const gotYouEvent = miss.reveal.events.indexOf('2600:got-you:THE GHOST GOT YOU')
    const phraseRevealEvent = miss.reveal.events.indexOf(`4000:card:MAYA MEANT: ${phrase.text.toUpperCase()}`)
    expect(gotYouEvent).toBeGreaterThanOrEqual(0)
    expect(phraseRevealEvent).toBeGreaterThan(gotYouEvent)
    expect(state.playerStats.get(missAddress.toLowerCase())).toMatchObject({
      decoded: 1,
      correct: 0,
      seen: [target.id],
      showSet: { round: 1, score: 0, streak: 0, bestStreak: 0, understood: 0 }
    })
    expect(state.getCharade(target.id)?.guesses).toEqual({ total: 2, correct: 0 })
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 0, retryStates: 0 })
    await protocol.handleLeave(missAddress)
    room.disconnectClient(missAddress)
    expect(protocol.resourceCounts()).toMatchObject({
      present: 0,
      servedAnswers: 0,
      retryStates: 0,
      activeDecoders: 0,
      completedRequests: 0
    })
  })

  it('crosses Season Zero shows without leaking stale work and hydrates the daily fallback after restart', async () => {
    const playerAddress = `0x${'3'.repeat(40)}`
    const firstTimestamp = SEASON_ZERO_WEEKS[0].eligibility.endsAt - 60_000
    const secondTimestamp = SEASON_ZERO_WEEKS[1].eligibility.startsAt
    let timestamp = firstTimestamp
    const firstPolicy = showPolicyForTimestamp(firstTimestamp)
    const secondPolicy = showPolicyForTimestamp(secondTimestamp)
    if (firstPolicy?.kind !== 'season-zero' || secondPolicy?.kind !== 'season-zero') {
      throw new Error('Expected consecutive Season Zero policies')
    }
    const secondPhraseIds = new Set(secondPolicy.primaryPhraseIds)
    const firstOnlyPhraseIds = firstPolicy.primaryPhraseIds.filter((phraseId) => !secondPhraseIds.has(phraseId))
    expect(firstOnlyPhraseIds.length).toBeGreaterThanOrEqual(2)

    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const state = new GhostlightState(repository, () => timestamp)
    await state.hydrate()
    const externalCharades = firstOnlyPhraseIds.slice(0, 2).map((phraseId, index) =>
      makeCharade(`season-boundary-${index + 1}`, {
        author: { address: `0x${String(index + 4).repeat(40)}`, name: `External ${index + 1}` },
        phraseId,
        emotes: canonicalPerformance(phraseId)!,
        createdAt: firstTimestamp
      })
    )
    for (const charade of externalCharades) state.upsertCharade(charade)

    const room = new FakeRoom()
    let requestSequence = 0
    let transportReady = false
    const runtime = createFlowRuntime({
      send: room.senderFor(playerAddress),
      now: () => timestamp,
      createRequestId: () => `season-lifecycle-${++requestSequence}`,
      getProfile: () => ({ address: playerAddress, name: 'Season Decoder', isGuest: false }),
      getLook: () => makeLook(playerAddress, 'Season Decoder'),
      isTransportReady: () => transportReady,
      canGuess: hasPerformerCompletedSequence,
      effects: { showPerformer, showPreview }
    })
    const protocol = createServerProtocol({
      state,
      send: room.sendFromServer,
      snapshotLook: async (address) => makeLook(address, address === playerAddress ? 'Season Decoder' : address),
      flush: repository.flushNow,
      now: () => timestamp,
      instanceId: 'season-lifecycle-server',
      lookAttempts: 1,
      lookRetryMilliseconds: 0,
      random: () => 0.5
    })
    room.connectProtocol(protocol)
    room.connectClient(playerAddress, runtime)
    await protocol.handleEnter(playerAddress)
    transportReady = true
    runtime.tick(0)
    await room.pumpClient(playerAddress)

    expect(runtime.getState()).toMatchObject({
      ready: true,
      screen: 'foyer',
      showKey: firstPolicy.showKey,
      season: firstPolicy.season
    })
    expect(runtime.beginAuthoring()).toBe(true)
    const seasonDraft = runtime.getState().author!
    expect(firstPolicy.primaryPhraseIds).toContain(seasonDraft.phrase.id)
    selectCanonicalAuthorPerformance(runtime)
    expect(runtime.previewAuthor()).toBe(true)
    expect(runtime.postAuthor()).toBe(false)
    completeGhostSequence()
    expect(runtime.postAuthor()).toBe(true)
    await room.pumpClient(playerAddress)
    expect(runtime.getState()).toMatchObject({ screen: 'posted', postedCharadeId: expect.any(String) })

    expect(runtime.requestNextCharade()).toBe(true)
    await room.pumpClient(playerAddress)
    const firstServed = runtime.getState().charade!
    expect(externalCharades.map((charade) => charade.id)).toContain(firstServed.id)
    const firstSource = externalCharades.find((charade) => charade.id === firstServed.id)!
    const firstCorrectIndex = firstServed.answerIds?.indexOf(firstSource.phraseId) ?? -1
    expect(firstCorrectIndex).toBeGreaterThanOrEqual(0)
    expect(runtime.guess(firstCorrectIndex)).toBe(false)
    timestamp += FIRST_GUESS_DELAY_MILLISECONDS
    completeGhostSequence()
    expect(runtime.guess(firstCorrectIndex)).toBe(true)
    await room.pumpClient(playerAddress)
    expect(state.playerStats.get(playerAddress.toLowerCase())?.showSet).toMatchObject({
      showKey: firstPolicy.showKey,
      round: 1
    })

    expect(runtime.requestNextCharade()).toBe(true)
    await room.pumpClient(playerAddress)
    const secondServed = runtime.getState().charade!
    expect(externalCharades.map((charade) => charade.id)).toContain(secondServed.id)
    expect(secondServed.id).not.toBe(firstServed.id)
    const secondSource = externalCharades.find((charade) => charade.id === secondServed.id)!
    const secondCorrectIndex = secondServed.answerIds?.indexOf(secondSource.phraseId) ?? -1
    const secondWrongIndex = secondServed.answers.findIndex((_, index) => index !== secondCorrectIndex)
    expect(runtime.guess(secondWrongIndex)).toBe(false)
    timestamp += FIRST_GUESS_DELAY_MILLISECONDS
    completeGhostSequence()
    expect(runtime.guess(secondWrongIndex)).toBe(true)
    await room.pumpClient(playerAddress)
    expect(runtime.getState()).toMatchObject({ retry: { charadeId: secondServed.id } })
    expect(runtime.guess(secondCorrectIndex)).toBe(true)
    const staleGuessRequestId = runtime
      .getState()
      .pending.find((request) => request.kind === 'guess' || request.kind === 'roundGuess')!.requestId

    timestamp = secondTimestamp
    await protocol.handlePing({ seq: 500 }, playerAddress)

    expect(runtime.getState()).toMatchObject({
      screen: 'foyer',
      showKey: secondPolicy.showKey,
      season: secondPolicy.season,
      charade: null,
      retry: null,
      reveal: null,
      author: null,
      pending: [],
      roundId: '',
      roundCharadeId: ''
    })
    expect(protocol.resourceCounts()).toMatchObject({
      servedAnswers: 0,
      retryStates: 0,
      activeDecoders: 0,
      nextRequests: 0
    })
    expect(runtime.requestNextCharade()).toBe(true)
    const newWeekRequestId = runtime.getState().pending.find((request) => request.kind === 'nextCharade')!.requestId
    await room.pumpClient(playerAddress)

    expect(
      room.serverMessages.find(
        (message) =>
          message.type === 'requestError' && (message.data as { requestId: string }).requestId === staleGuessRequestId
      )?.data
    ).toEqual({ code: 'charade-not-served', requestId: staleGuessRequestId })
    expect(
      room.serverMessages.find(
        (message) =>
          message.type === 'charade' && (message.data as { requestId: string }).requestId === newWeekRequestId
      )
    ).toBeDefined()
    expect(runtime.getState()).toMatchObject({
      screen: 'decode',
      showKey: secondPolicy.showKey,
      pending: [],
      errorCode: ''
    })
    expect(externalCharades.map((charade) => charade.id)).not.toContain(runtime.getState().charade?.id)
    expect(state.getCharade(secondServed.id)?.guesses).toEqual({ total: 0, correct: 0 })
    expect(state.playerStats.get(playerAddress.toLowerCase())?.showSet).toEqual({
      showKey: secondPolicy.showKey,
      round: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      understood: 0
    })

    await repository.flushNow()
    expect(
      storage.readPlayerJSON<ReturnType<typeof makeStats>>(playerAddress.toLowerCase(), PLAYER_STATS_KEY)?.showSet
    ).toEqual({
      showKey: secondPolicy.showKey,
      round: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      understood: 0
    })

    await protocol.handleLeave(playerAddress)
    const restartedRepository = createStorageRepository(storage)
    const restartedState = new GhostlightState(restartedRepository, () => timestamp)
    await restartedState.hydrate()
    const restartedProtocol = createServerProtocol({
      state: restartedState,
      send: room.sendFromServer,
      snapshotLook: async (address) => makeLook(address, 'Season Decoder'),
      flush: restartedRepository.flushNow,
      now: () => timestamp,
      instanceId: 'season-lifecycle-restarted',
      lookAttempts: 1,
      lookRetryMilliseconds: 0,
      random: () => 0.5
    })
    room.connectProtocol(restartedProtocol)
    await restartedProtocol.handleEnter(playerAddress)
    expect(runtime.getState()).toMatchObject({
      ready: true,
      screen: 'foyer',
      showKey: '',
      season: null,
      pending: []
    })
    runtime.receive({ type: 'error', data: { code: 'protocol-required' } })
    await room.pumpClient(playerAddress)
    expect(runtime.getState()).toMatchObject({
      ready: true,
      instanceId: 'season-lifecycle-restarted',
      screen: 'foyer',
      showKey: secondPolicy.showKey,
      season: secondPolicy.season
    })
    expect(restartedState.playerStats.get(playerAddress.toLowerCase())?.showSet).toEqual({
      showKey: secondPolicy.showKey,
      round: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      understood: 0
    })

    timestamp = SEASON_ZERO_END_AT
    await restartedProtocol.handlePing({ seq: 501 }, playerAddress)
    const dailyShowKey = `daily:${new Date(timestamp).toISOString().slice(0, 10)}`
    expect(runtime.getState()).toMatchObject({ screen: 'foyer', showKey: dailyShowKey, season: null })
    const dailySchedule = room.serverMessages.findLast(
      (message) => message.type === 'showSchedule' && (message.data as { serverTime: number }).serverTime === timestamp
    )!.data as Record<string, unknown>
    expect(dailySchedule).toMatchObject({
      instanceId: 'season-lifecycle-restarted',
      serverTime: timestamp,
      showKey: dailyShowKey
    })
    expect(dailySchedule).not.toHaveProperty('season')

    expect(runtime.beginAuthoring()).toBe(true)
    const dailyDraft = runtime.getState().author!
    selectCanonicalAuthorPerformance(runtime)
    expect(runtime.previewAuthor()).toBe(true)
    expect(runtime.postAuthor()).toBe(false)
    completeGhostSequence()
    expect(runtime.postAuthor()).toBe(true)
    await room.pumpClient(playerAddress)
    expect(runtime.getState()).toMatchObject({ screen: 'posted', postedCharadeId: expect.any(String) })
    expect(restartedState.getCharade(runtime.getState().postedCharadeId)?.phraseId).toBe(dailyDraft.phrase.id)
  })
})
