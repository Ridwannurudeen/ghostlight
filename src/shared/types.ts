export const STORAGE_SCHEMA_VERSION = 1

export type Color = {
  r: number
  g: number
  b: number
}

export type Look = {
  address: string
  name: string
  isGuest: boolean
  bodyShape: string
  skinColor: Color
  hairColor: Color
  eyeColor: Color
  wearables: string[]
}

export type Charade = {
  v: number
  id: string
  author: Look
  phraseId: string
  emotes: [string, string, string]
  createdAt: number
  guesses: {
    total: number
    correct: number
  }
  lastGuessAt: number
  isHouse: boolean
}

export type PlayerStats = {
  v: number
  name: string
  decoded: number
  correct: number
  seen: string[]
  authored: string[]
  lastSeenAt: number
  pending: {
    triedYou: number
    gotYou: number
  }
}

export type Boards = {
  decoders: Array<{
    address: string
    name: string
    correct: number
    total: number
  }>
  hardest: Array<{
    charadeId: string
    authorName: string
    total: number
    correct: number
  }>
}
