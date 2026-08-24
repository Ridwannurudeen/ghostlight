export type RoundPlayer = {
  address: string
  name: string
}

export type RoundSnapshot = {
  roundId: string
  charadeId: string
  guessed: string[]
  winner: RoundPlayer | null
}

export type RoundGuessResult = { accepted: false; winner: null } | { accepted: true; winner: RoundPlayer | null }

export type RoundSend = (type: 'roundStart' | 'roundWinner', data: unknown) => void | Promise<void>

export class LiveRounds {
  private readonly players = new Map<string, RoundPlayer>()
  private sequence = 0
  private active: {
    roundId: string
    charadeId: string
    participants: Set<string>
    guessed: Set<string>
    winner: RoundPlayer | null
    settled: boolean
    deadline: number
  } | null = null

  constructor(
    private readonly send: RoundSend = () => {},
    private readonly now: () => number = Date.now,
    private readonly durationMilliseconds = 45_000
  ) {}

  enter(player: RoundPlayer) {
    this.players.set(player.address.toLowerCase(), player)
  }

  leave(address: string) {
    const key = address.toLowerCase()
    this.players.delete(key)
    const active = this.active
    if (active?.participants.has(key)) active.guessed.add(key)
    if (this.players.size < 2) {
      this.active = null
      if (active) void this.send('roundStart', { roundId: String(++this.sequence), charadeId: '' })
    } else if (active && [...active.participants].every((player) => active.guessed.has(player))) {
      active.settled = true
    }
  }

  get playerCount() {
    return this.players.size
  }

  hasPlayer(address: string) {
    return this.players.has(address.toLowerCase())
  }

  isParticipant(address: string) {
    return this.active?.participants.has(address.toLowerCase()) ?? false
  }

  get isLive() {
    return this.players.size >= 2
  }

  get isSettled() {
    const active = this.active
    if (!active) return false
    if (this.now() >= active.deadline) active.settled = true
    return (
      active.settled ||
      active.winner !== null ||
      [...active.participants].every((address) => active.guessed.has(address))
    )
  }

  get current(): RoundSnapshot | null {
    if (!this.active) return null
    return {
      roundId: this.active.roundId,
      charadeId: this.active.charadeId,
      guessed: [...this.active.guessed],
      winner: this.active.winner
    }
  }

  start(charadeId: string) {
    if (!this.isLive) return false
    if (this.active?.charadeId === charadeId && !this.isSettled) return false
    const roundId = String(++this.sequence)
    this.active = {
      roundId,
      charadeId,
      participants: new Set(this.players.keys()),
      guessed: new Set(),
      winner: null,
      settled: false,
      deadline: this.now() + this.durationMilliseconds
    }
    void this.send('roundStart', { roundId, charadeId })
    return true
  }

  abstain(address: string, roundId: string) {
    const key = address.toLowerCase()
    const active = this.active
    if (!active || active.roundId !== roundId || !active.participants.has(key) || active.guessed.has(key)) return false
    active.guessed.add(key)
    if ([...active.participants].every((participant) => active.guessed.has(participant))) active.settled = true
    return true
  }

  guess(address: string, charadeId: string, correct: boolean): RoundGuessResult {
    const key = address.toLowerCase()
    const player = this.players.get(key)
    const active = this.active
    if (
      !player ||
      !active ||
      this.isSettled ||
      !active.participants.has(key) ||
      active.charadeId !== charadeId ||
      active.guessed.has(key)
    ) {
      return { accepted: false, winner: null }
    }

    active.guessed.add(key)
    if (!correct || active.winner) {
      if ([...active.participants].every((address) => active.guessed.has(address))) active.settled = true
      return { accepted: true, winner: null }
    }

    active.winner = player
    active.settled = true
    void this.send('roundWinner', {
      roundId: active.roundId,
      charadeId: active.charadeId,
      address: player.address,
      name: player.name
    })
    return { accepted: true, winner: player }
  }
}
