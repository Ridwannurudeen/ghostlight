import { AvatarShape, Transform, engine, type Entity } from '@dcl/sdk/ecs'
import { Quaternion, type Quaternion as QuaternionType, type Vector3 as Vector3Type } from '@dcl/sdk/math'
import { AUDIENCE_SEATS, EMOTE_STEP_SECONDS, MAX_GHOSTS } from '../shared/config'
import type { Look } from '../shared/types'
import { sanitizeAvatarLook } from './look'
import {
  AUDIENCE_POSITIONS,
  GHOST_OF_NIGHT_POSITION,
  STAGE_PERFORMER_POSITION,
  STAGE_PREVIEW_POSITION
} from './theater'

export type GhostEmotes = readonly [string, string, string]
export type PerformerBeatIndex = 0 | 1 | 2
export type AudienceReaction = 'clap' | 'shrug' | 'laugh' | 'confused' | 'genius' | 'gasp' | 'applause'

export type DuetPerformer = {
  look: Look
  emotes: GhostEmotes
}

type GhostSlot = {
  entity: Entity
  active: boolean
  address: string
  sequence: GhostEmotes | null
  emoteIndex: PerformerBeatIndex
  elapsed: number
  lamport: number
  frozen: boolean
}

type QueuedAudienceGhost = {
  look: Look
  slotIndex: number
}

type DuetState = {
  sequences: readonly [GhostEmotes, GhostEmotes]
  performerIndex: 0 | 1
  emoteIndex: PerformerBeatIndex
  elapsed: number
  frozen: boolean
}

const AUDIENCE_START_INDEX = 1
const PREVIEW_INDEX = AUDIENCE_START_INDEX + AUDIENCE_SEATS
const GHOST_OF_NIGHT_INDEX = PREVIEW_INDEX - 1
const REQUIRED_GHOST_SLOTS = PREVIEW_INDEX + 1
const AUDIENCE_SPAWN_INTERVAL_SECONDS = 1 / 3

const FACE_AUDIENCE = Quaternion.fromEulerDegrees(0, 180, 0)
const FACE_STAGE = Quaternion.Identity()

let initialized = false
let slots: GhostSlot[] = []
let audienceQueue: QueuedAudienceGhost[] = []
let audienceSpawnClock = 0
let wantedAudience: Look[] = []
let ghostOfNightActive = false
let duet: DuetState | null = null
let previewActive = false

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
  engine.addSystem(ghostSystem, undefined, 'ghostlight::ghosts')
}

export function showPerformer(look: Look, emotes: GhostEmotes) {
  initializeGhosts()
  cancelDuet()
  clearAuthorPreview()
  showGhost(slots[0], look, emotes)
}

export function showDuet(author: DuetPerformer, reply: DuetPerformer) {
  initializeGhosts()
  cancelDuet()
  showGhost(slots[0], author.look, null)
  showGhost(slots[PREVIEW_INDEX], reply.look, null)
  duet = {
    sequences: [author.emotes, reply.emotes],
    performerIndex: 0,
    emoteIndex: 0,
    elapsed: 0,
    frozen: false
  }
  trigger(slots[0], author.emotes[0])
  syncAudience()
}

export function replayPerformer() {
  initializeGhosts()
  if (duet) {
    duet.performerIndex = 0
    duet.emoteIndex = 0
    duet.elapsed = 0
    trigger(slots[0], duet.sequences[0][0])
    return
  }
  const performer = slots[0]
  if (!performer.active || performer.sequence === null) return
  performer.emoteIndex = 0
  performer.elapsed = 0
  trigger(performer, performer.sequence[0])
}

export function replayPerformerBeat(beatIndex: PerformerBeatIndex) {
  initializeGhosts()
  const performer = slots[0]
  if (duet) {
    duet.performerIndex = 0
    duet.emoteIndex = beatIndex
    duet.elapsed = 0
    duet.frozen = false
    performer.frozen = false
    trigger(performer, duet.sequences[0][beatIndex])
    return
  }
  if (!performer.active || performer.sequence === null) return
  performer.emoteIndex = beatIndex
  performer.elapsed = 0
  performer.frozen = false
  trigger(performer, performer.sequence[beatIndex])
}

export function freezePerformer() {
  initializeGhosts()
  if (duet) duet.frozen = true
  slots[0].frozen = true
}

export function resumePerformer() {
  initializeGhosts()
  if (duet) {
    duet.frozen = false
    duet.elapsed = 0
  }
  slots[0].frozen = false
  slots[0].elapsed = 0
}

export function playPerformerEmote(emote: string) {
  initializeGhosts()
  trigger(slots[0], emote)
}

export function clearPerformer() {
  initializeGhosts()
  cancelDuet()
  clearAuthorPreview()
  hideGhost(slots[0])
}

export function setAudience(looks: readonly Look[]) {
  initializeGhosts()
  wantedAudience = looks.slice(0, AUDIENCE_SEATS)
  syncAudience()
}

