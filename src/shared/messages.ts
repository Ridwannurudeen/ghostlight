import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

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
  progress: Schemas.Map({ daily }),
  nextCharade: Schemas.Map({ exclude: Schemas.Array(Schemas.String) }),
  charade: Schemas.Map({
    id: Schemas.String,
    authorName: Schemas.String,
    authorAddress: Schemas.String,
    look,
    emotes: Schemas.Array(Schemas.String),
    answers: Schemas.Array(Schemas.String),
    createdAt: Schemas.Int64,
    isHouse: Schemas.Boolean
  }),
  guess: Schemas.Map({
    charadeId: Schemas.String,
    answerIndex: Schemas.Int,
    requestId: Schemas.String
  }),
  reveal: Schemas.Map({
    charadeId: Schemas.String,
    correct: Schemas.Boolean,
    phrase: Schemas.String,
    stats: Schemas.Map({
      total: Schemas.Int,
      correct: Schemas.Int
    }),
    yourScore: Schemas.Int,
    daily,
    stampAwarded: Schemas.Boolean
  }),
  post: Schemas.Map({
    phraseId: Schemas.String,
    emotes: Schemas.Array(Schemas.String),
    requestId: Schemas.String
  }),
  posted: Schemas.Map({
    charadeId: Schemas.String,
    daily,
    stampAwarded: Schemas.Boolean
  }),
  since: Schemas.Map({
    triedYou: Schemas.Int,
    gotYou: Schemas.Int,
    rank: Schemas.Int,
    daily
  }),
  audience: Schemas.Map({ looks: Schemas.Array(look) }),
  boards: Schemas.Map({
    topDecoders: Schemas.Array(decoder),
    hardestGhosts: Schemas.Array(hardestGhost)
  }),
  roundStart: Schemas.Map({ charadeId: Schemas.String }),
  roundGuess: Schemas.Map({
    charadeId: Schemas.String,
    answerIndex: Schemas.Int,
    requestId: Schemas.String
  }),
  roundWinner: Schemas.Map({
    address: Schemas.String,
    name: Schemas.String
  }),
  react: Schemas.Map({ kind: Schemas.String }),
  error: Schemas.Map({ code: Schemas.String })
}

export const room = registerMessages(Messages)
