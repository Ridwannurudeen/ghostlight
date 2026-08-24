import { triggerEmote } from '~system/RestrictedActions'
import { room } from '../shared/messages'
import { canSpectatorReact, clientFlow, type ReactionKind } from './flow'
import { isPlayerInDecodeArea } from './setup'

export const REACTION_OPTIONS: ReadonlyArray<{
  kind: ReactionKind
  emote: string
}> = [
  { kind: 'laugh', emote: 'clap' },
  { kind: 'gasp', emote: 'headexplode' },
  { kind: 'applause', emote: 'clap' }
]

export async function sendReaction(kind: ReactionKind) {
  if (!canSpectatorReact(clientFlow.getState()) || !isPlayerInDecodeArea()) return false
  const reaction = REACTION_OPTIONS.find((candidate) => candidate.kind === kind)
  if (!reaction) return false

  await Promise.all([triggerEmote({ predefinedEmote: reaction.emote }), room.send('react', { kind })])
  clientFlow.showLocalReaction(kind)
  return true
}
