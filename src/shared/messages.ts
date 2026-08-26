import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const SPECTATOR_REACTION_KINDS = ['laugh', 'gasp', 'applause'] as const

const color = Schemas.Map({
  r: Schemas.Number,
  g: Schemas.Number,
  b: Schemas.Number
})

const look = Schemas.Map({
  address: Schemas.String,
  name: Schemas.String,
  isGuest: Schemas.Boolean,
  bodyShape: Schemas.String,
  skinColor: color,
  hairColor: color,
  eyeColor: color,
  wearables: Schemas.Array(Schemas.String)
})

const decoder = Schemas.Map({
  address: Schemas.String,
  name: Schemas.String,
  correct: Schemas.Int,
  total: Schemas.Int
})

const hardestGhost = Schemas.Map({
  charadeId: Schemas.String,
  authorName: Schemas.String,
  total: Schemas.Int,
  correct: Schemas.Int
})

const daily = Schemas.Map({
  day: Schemas.String,
  decoded: Schemas.Int,
  authored: Schemas.Int,
  stamped: Schemas.Boolean
})

const nextUnlock = Schemas.Map({
  nextTitle: Schemas.String,
  requirement: Schemas.String,
  progress: Schemas.Number
})

const performer = Schemas.Map({
  address: Schemas.String,
  name: Schemas.String,
  isGuest: Schemas.Boolean,
  title: Schemas.String,
  performedAt: Schemas.Int64
})

export const Messages = {
  hello: Schemas.Map({
    displayName: Schemas.String,
    isGuest: Schemas.Boolean,
    protocolVersion: Schemas.Int
  }),
  ready: Schemas.Map({
    instanceId: Schemas.String,
    serverTime: Schemas.Int64,
    theme: Schemas.String,
    themeLabel: Schemas.String
  }),
  ping: Schemas.Map({ seq: Schemas.Int }),
  pong: Schemas.Map({ seq: Schemas.Int }),
  progress: Schemas.Map({
    daily,
    revision: Schemas.Int,
    title: Schemas.String,
    nextUnlock
  }),
  playerTitle: Schemas.Map({
    address: Schemas.String,
    title: Schemas.String
  }),
  nextCharade: Schemas.Map({
    requestId: Schemas.String,
    exclude: Schemas.Array(Schemas.String)
  }),
  charade: Schemas.Map({
    requestId: Schemas.String,
    id: Schemas.String,
    authorName: Schemas.String,
    authorAddress: Schemas.String,
    look,
    emotes: Schemas.Array(Schemas.String),
    answers: Schemas.Array(Schemas.String),
    answerIds: Schemas.Optional(Schemas.Array(Schemas.String)),
    createdAt: Schemas.Int64,
    isHouse: Schemas.Boolean,
    authorTitle: Schemas.String,
    recipient: Schemas.Optional(Schemas.String),
    setRound: Schemas.Optional(Schemas.Int),
    setSize: Schemas.Optional(Schemas.Int),
    setScore: Schemas.Optional(Schemas.Int),
    setStreak: Schemas.Optional(Schemas.Int),
    isFinale: Schemas.Optional(Schemas.Boolean)
  }),
  guess: Schemas.Map({
    charadeId: Schemas.String,
    answerIndex: Schemas.Int,
    requestId: Schemas.String,
    spotlight: Schemas.Optional(Schemas.Boolean)
  }),
  retry: Schemas.Map({
    requestId: Schemas.String,
    charadeId: Schemas.String,
    removedAnswerIndex: Schemas.Int,
    replayBeatIndex: Schemas.Int
  }),
  reveal: Schemas.Map({
    requestId: Schemas.String,
    charadeId: Schemas.String,
    correct: Schemas.Boolean,
    phraseId: Schemas.String,
    phrase: Schemas.String,
    stats: Schemas.Map({
      total: Schemas.Int,
      correct: Schemas.Int
    }),
    yourScore: Schemas.Int,
    daily,
    revision: Schemas.Int,
    stampAwarded: Schemas.Boolean,
    attempt: Schemas.Optional(Schemas.Int),
    title: Schemas.String,
    nextUnlock,
    titleUnlocked: Schemas.Boolean,
    spotlight: Schemas.Optional(Schemas.Boolean),
    scoreDelta: Schemas.Optional(Schemas.Int),
    setRound: Schemas.Optional(Schemas.Int),
    setSize: Schemas.Optional(Schemas.Int),
    setScore: Schemas.Optional(Schemas.Int),
    setStreak: Schemas.Optional(Schemas.Int),
    setBestStreak: Schemas.Optional(Schemas.Int),
    setUnderstood: Schemas.Optional(Schemas.Int),
    setComplete: Schemas.Optional(Schemas.Boolean),
    isFinale: Schemas.Optional(Schemas.Boolean)
  }),
  post: Schemas.Map({
    phraseId: Schemas.String,
    emotes: Schemas.Array(Schemas.String),
    requestId: Schemas.String,
    replyTo: Schemas.Optional(Schemas.String),
    recipient: Schemas.Optional(Schemas.String)
  }),
  posted: Schemas.Map({
    requestId: Schemas.String,
    charadeId: Schemas.String,
    replyTo: Schemas.Optional(Schemas.String),
    recipient: Schemas.Optional(Schemas.String),
    daily,
    revision: Schemas.Int,
    stampAwarded: Schemas.Boolean,
    title: Schemas.String,
    nextUnlock,
    titleUnlocked: Schemas.Boolean
  }),
  since: Schemas.Map({
    triedYou: Schemas.Int,
    gotYou: Schemas.Int,
    replies: Schemas.Int,
    mail: Schemas.Int,
    rank: Schemas.Int,
    daily,
    revision: Schemas.Int,
    title: Schemas.String,
    nextUnlock
  }),
  audience: Schemas.Map({ looks: Schemas.Array(look) }),
  boards: Schemas.Map({
    topDecoders: Schemas.Array(decoder),
    hardestGhosts: Schemas.Array(hardestGhost),
    playbill: Schemas.Array(performer),
    ghostOfNightId: Schemas.String
  }),
  ghostOfNight: Schemas.Map({
    charadeId: Schemas.String,
    address: Schemas.String,
    name: Schemas.String,
    title: Schemas.String,
    look,
    total: Schemas.Int,
    correct: Schemas.Int
  }),
  charadeReply: Schemas.Map({
    charadeId: Schemas.String,
    address: Schemas.String,
    name: Schemas.String,
    look,
    emotes: Schemas.Array(Schemas.String),
    createdAt: Schemas.Int64
  }),
  roundStart: Schemas.Map({ roundId: Schemas.String, charadeId: Schemas.String }),
  roundGuess: Schemas.Map({
    charadeId: Schemas.String,
    answerIndex: Schemas.Int,
    requestId: Schemas.String,
    spotlight: Schemas.Optional(Schemas.Boolean)
  }),
  roundWinner: Schemas.Map({
    roundId: Schemas.String,
    charadeId: Schemas.String,
    address: Schemas.String,
    name: Schemas.String
  }),
  react: Schemas.Map({ kind: Schemas.String }),
  error: Schemas.Map({ code: Schemas.String })
}

export const room = registerMessages(Messages)
