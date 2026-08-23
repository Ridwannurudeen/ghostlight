import { AvatarShape, Transform, engine, type Entity } from '@dcl/sdk/ecs'
import { Quaternion, type Quaternion as QuaternionType, type Vector3 as Vector3Type } from '@dcl/sdk/math'
import { AUDIENCE_SEATS, EMOTE_STEP_SECONDS, MAX_GHOSTS } from '../shared/config'
import type { Look } from '../shared/types'
import { AUDIENCE_POSITIONS, STAGE_PERFORMER_POSITION, STAGE_PREVIEW_POSITION } from './theater'

export type GhostEmotes = readonly [string, string, string]
export type AudienceReaction = 'clap' | 'shrug' | 'laugh' | 'confused' | 'genius'

type GhostSlot = {
  entity: Entity
  active: boolean
  address: string
  sequence: GhostEmotes | null
  emoteIndex: number
  elapsed: number
  lamport: number
}

type QueuedAudienceGhost = {
  look: Look
  slotIndex: number
}

const AUDIENCE_START_INDEX = 1
const PREVIEW_INDEX = AUDIENCE_START_INDEX + AUDIENCE_SEATS
const REQUIRED_GHOST_SLOTS = PREVIEW_INDEX + 1
const AUDIENCE_SPAWN_INTERVAL_SECONDS = 1 / 3

const FACE_AUDIENCE = Quaternion.fromEulerDegrees(0, 180, 0)
const FACE_STAGE = Quaternion.Identity()

let initialized = false
let slots: GhostSlot[] = []
let audienceQueue: QueuedAudienceGhost[] = []
let audienceSpawnClock = 0

export function initializeGhosts() {
  if (initialized) return
  if (REQUIRED_GHOST_SLOTS > MAX_GHOSTS) {
    throw new Error(`Ghost pool needs ${REQUIRED_GHOST_SLOTS} slots but MAX_GHOSTS is ${MAX_GHOSTS}`)
  }

  slots = [createSlot(STAGE_PERFORMER_POSITION, FACE_AUDIENCE)]
  for (const position of AUDIENCE_POSITIONS) {
    slots.push(createSlot(position, FACE_STAGE))
  }
  slots.push(createSlot(STAGE_PREVIEW_POSITION, FACE_AUDIENCE))

  initialized = true
  engine.addSystem(ghostSystem, undefined, 'ghost-charades::ghosts')
}

export function showPerformer(look: Look, emotes: GhostEmotes) {
  initializeGhosts()
  showGhost(slots[0], look, emotes)
}

export function replayPerformer() {
  initializeGhosts()
  const performer = slots[0]
  if (!performer.active || performer.sequence === null) return
  performer.emoteIndex = 0
  performer.elapsed = 0
  trigger(performer, performer.sequence[0])
}

export function clearPerformer() {
  initializeGhosts()
  hideGhost(slots[0])
}

export function setAudience(looks: readonly Look[]) {
  initializeGhosts()
  const wanted = looks.slice(0, AUDIENCE_SEATS)
  const wantedAddresses = new Set(wanted.map((look) => canonicalAddress(look.address)))

  audienceQueue = audienceQueue.filter((queued) => wantedAddresses.has(canonicalAddress(queued.look.address)))
  for (let index = AUDIENCE_START_INDEX; index < PREVIEW_INDEX; index += 1) {
    const slot = slots[index]
    if (slot.active && !wantedAddresses.has(slot.address)) hideGhost(slot)
  }

  const occupiedAddresses = new Set(
    slots
      .slice(AUDIENCE_START_INDEX, PREVIEW_INDEX)
      .filter((slot) => slot.active)
      .map((slot) => slot.address)
  )
  for (const queued of audienceQueue) occupiedAddresses.add(canonicalAddress(queued.look.address))

  const queuedSlots = new Set(audienceQueue.map((queued) => queued.slotIndex))
  const availableSlots = slots
    .slice(AUDIENCE_START_INDEX, PREVIEW_INDEX)
    .map((slot, index) => ({ slot, slotIndex: AUDIENCE_START_INDEX + index }))
    .filter(({ slot, slotIndex }) => !slot.active && !queuedSlots.has(slotIndex))
    .map(({ slotIndex }) => slotIndex)

  const queueWasEmpty = audienceQueue.length === 0
  for (const look of wanted) {
    const address = canonicalAddress(look.address)
    if (occupiedAddresses.has(address)) continue
    const slotIndex = availableSlots.shift()
    if (slotIndex === undefined) break
    audienceQueue.push({ look, slotIndex })
    occupiedAddresses.add(address)
  }
  if (queueWasEmpty && audienceQueue.length > 0) audienceSpawnClock = 0
}

