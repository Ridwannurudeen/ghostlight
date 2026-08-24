import type { Color, Look } from '../shared/types'
import { normalizePlayerName } from '../shared/i18n'

export const MAX_AVATAR_WEARABLES = 20
export const MAX_AVATAR_URN_BYTES = 512
export const MAX_AVATAR_LOOK_BYTES = 2_800

const MAX_WEARABLE_CANDIDATES = 100
const MAX_AVATAR_ADDRESS_BYTES = 48
const DEFAULT_BODY_SHAPE = 'urn:decentraland:off-chain:base-avatars:BaseMale'
const DEFAULT_SKIN_COLOR = { r: 0.6, g: 0.46, b: 0.36 }
const DEFAULT_HAIR_COLOR = { r: 0.28, g: 0.14, b: 0 }
const DEFAULT_EYE_COLOR = { r: 0.3, g: 0.48, b: 0.62 }
const DECENTRALAND_URN = /^urn:decentraland:[\x21-\x7e]+$/u

function utf8Bytes(value: string, stopAfter = Number.POSITIVE_INFINITY) {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes > stopAfter) return bytes
  }
  return bytes
}

function limitUtf8(value: string, maxBytes: number) {
  if (utf8Bytes(value, maxBytes) <= maxBytes) return value
  const kept: string[] = []
  let bytes = 0
  for (const character of value) {
    const characterBytes = utf8Bytes(character)
    if (bytes + characterBytes > maxBytes) break
    kept.push(character)
    bytes += characterBytes
  }
  return kept.join('')
}

function validAvatarUrn(value: string) {
  return (
    utf8Bytes(value, MAX_AVATAR_URN_BYTES) <= MAX_AVATAR_URN_BYTES &&
    DECENTRALAND_URN.test(value) &&
    value
      .split(':')
      .slice(2)
      .every((segment) => segment.length > 0)
  )
}

function safeColor(color: Color, fallback: Color): Color {
  return [color.r, color.g, color.b].every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)
    ? { ...color }
    : { ...fallback }
}

function encodedLookBytes(look: Look) {
  return utf8Bytes(JSON.stringify(look))
}

export function sanitizeAvatarLook(look: Look): Look {
  const wearables: string[] = []
  const candidates = Math.min(look.wearables.length, MAX_WEARABLE_CANDIDATES)
  for (let index = 0; index < candidates && wearables.length < MAX_AVATAR_WEARABLES; index += 1) {
    const wearable = look.wearables[index]
    if (validAvatarUrn(wearable)) wearables.push(wearable)
  }

  const bounded: Look = {
    address: limitUtf8(look.address, MAX_AVATAR_ADDRESS_BYTES),
    name: normalizePlayerName(look.name),
    isGuest: look.isGuest,
    bodyShape: validAvatarUrn(look.bodyShape) ? look.bodyShape : DEFAULT_BODY_SHAPE,
    skinColor: safeColor(look.skinColor, DEFAULT_SKIN_COLOR),
    hairColor: safeColor(look.hairColor, DEFAULT_HAIR_COLOR),
    eyeColor: safeColor(look.eyeColor, DEFAULT_EYE_COLOR),
    wearables
  }
  while (bounded.wearables.length > 0 && encodedLookBytes(bounded) > MAX_AVATAR_LOOK_BYTES) bounded.wearables.pop()
  return bounded
}
