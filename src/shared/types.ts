import type { PlayerTitle } from './config'

export const STORAGE_SCHEMA_VERSION = 2

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

export type CharadeReply = {
  address: string
  name: string
  look: Look
  emotes: [string, string, string]
  createdAt: number
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
  reply?: CharadeReply
}

export type DailyProgress = {
  day: string
  decoded: number
  authored: number
  stamped: boolean
}

export type PlayerStats = {
  v: number
  name: string
  decoded: number
  correct: number
  seen: string[]
  authored: string[]
  authoredCount: number
  lastSeenAt: number
  pending: {
    triedYou: number
    gotYou: number
    replies: number
  }
  daily: DailyProgress
  stampedDays: string[]
  title: PlayerTitle
}

export type NextUnlock = {
  nextTitle: PlayerTitle
  requirement: string
  progress: number
}

export type PlayerProgress = {
  title: PlayerTitle
  nextUnlock: NextUnlock
}

export type PlaybillPerformer = {
  address: string
  name: string
  isGuest: boolean
  title: PlayerTitle
  performedAt: number
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