export function clearAudience() {
  initializeGhosts()
  audienceQueue = []
  audienceSpawnClock = 0
  for (let index = AUDIENCE_START_INDEX; index < PREVIEW_INDEX; index += 1) {
    hideGhost(slots[index])
  }
}

export function showPreview(look: Look, emotes: GhostEmotes) {
  initializeGhosts()
  showGhost(slots[PREVIEW_INDEX], look, emotes)
}

export function clearPreview() {
  initializeGhosts()
  hideGhost(slots[PREVIEW_INDEX])
}

export function react(kind: AudienceReaction) {
  initializeGhosts()
  const emote = kind === 'shrug' || kind === 'confused' ? 'shrug' : 'clap'
  for (let index = AUDIENCE_START_INDEX; index < PREVIEW_INDEX; index += 1) {
    trigger(slots[index], emote)
  }
}

export function getPerformerEntity() {
  initializeGhosts()
  return slots[0].entity
}

function ghostSystem(dt: number) {
  spawnNextAudienceGhost(dt)
  for (const slot of slots) {
    if (!slot.active || slot.sequence === null) continue
    slot.elapsed += dt
    if (slot.elapsed < EMOTE_STEP_SECONDS) continue
    slot.elapsed = 0
    slot.emoteIndex = (slot.emoteIndex + 1) % slot.sequence.length
    trigger(slot, slot.sequence[slot.emoteIndex])
  }
}

function spawnNextAudienceGhost(dt: number) {
  if (audienceQueue.length === 0) return
  audienceSpawnClock += dt
  if (audienceSpawnClock < AUDIENCE_SPAWN_INTERVAL_SECONDS) return

  audienceSpawnClock = 0
  const next = audienceQueue.shift()
  if (next) showGhost(slots[next.slotIndex], next.look, null)
}

function showGhost(slot: GhostSlot, look: Look, sequence: GhostEmotes | null) {
  slot.active = true
  slot.address = canonicalAddress(look.address)
  slot.sequence = sequence
  slot.emoteIndex = 0
  slot.elapsed = 0
  slot.lamport += 1

  AvatarShape.createOrReplace(slot.entity, {
    id: look.address,
    name: look.name,
    bodyShape: look.bodyShape,
    skinColor: look.skinColor,
    hairColor: look.hairColor,
    eyeColor: look.eyeColor,
    wearables: [...look.wearables],
    emotes: [],
    expressionTriggerId: sequence?.[0],
    expressionTriggerTimestamp: slot.lamport
  })
}

function hideGhost(slot: GhostSlot) {
  if (slot.active) AvatarShape.deleteFrom(slot.entity)
  slot.active = false
  slot.address = ''
  slot.sequence = null
  slot.emoteIndex = 0
  slot.elapsed = 0
}

function trigger(slot: GhostSlot, emote: string) {
  if (!slot.active) return
  slot.lamport += 1
  const avatar = AvatarShape.getMutable(slot.entity)
  avatar.expressionTriggerId = emote
  avatar.expressionTriggerTimestamp = slot.lamport
}

function createSlot(position: Vector3Type, rotation: QuaternionType): GhostSlot {
  const entity = engine.addEntity()
  Transform.create(entity, { position, rotation })
  return {
    entity,
    active: false,
    address: '',
    sequence: null,
    emoteIndex: 0,
    elapsed: 0,
    lamport: 0
  }
}

function canonicalAddress(address: string) {
  return address.toLowerCase()
}