function syncAudience() {
  const reservedSlots = (ghostOfNightActive ? 1 : 0) + (duet ? 1 : 0)
  const wanted = wantedAudience.slice(0, AUDIENCE_SEATS - reservedSlots)
  const wantedAddresses = new Set(wanted.map((look) => canonicalAddress(look.address)))

  audienceQueue = audienceQueue.filter(
    (queued) =>
      wantedAddresses.has(canonicalAddress(queued.look.address)) &&
      (!ghostOfNightActive || queued.slotIndex !== GHOST_OF_NIGHT_INDEX)
  )
  for (let index = AUDIENCE_START_INDEX; index < PREVIEW_INDEX; index += 1) {
    if (ghostOfNightActive && index === GHOST_OF_NIGHT_INDEX) continue
    const slot = slots[index]
    if (slot.active && !wantedAddresses.has(slot.address)) hideGhost(slot)
  }

  const occupiedAddresses = new Set(
    slots
      .slice(AUDIENCE_START_INDEX, PREVIEW_INDEX)
      .filter(
        (slot, index) => slot.active && (!ghostOfNightActive || AUDIENCE_START_INDEX + index !== GHOST_OF_NIGHT_INDEX)
      )
      .map((slot) => slot.address)
  )
  for (const queued of audienceQueue) occupiedAddresses.add(canonicalAddress(queued.look.address))

  const queuedSlots = new Set(audienceQueue.map((queued) => queued.slotIndex))
  const availableSlots = slots
    .slice(AUDIENCE_START_INDEX, PREVIEW_INDEX)
    .map((slot, index) => ({ slot, slotIndex: AUDIENCE_START_INDEX + index }))
    .filter(
      ({ slot, slotIndex }) =>
        !slot.active && !queuedSlots.has(slotIndex) && (!ghostOfNightActive || slotIndex !== GHOST_OF_NIGHT_INDEX)
    )
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

export function showGhostOfNight(look: Look) {
  initializeGhosts()
  ghostOfNightActive = true
  audienceQueue = audienceQueue.filter((queued) => queued.slotIndex !== GHOST_OF_NIGHT_INDEX)
  const slot = slots[GHOST_OF_NIGHT_INDEX]
  hideGhost(slot)
  Transform.createOrReplace(slot.entity, { position: GHOST_OF_NIGHT_POSITION, rotation: FACE_STAGE })
  showGhost(slot, look, null)
  syncAudience()
}

export function clearGhostOfNight() {
  initializeGhosts()
  if (!ghostOfNightActive) return
  ghostOfNightActive = false
  const slot = slots[GHOST_OF_NIGHT_INDEX]
  hideGhost(slot)
  Transform.createOrReplace(slot.entity, {
    position: AUDIENCE_POSITIONS[AUDIENCE_SEATS - 1],
    rotation: FACE_STAGE
  })
  syncAudience()
}

export function showPreview(look: Look, emotes: GhostEmotes) {
  initializeGhosts()
  cancelDuet()
  clearAuthorPreview()
  showGhost(slots[PREVIEW_INDEX], look, emotes)
  previewActive = true
}

export function clearPreview() {
  initializeGhosts()
  clearAuthorPreview()
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

export function getPerformerBeatIndex(): PerformerBeatIndex | null {
  if (!initialized || !slots[0].active) return null
  if (duet) return duet.emoteIndex
  return slots[0].sequence === null ? null : slots[0].emoteIndex
}

function ghostSystem(dt: number) {
  spawnNextAudienceGhost(dt)
  advanceDuet(dt)
  for (const slot of slots) {
    if (!slot.active || slot.sequence === null || slot.frozen) continue
    slot.elapsed += dt
    if (slot.elapsed < EMOTE_STEP_SECONDS) continue
    slot.elapsed = 0
    slot.emoteIndex = slot.emoteIndex === 0 ? 1 : slot.emoteIndex === 1 ? 2 : 0
    trigger(slot, slot.sequence[slot.emoteIndex])
  }
}

function advanceDuet(dt: number) {
  if (!duet || duet.frozen) return
  duet.elapsed += dt
  if (duet.elapsed < EMOTE_STEP_SECONDS) return

  duet.elapsed = 0
  if (duet.emoteIndex < duet.sequences[duet.performerIndex].length - 1) {
    duet.emoteIndex = duet.emoteIndex === 0 ? 1 : 2
  } else {
    duet.performerIndex = duet.performerIndex === 0 ? 1 : 0
    duet.emoteIndex = 0
  }

  const slotIndex = duet.performerIndex === 0 ? 0 : PREVIEW_INDEX
  trigger(slots[slotIndex], duet.sequences[duet.performerIndex][duet.emoteIndex])
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
  const safeLook = sanitizeAvatarLook(look)
  slot.active = true
  slot.address = canonicalAddress(safeLook.address)
  slot.sequence = sequence
  slot.emoteIndex = 0
  slot.elapsed = 0
  slot.lamport += 1
  slot.frozen = false

  AvatarShape.createOrReplace(slot.entity, {
    id: safeLook.address,
    name: safeLook.name,
    bodyShape: safeLook.bodyShape,
    skinColor: safeLook.skinColor,
    hairColor: safeLook.hairColor,
    eyeColor: safeLook.eyeColor,
    wearables: safeLook.wearables,
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
  slot.frozen = false
}

function cancelDuet() {
  if (!duet) return
  duet = null
  hideGhost(slots[PREVIEW_INDEX])
  syncAudience()
}

function clearAuthorPreview() {
  if (!previewActive) return
  previewActive = false
  hideGhost(slots[PREVIEW_INDEX])
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
    lamport: 0,
    frozen: false
  }
}

function canonicalAddress(address: string) {
  return address.toLowerCase()
}
