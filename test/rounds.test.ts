import { describe, expect, it, vi } from 'vitest'
import { LiveRounds } from '../src/server/rounds'

describe('live rounds', () => {
  it('stays inactive for a solo player and starts when a second distinct player enters', () => {
    const send = vi.fn()
    const rounds = new LiveRounds(send)
    rounds.enter({ address: '0xAlice', name: 'Alice' })

    expect(rounds.playerCount).toBe(1)
    expect(rounds.isLive).toBe(false)
    expect(rounds.start('charade-1')).toBe(false)
    expect(send).not.toHaveBeenCalled()

    rounds.enter({ address: '0xBob', name: 'Bob' })
    expect(rounds.playerCount).toBe(2)
    expect(rounds.isLive).toBe(true)
    expect(rounds.start('charade-1')).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('roundStart', { roundId: '1', charadeId: 'charade-1' })
  })

  it('deduplicates player addresses without regard to case', () => {
    const rounds = new LiveRounds()
    rounds.enter({ address: '0xAlice', name: 'Old name' })
    rounds.enter({ address: '0xALICE', name: 'Current name' })

    expect(rounds.playerCount).toBe(1)
    expect(rounds.isLive).toBe(false)
  })

  it('rejects unknown, stale, and duplicate guesses while recording one guess per player', () => {
    const rounds = new LiveRounds()
    rounds.enter({ address: 'alice', name: 'Alice' })
    rounds.enter({ address: 'bob', name: 'Bob' })
    rounds.start('active')

    expect(rounds.guess('missing', 'active', true)).toEqual({ accepted: false, winner: null })
    expect(rounds.guess('alice', 'stale', true)).toEqual({ accepted: false, winner: null })
    expect(rounds.guess('ALICE', 'active', false)).toEqual({ accepted: true, winner: null })
    expect(rounds.guess('alice', 'active', true)).toEqual({ accepted: false, winner: null })
    expect(rounds.current).toEqual({ roundId: '1', charadeId: 'active', guessed: ['alice'], winner: null })
  })

  it('settles after every present player guesses without a winner', () => {
    const rounds = new LiveRounds()
    rounds.enter({ address: 'alice', name: 'Alice' })
    rounds.enter({ address: 'bob', name: 'Bob' })
    rounds.start('active')

    expect(rounds.isSettled).toBe(false)
    rounds.guess('alice', 'active', false)
    expect(rounds.isSettled).toBe(false)
    rounds.guess('bob', 'active', false)
    expect(rounds.isSettled).toBe(true)
  })

  it('keeps an all-wrong round settled when another player enters', () => {
    const rounds = new LiveRounds()
    rounds.enter({ address: 'alice', name: 'Alice' })
    rounds.enter({ address: 'bob', name: 'Bob' })
    rounds.start('active')
    rounds.guess('alice', 'active', false)
    rounds.guess('bob', 'active', false)

    rounds.enter({ address: 'carol', name: 'Carol' })

    expect(rounds.isSettled).toBe(true)
    expect(rounds.start('next')).toBe(true)
  })

  it('awards exactly one first correct winner', () => {
    const send = vi.fn()
    const rounds = new LiveRounds(send)
    rounds.enter({ address: 'alice', name: 'Alice' })
    rounds.enter({ address: 'bob', name: 'Bob' })
    rounds.enter({ address: 'carol', name: 'Carol' })
    rounds.start('race')
    send.mockClear()

    expect(rounds.guess('bob', 'race', true)).toEqual({
      accepted: true,
      winner: { address: 'bob', name: 'Bob' }
    })
    expect(rounds.guess('alice', 'race', true)).toEqual({ accepted: false, winner: null })
    expect(rounds.guess('carol', 'race', true)).toEqual({ accepted: false, winner: null })
    expect(rounds.current?.winner).toEqual({ address: 'bob', name: 'Bob' })
    expect(rounds.isSettled).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('roundWinner', {
      roundId: '1',
      charadeId: 'race',
      address: 'bob',
      name: 'Bob'
    })
  })

  it('prevents duplicate starts before a winner and permits the next round after completion', () => {
    const send = vi.fn()
    const rounds = new LiveRounds(send)
    rounds.enter({ address: 'alice', name: 'Alice' })
    rounds.enter({ address: 'bob', name: 'Bob' })

    expect(rounds.start('same')).toBe(true)
    expect(rounds.start('same')).toBe(false)
    rounds.guess('alice', 'same', true)
    expect(rounds.start('same')).toBe(true)
    expect(rounds.current).toEqual({ roundId: '2', charadeId: 'same', guessed: [], winner: null })

    rounds.guess('alice', 'same', false)
    rounds.guess('bob', 'same', false)
    expect(rounds.start('same')).toBe(true)
    expect(rounds.current).toEqual({ roundId: '3', charadeId: 'same', guessed: [], winner: null })
  })

  it('ends the active round when attendance falls below two', () => {
    const send = vi.fn()
    const rounds = new LiveRounds(send)
    rounds.enter({ address: 'alice', name: 'Alice' })
    rounds.enter({ address: 'bob', name: 'Bob' })
    rounds.start('charade')
    send.mockClear()

    rounds.leave('BOB')

    expect(rounds.playerCount).toBe(1)
    expect(rounds.isLive).toBe(false)
    expect(rounds.current).toBeNull()
    expect(rounds.guess('alice', 'charade', true)).toEqual({ accepted: false, winner: null })
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('roundStart', { roundId: '2', charadeId: '' })

    rounds.enter({ address: 'bob', name: 'Bob' })
    expect(rounds.start('next')).toBe(true)
    expect(send).toHaveBeenLastCalledWith('roundStart', { roundId: '3', charadeId: 'next' })
  })

  it('expires an abstained or idle participant without letting a late arrival extend the deadline', () => {
    let now = 1_000
    const rounds = new LiveRounds(
      () => {},
      () => now,
      5_000
    )
    rounds.enter({ address: 'alice', name: 'Alice' })
    rounds.enter({ address: 'bob', name: 'Bob' })
    rounds.start('timed')
    const roundId = rounds.current!.roundId

    now = 4_000
    rounds.enter({ address: 'carol', name: 'Carol' })
    expect(rounds.isParticipant('carol')).toBe(false)
    expect(rounds.guess('carol', 'timed', true)).toEqual({ accepted: false, winner: null })
    expect(rounds.abstain('alice', roundId)).toBe(true)
    expect(rounds.isSettled).toBe(false)

    now = 6_000
    expect(rounds.isSettled).toBe(true)
    expect(rounds.start('next')).toBe(true)
    expect(rounds.current).toMatchObject({ roundId: '2', charadeId: 'next', guessed: [] })
    expect(rounds.isParticipant('carol')).toBe(true)
  })
})
