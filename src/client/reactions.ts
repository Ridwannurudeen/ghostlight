import { triggerEmote } from '~system/RestrictedActions'
import { room } from '../shared/messages'
import { clientFlow, type ReactionKind } from './flow'

export const REACTION_OPTIONS: ReadonlyArray<{
  kind: ReactionKind
  label: string
  emote: string
}> = [
  { kind: 'laugh', label: 'LAUGH', emote: 'clap' },
  { kind: 'confused', label: 'CONFUSED', emote: 'shrug' },
  { kind: 'genius', label: 'GENIUS', emote: 'fistpump' }
]

export async function sendReaction(kind: ReactionKind) {
  if (!clientFlow.getState().ready) return false
  const reaction = REACTION_OPTIONS.find((candidate) => candidate.kind === kind)
  if (!reaction) return false

  await Promise.all([triggerEmote({ predefinedEmote: reaction.emote }), room.send('react', { kind })])
  return true
}
