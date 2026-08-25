import { describe, expect, it, vi } from 'vitest'

const ecsHarness = vi.hoisted(() => ({
  nextEntity: 0,
  activeAvatars: new Map<
    number,
    { id: string; expressionTriggerId?: string; expressionTriggerTimestamp?: number }
  >(),
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
  setAudience,
  showDuet,
  showGhostOfNight,
  showPerformer,
  showPreview
} from '../src/client/ghosts'
import { createOpeningController, type OpeningEffects } from '../src/client/opening'
import {
  createRevealController,
  type RevealClock,
  type RevealEffects,
  type RevealOutcome
} from '../src/client/reveal'
import { INVITE_URL, MAX_GHOSTS, themeForTimestamp } from '../src/shared/config'
import { DECK } from '../src/shared/deck'
import { createServerProtocol, type ProtocolSend } from '../src/server/server'
import { GhostlightState } from '../src/server/state'
import { PLAYER_STATS_KEY, createStorageRepository } from '../src/server/storage'
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

  readonly sendFromServer: ProtocolSend = async (type, data, to) => {
    this.serverMessages.push({ type, data, to })
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

describe('full experience integration', () => {
  it('closes opening through answer-back and invite while preserving cold-start and avatar budgets', async () => {
    const playerAddress = '0xDecoder'
    const replierAddress = '0xReplier'
    const storage = new FakeStorage()
    const repository = createStorageRepository(storage)
    const state = new GhostlightState(repository, () => FIXED_NOW)
    await state.hydrate()
    const target = makeCharade('opening-target', {
      author: { address: '0xAuthor', name: 'Maya' },
      phraseId: DECK[0].id
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
          stampAwarded: result.stampAwarded
        }
        reveal.controller.resolve(outcome)
      },
      skipReveal: reveal.controller.skipToEnd,
      cancelReveal: reveal.controller.cancel
    }
    const runtime = createFlowRuntime({
      send: room.senderFor(playerAddress),
      now: () => FIXED_NOW,
      createRequestId: () => `integration-${++requestSequence}`,
      getProfile: () => ({ address: playerAddress, name: 'Decoder', isGuest: false }),
      getLook: () => makeLook(playerAddress, 'Decoder'),
      isTransportReady: () => transportReady,
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
      if (nextState.ready && nextState.screen === 'foyer' && !opening.hasPlayed()) {
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
      now: () => FIXED_NOW,
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
    const theme = themeForTimestamp(FIXED_NOW)
    expect(openingEvents).toEqual([
      'camera:foyer',
      `marquee:TONIGHT'S SHOW: ${theme.label}`,
      'doors:open',
      'camera:stage',
      'performer:enter',
      "instruction:Guess what they're saying",
      'decode'
    ])
    expect(opening.isRunning()).toBe(false)

    const served = runtime.getState().charade!
    const phrase = DECK.find((candidate) => candidate.id === target.phraseId)!
    const correctAnswerIndex = served.answers.indexOf(phrase.text)
    expect(correctAnswerIndex).toBeGreaterThanOrEqual(0)
    expect(runtime.guess(correctAnswerIndex)).toBe(true)
    expect(reveal.controller.getStatus()).toBe('running')
    await room.pumpClient(playerAddress)
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
    for (const emote of authoredDraft.offeredEmotes.slice(0, 3)) {
      expect(runtime.selectAuthorEmote(emote)).toBe(true)
    }
    expect(runtime.previewAuthor()).toBe(true)
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
      now: () => FIXED_NOW,
      createRequestId: () => `replier-${++replierRequestSequence}`,
      getProfile: () => ({ address: replierAddress, name: 'Replier', isGuest: false }),
      getLook: () => makeLook(replierAddress, 'Replier'),
      isTransportReady: () => replierTransportReady,
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
            stampAwarded: result.stampAwarded
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
    for (const emote of answerBackDraft.offeredEmotes.slice(0, 3)) {
      expect(replierRuntime.selectAuthorEmote(emote)).toBe(true)
    }
    expect(replierRuntime.previewAuthor()).toBe(true)
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
    const restartedState = new GhostlightState(restartedRepository, () => FIXED_NOW)
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
})
