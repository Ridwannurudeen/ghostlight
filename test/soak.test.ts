import { describe, expect, it, vi } from 'vitest'

vi.mock('@dcl/sdk/server', () => ({
  Storage: {
    get: async () => null,
    getValues: async () => ({ data: [], pagination: { offset: 0, total: 0 } }),
    set: async () => true,
    player: {
      get: async () => null,
      getValues: async () => ({ data: [], pagination: { offset: 0, total: 0 } }),
      set: async () => true
    }
  }
}))

vi.mock('@dcl/sdk/ecs', () => ({
  AvatarBase: {},
  AvatarEquippedData: {},
  PlayerIdentityData: {},
  engine: { getEntitiesWith: () => [] },
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

import {
  createFlowRuntime,
  type ClientFlowState,
  type FlowEffects,
  type OutboundMessage,
  type ServerMessage
} from '../src/client/flow'
import { HYDRATION_DAYS, MAX_GHOSTS, themeForTimestamp } from '../src/shared/config'
import { DECK } from '../src/shared/deck'
import type { Look } from '../src/shared/types'
import { createServerProtocol, type ProtocolSend } from '../src/server/server'
import { GhostlightState, computeTitle, dayKey } from '../src/server/state'
import { createStorageRepository } from '../src/server/storage'
import { FakeStorage, makeLook } from './test-helpers'

type FlowRuntime = ReturnType<typeof createFlowRuntime>
type ServerProtocol = ReturnType<typeof createServerProtocol>
type ServerData<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>['data']

type SimulatedPlayer = {
  address: string
  name: string
  runtime: FlowRuntime
  connected: boolean
  transportReady: boolean
  outbound: OutboundMessage[]
  cursor: number
}

type PayloadMeasurement = {
  direction: 'client' | 'server'
  type: string
  bytes: number
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const PLAYER_COUNT = 6

function payloadBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function playerAddress(index: number) {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`
}

class AvatarSlotBudget {
  private readonly slots = new Set<string>()
  peak = 0

  showPerformer() {
    this.activate('performer')
    this.slots.delete('reply')
  }

  showDuet() {
    this.activate('performer')
    this.activate('reply')
  }

  showAudience(looks: readonly Look[]) {
    for (let index = 0; index < 6; index += 1) {
      const slot = `audience-${index}`
      if (index < looks.length) this.activate(slot)
      else this.slots.delete(slot)
    }
  }

  showGhostOfNight(visible: boolean) {
    if (visible) this.activate('audience-5')
  }

  private activate(slot: string) {
    this.slots.add(slot)
    this.peak = Math.max(this.peak, this.slots.size)
  }
}

class SoakRoom {
  readonly measurements: PayloadMeasurement[] = []
  readonly serverMessages: Array<{ type: string; data: unknown; to?: string[] }> = []

  private readonly players = new Map<string, SimulatedPlayer>()
  private protocol: ServerProtocol | null = null

  connectProtocol(protocol: ServerProtocol) {
    this.protocol = protocol
  }

  addPlayer(player: SimulatedPlayer) {
    this.players.set(player.address.toLowerCase(), player)
  }

  senderFor(address: string) {
    return (message: OutboundMessage) => {
      const player = this.getPlayer(address)
      player.outbound.push(message)
      this.measurements.push({ direction: 'client', type: message.type, bytes: payloadBytes(message.data) })
    }
  }

  readonly sendFromServer: ProtocolSend = async (type, data, to) => {
    this.serverMessages.push({ type, data, to })
    this.measurements.push({ direction: 'server', type, bytes: payloadBytes(data) })
    const recipients = to ? to.map((address) => this.players.get(address.toLowerCase())) : [...this.players.values()]
    for (const recipient of recipients) {
      if (recipient?.connected) this.deliver(recipient.runtime, type, data)
    }
  }

  async pump(address: string) {
    if (!this.protocol) throw new Error('Soak room has no server protocol')
    const player = this.getPlayer(address)
    while (player.cursor < player.outbound.length) {
      const message = player.outbound[player.cursor++]
      switch (message.type) {
        case 'hello':
          await this.protocol.handleHello(message.data, player.address)
          break
        case 'ping':
          await this.protocol.handlePing(message.data, player.address)
          break
        case 'nextCharade':
          await this.protocol.handleNextCharade(message.data, player.address)
          break
        case 'guess':
          await this.protocol.handleGuess(message.data, player.address)
          break
        case 'roundGuess':
          await this.protocol.handleRoundGuess(message.data, player.address)
          break
        case 'post':
          await this.protocol.handlePost(message.data, player.address)
          break
      }
    }
  }

  private getPlayer(address: string) {
    const player = this.players.get(address.toLowerCase())
    if (!player) throw new Error(`Unknown simulated player: ${address}`)
    return player
  }

  private deliver(runtime: FlowRuntime, type: string, data: unknown) {
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
        throw new Error(`Unexpected soak server message: ${type}`)
    }
  }
}

function assertStateInvariants(state: GhostlightState, timestamp: number) {
  const playerCharades = state.getPlayerCharades()
  const pool = state.getPool()
  expect(playerCharades.every((charade) => !charade.isHouse)).toBe(true)
  expect(new Set(playerCharades.map((charade) => charade.id)).size).toBe(playerCharades.length)
  expect(pool.every((charade) => !charade.isHouse)).toBe(true)
  expect(pool.every((charade) => charade.recipient === undefined)).toBe(true)
  expect(pool.every((charade) => playerCharades.some((candidate) => candidate.id === charade.id))).toBe(true)
  expect(new Set(pool.map((charade) => charade.id)).size).toBe(pool.length)
  expect(pool).toEqual(
    [...pool].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  )

  expect(state.boards.decoders.length).toBeLessThanOrEqual(10)
  expect(state.boards.hardest.length).toBeLessThanOrEqual(10)
  for (const decoder of state.boards.decoders) {
    expect(decoder.correct).toBeLessThanOrEqual(decoder.total)
  }
  for (const hardest of state.boards.hardest) {
    const charade = state.getCharade(hardest.charadeId)
    expect(charade).not.toBeNull()
    expect(charade?.isHouse).toBe(false)
    expect(dayKey(charade!.createdAt)).toBe(dayKey(timestamp))
    expect(hardest).toMatchObject({ total: charade!.guesses.total, correct: charade!.guesses.correct })
  }

  for (const stats of state.playerStats.values()) {
    const daily = state.getDaily(stats)
    expect(daily.day).toBe(dayKey(timestamp))
    expect(stats.correct).toBeLessThanOrEqual(stats.decoded)
    expect(stats.title).toBe(
      computeTitle({ correct: stats.correct, authored: stats.authoredCount, stamps: stats.stampedDays.length })
    )
    expect(stats.seen.every((id) => state.getCharade(id)?.isHouse !== true)).toBe(true)
    expect(stats.authored.every((id) => state.getCharade(id)?.isHouse !== true)).toBe(true)
  }
}

function assertClientBoards(state: ClientFlowState, serverState: GhostlightState) {
  expect(state.boards.topDecoders.length).toBeLessThanOrEqual(10)
  expect(state.boards.hardestGhosts.length).toBeLessThanOrEqual(10)
  for (const row of state.boards.topDecoders) expect(row.correct).toBeLessThanOrEqual(row.total)
  for (const row of state.boards.hardestGhosts) {
    const charade = serverState.getCharade(row.charadeId)
    expect(charade?.isHouse).toBe(false)
    expect(row).toMatchObject({ total: charade?.guesses.total, correct: charade?.guesses.correct })
  }
  for (const performer of state.boards.playbill) {
    expect(
      serverState.getPool().some((charade) => charade.author.address.toLowerCase() === performer.address.toLowerCase())
    ).toBe(true)
  }
}

function selectDraftEmotes(player: SimulatedPlayer) {
  const draft = player.runtime.getState().author
  expect(draft).not.toBeNull()
  for (const emote of draft!.offeredEmotes.slice(0, 3)) {
    expect(player.runtime.selectAuthorEmote(emote)).toBe(true)
  }
}

describe('deterministic headless soak simulation', () => {
  it('keeps protocol, reducers, persistence, ageing, payloads, and avatar slots bounded', async () => {
    let now = Date.UTC(2026, 7, 23, 12)
    const storage = new FakeStorage()
    let repository = createStorageRepository(storage)
    let state = new GhostlightState(repository, () => now)
    await state.hydrate()

    const room = new SoakRoom()
    const avatarBudget = new AvatarSlotBudget()
    const players: SimulatedPlayer[] = []

    for (let index = 0; index < PLAYER_COUNT; index += 1) {
      const address = playerAddress(index)
      const name = `Player ${index + 1}`
      let requestSequence = 0
      const player = {
        address,
        name,
        connected: false,
        transportReady: false,
        outbound: [],
        cursor: 0
      } as SimulatedPlayer
      const effects: FlowEffects = {
        showPerformer: () => avatarBudget.showPerformer(),
        showDuet: () => avatarBudget.showDuet(),
        showGhostOfNight: (ghost) => avatarBudget.showGhostOfNight(ghost !== null)
      }
      player.runtime = createFlowRuntime({
        send: room.senderFor(address),
        now: () => now,
        createRequestId: () => `soak-${index + 1}-${++requestSequence}`,
        getProfile: () => ({ address, name, isGuest: false }),
        getLook: () => makeLook(address, name),
        isTransportReady: () => player.transportReady,
        effects
      })
      player.runtime.subscribe((nextState) => avatarBudget.showAudience(nextState.audience))
      players.push(player)
      room.addPlayer(player)
    }

    const bootServer = async (instanceId: string) => {
      repository = createStorageRepository(storage)
      state = new GhostlightState(repository, () => now)
      await state.hydrate()
      const protocol = createServerProtocol({
        state,
        send: room.sendFromServer,
        snapshotLook: async (address) => {
          const player = players.find((candidate) => candidate.address.toLowerCase() === address.toLowerCase())
          return player ? makeLook(player.address, player.name) : null
        },
        flush: repository.flushNow,
        now: () => now,
        instanceId,
        lookAttempts: 1,
        lookRetryMilliseconds: 0,
        random: () => 0.5
      })
      room.connectProtocol(protocol)
      return protocol
    }

    let protocol = await bootServer('soak-server-a')

    const connect = async (player: SimulatedPlayer) => {
      player.connected = true
      await protocol.handleEnter(player.address)
      player.transportReady = true
      player.runtime.tick(2)
      await room.pump(player.address)
      expect(player.runtime.getState()).toMatchObject({ ready: true, transportReady: true })
    }

    const disconnect = async (player: SimulatedPlayer) => {
      await protocol.handleLeave(player.address)
      player.transportReady = false
      player.runtime.tick(0)
      player.connected = false
      expect(player.runtime.getState()).toMatchObject({ ready: false, transportReady: false, screen: 'waking' })
    }

    const authoredIds: string[] = []
    for (const author of players.slice(0, 3)) {
      await connect(author)
      expect(author.runtime.beginAuthoring()).toBe(true)
      selectDraftEmotes(author)
      expect(author.runtime.previewAuthor()).toBe(true)
      expect(author.runtime.postAuthor()).toBe(true)
      await room.pump(author.address)
      const charadeId = author.runtime.getState().postedCharadeId
      expect(state.getCharade(charadeId)).toMatchObject({ author: { address: author.address }, isHouse: false })
      authoredIds.push(charadeId)
      await disconnect(author)
      now += 1_000
    }

    const decoder = players[3]
    await connect(decoder)
    expect(decoder.runtime.requestNextCharade()).toBe(true)
    await room.pump(decoder.address)
    const firstServed = decoder.runtime.getState().charade!
    expect(authoredIds).toContain(firstServed.id)
    const firstPhrase = DECK.find((phrase) => phrase.id === state.getCharade(firstServed.id)?.phraseId)!
    expect(decoder.runtime.guess(firstServed.answers.indexOf(firstPhrase.text))).toBe(true)
    await room.pump(decoder.address)
    expect(decoder.runtime.getState()).toMatchObject({
      screen: 'reveal',
      reveal: { charadeId: firstServed.id, correct: true }
    })

    expect(decoder.runtime.canAnswerBack()).toBe(true)
    expect(decoder.runtime.beginAnswerBack()).toBe(true)
    selectDraftEmotes(decoder)
    expect(decoder.runtime.previewAuthor()).toBe(true)
    expect(decoder.runtime.postAuthor()).toBe(true)
    await room.pump(decoder.address)
    expect(state.getCharade(firstServed.id)?.reply).toMatchObject({ address: decoder.address })
    await disconnect(decoder)

    const repliedAuthor = players.find(
      (player) => player.address.toLowerCase() === state.getCharade(firstServed.id)?.author.address.toLowerCase()
    )!
    await connect(repliedAuthor)
    expect(repliedAuthor.runtime.getState().since?.replies).toBe(1)
    await disconnect(repliedAuthor)

    const secondDecoder = players[4]
    await connect(secondDecoder)
    expect(secondDecoder.runtime.requestNextCharade()).toBe(true)
    await room.pump(secondDecoder.address)
    const secondServed = secondDecoder.runtime.getState().charade!
    const secondPhrase = DECK.find((phrase) => phrase.id === state.getCharade(secondServed.id)?.phraseId)!
    const secondCorrectIndex = secondServed.answers.indexOf(secondPhrase.text)
    const secondWrongIndexes = secondServed.answers
      .map((_, index) => index)
      .filter((index) => index !== secondCorrectIndex)
    const secondStatsBefore = structuredClone(state.playerStats.get(secondDecoder.address.toLowerCase())!)
    const secondCharadeGuessesBefore = structuredClone(state.getCharade(secondServed.id)!.guesses)
    expect(secondDecoder.runtime.guess(secondWrongIndexes[0])).toBe(true)
    await room.pump(secondDecoder.address)
    expect(secondDecoder.runtime.getState()).toMatchObject({
      screen: 'decode',
      retry: { charadeId: secondServed.id, removedAnswerIndex: secondWrongIndexes[0] },
      reveal: null
    })
    expect(state.playerStats.get(secondDecoder.address.toLowerCase())).toEqual(secondStatsBefore)
    expect(state.getCharade(secondServed.id)?.guesses).toEqual(secondCharadeGuessesBefore)
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 1, retryStates: 1 })

    expect(secondDecoder.runtime.guess(secondWrongIndexes[0])).toBe(false)
    expect(secondDecoder.runtime.guess(secondWrongIndexes[1])).toBe(true)
    await room.pump(secondDecoder.address)
    expect(secondDecoder.runtime.getState()).toMatchObject({
      screen: 'reveal',
      retry: null,
      reveal: { charadeId: secondServed.id, correct: false, attempt: 2 }
    })
    expect(protocol.resourceCounts()).toMatchObject({ servedAnswers: 0, retryStates: 0 })
    await disconnect(secondDecoder)

    now += 60_001
    const mailSender = players[0]
    const mailRecipient = players[1]
    await connect(mailSender)
    expect(mailSender.runtime.selectGhostMailRecipient(mailRecipient.address)).toBe(true)
    expect(mailSender.runtime.beginGhostMail()).toBe(true)
    selectDraftEmotes(mailSender)
    expect(mailSender.runtime.previewAuthor()).toBe(true)
    expect(mailSender.runtime.postAuthor()).toBe(true)
    await room.pump(mailSender.address)
    expect(mailSender.runtime.getState().postedRecipient).toBe(mailRecipient.address)
    const mailedCharade = state
      .getPlayerCharades()
      .find((charade) => charade.recipient?.toLowerCase() === mailRecipient.address.toLowerCase())
    expect(mailedCharade).toMatchObject({ author: { address: mailSender.address }, recipient: mailRecipient.address })
    expect(state.getPool().some((charade) => charade.id === mailedCharade!.id)).toBe(false)
    await disconnect(mailSender)

    await repository.flushNow()
    protocol = await bootServer('soak-server-mail-wake')
    expect(state.getMailForRecipient(mailRecipient.address, [])).toMatchObject({
      id: mailedCharade!.id,
      recipient: mailRecipient.address
    })

    const nonRecipient = players[5]
    await connect(nonRecipient)
    expect(nonRecipient.runtime.requestNextCharade()).toBe(true)
    await room.pump(nonRecipient.address)
    expect(nonRecipient.runtime.getState().charade?.id).not.toBe(mailedCharade!.id)
    await disconnect(nonRecipient)

    await connect(mailRecipient)
    expect(mailRecipient.runtime.getState().since?.mail).toBe(1)
    if (mailRecipient.runtime.getState().screen === 'since') mailRecipient.runtime.dismissSince()
    expect(mailRecipient.runtime.requestNextCharade()).toBe(true)
    await room.pump(mailRecipient.address)
    const deliveredMail = mailRecipient.runtime.getState().charade!
    expect(deliveredMail.id).toBe(mailedCharade!.id)
    expect(deliveredMail.recipient).toBe(mailRecipient.address)
    const deliveredPhrase = DECK.find((phrase) => phrase.id === mailedCharade!.phraseId)!
    expect(mailRecipient.runtime.guess(deliveredMail.answers.indexOf(deliveredPhrase.text))).toBe(true)
    await room.pump(mailRecipient.address)
    expect(mailRecipient.runtime.getState().reveal?.correct).toBe(true)
    expect(mailRecipient.runtime.canAnswerBack()).toBe(true)
    expect(mailRecipient.runtime.beginAnswerBack()).toBe(true)
    selectDraftEmotes(mailRecipient)
    expect(mailRecipient.runtime.previewAuthor()).toBe(true)
    expect(mailRecipient.runtime.postAuthor()).toBe(true)
    await room.pump(mailRecipient.address)
    expect(state.getCharade(mailedCharade!.id)?.reply).toMatchObject({ address: mailRecipient.address })
    await disconnect(mailRecipient)

    await connect(mailSender)
    expect(mailSender.runtime.getState().since?.replies).toBeGreaterThanOrEqual(1)
    await disconnect(mailSender)

    assertStateInvariants(state, now)
    await repository.flushNow()
    const persistedPool = state.getPool().map((charade) => charade.id)
    const persistedPlayerCharades = state.getPlayerCharades().map((charade) => charade.id)

    protocol = await bootServer('soak-server-b')
    expect(state.getPool().map((charade) => charade.id)).toEqual(persistedPool)
    expect(state.getPlayerCharades().map((charade) => charade.id)).toEqual(persistedPlayerCharades)
    expect(state.getCharade(firstServed.id)?.reply).toMatchObject({ address: decoder.address })
    expect(state.getCharade(mailedCharade!.id)).toMatchObject({
      recipient: mailRecipient.address,
      reply: { address: mailRecipient.address }
    })

    const duetViewer = players[5]
    await connect(duetViewer)
    const duetStats = state.playerStats.get(duetViewer.address.toLowerCase())!
    duetStats.seen = persistedPool.filter((id) => id !== firstServed.id)
    state.saveStats(duetViewer.address)
    expect(duetViewer.runtime.requestNextCharade()).toBe(true)
    await room.pump(duetViewer.address)
    expect(duetViewer.runtime.getState().charade).toMatchObject({
      id: firstServed.id,
      reply: { address: decoder.address }
    })
    assertClientBoards(duetViewer.runtime.getState(), state)
    await disconnect(duetViewer)

    await connect(decoder)
    const beforeRolloverTheme = decoder.runtime.getState().theme
    now = Date.UTC(2026, 7, 24, 0, 0, 1)
    await protocol.handlePing({ seq: 10_001 }, decoder.address)
    expect(decoder.runtime.getState()).toMatchObject({
      theme: themeForTimestamp(now).id,
      progress: { daily: { day: dayKey(now), decoded: 0, authored: 0, stamped: false } }
    })
    expect(decoder.runtime.getState().theme).not.toBe(beforeRolloverTheme)
    assertStateInvariants(state, now)
    assertClientBoards(decoder.runtime.getState(), state)

    now = Date.UTC(2026, 8, 8, 0, 0, 1)
    expect(Math.floor((now - Date.UTC(2026, 7, 23, 12)) / DAY_MILLISECONDS)).toBeGreaterThan(HYDRATION_DAYS)
    await protocol.handlePing({ seq: 10_002 }, decoder.address)
    expect(state.getPool()).toEqual([])
    expect(state.getPlayerCharades()).toEqual([])
    expect(state.boards.hardest).toEqual([])
    expect(state.boards.decoders).toEqual([])
    expect(decoder.runtime.getState().boards.hardestGhosts).toEqual([])
    expect(decoder.runtime.getState().boards.topDecoders).toEqual([])
    assertStateInvariants(state, now)
    await disconnect(decoder)

    await repository.flushNow()
    protocol = await bootServer('soak-server-c')
    expect(state.getPool()).toEqual([])
    expect(state.getPlayerCharades()).toEqual([])
    expect(state.playerStats.size).toBeLessThanOrEqual(PLAYER_COUNT)
    expect(storage.scene.size).toBeLessThanOrEqual(persistedPlayerCharades.length + HYDRATION_DAYS * 2 + 3)
    expect(storage.players.size).toBeLessThanOrEqual(PLAYER_COUNT)
    for (const values of storage.players.values()) expect(values.size).toBeLessThanOrEqual(4)
    expect(repository.getDirtyKeys()).toEqual([])
    expect(protocol.resourceCounts()).toEqual({
      present: 0,
      sessionGenerations: 0,
      servedAnswers: 0,
      retryStates: 0,
      activeDecoders: 0,
      completedRequests: 0,
      nextRequests: 0,
      outstandingRequests: 0,
      requestBuckets: 0
    })

    expect(room.measurements.length).toBeGreaterThan(0)
    expect(room.measurements.every((measurement) => measurement.bytes < 4_000)).toBe(true)
    expect(Math.max(...room.measurements.map((measurement) => measurement.bytes))).toBeLessThan(4_000)
    const payloadMaxima = new Map<string, number>()
    for (const measurement of room.measurements) {
      const key = `${measurement.direction}:${measurement.type}`
      payloadMaxima.set(key, Math.max(payloadMaxima.get(key) ?? 0, measurement.bytes))
    }
    expect({
      post: payloadMaxima.get('client:post'),
      posted: payloadMaxima.get('server:posted'),
      charade: payloadMaxima.get('server:charade'),
      retry: payloadMaxima.get('server:retry'),
      since: payloadMaxima.get('server:since')
    }).toEqual({ post: 186, posted: 369, charade: 836, retry: 104, since: 263 })
    expect(avatarBudget.peak).toBeLessThanOrEqual(MAX_GHOSTS)
  })
})
