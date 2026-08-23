export type RoundPlayer = {
  address: string
  name: string
}

export type RoundSnapshot = {
  charadeId: string
  guessed: string[]
  winner: RoundPlayer | null
}

export type RoundGuessResult = { accepted: false; winner: null } | { accepted: true; winner: RoundPlayer | null }

export type RoundSend = (type: 'roundStart' | 'roundWinner', data: unknown) => void | Promise<void>

export class LiveRounds {
  private readonly players = new Map<string, RoundPlayer>()
  private active: {
    charadeId: string
    guessed: Set<string>
    winner: RoundPlayer | null
    settled: boolean
  } | null = null

  constructor(private readonly send: RoundSend = () => {}) {}

  enter(player: RoundPlayer) {
    this.players.set(player.address.toLowerCase(), player)
  }

  leave(address: string) {
    const key = address.toLowerCase()
    this.players.delete(key)
    const active = this.active
    if (this.players.size < 2) this.active = null
    else if (active && [...this.players.keys()].every((player) => active.guessed.has(player))) {
      active.settled = true
    }
  }

  get playerCount() {
    return this.players.size
  }

  get isLive() {
    return this.players.size >= 2
  }

  get isSettled() {
    const active = this.active
    if (!active) return false
    return (
      active.settled ||
      active.winner !== null ||
      [...this.players.keys()].every((address) => active.guessed.has(address))
    )
  }

  get current(): RoundSnapshot | null {
    if (!this.active) return null
    return {
      charadeId: this.active.charadeId,
      guessed: [...this.active.guessed],
      winner: this.active.winner
    }
  }

  start(charadeId: string) {
    if (!this.isLive) return false
    if (this.active?.charadeId === charadeId && !this.isSettled) return false
    this.active = { charadeId, guessed: new Set(), winner: null, settled: false }
    void this.send('roundStart', { charadeId })
    return true
  }

  guess(address: string, charadeId: string, correct: boolean): RoundGuessResult {
    const key = address.toLowerCase()
    const player = this.players.get(key)
    const active = this.active
    if (!player || !active || active.charadeId !== charadeId || active.guessed.has(key)) {
      return { accepted: false, winner: null }
    }

    active.guessed.add(key)
    if (!correct || active.winner) {
      if ([...this.players.keys()].every((address) => active.guessed.has(address))) active.settled = true
      return { accepted: true, winner: null }
    }

    active.winner = player
    active.settled = true
    void this.send('roundWinner', { address: player.address, name: player.name })
    return { accepted: true, winner: player }
  }
}
