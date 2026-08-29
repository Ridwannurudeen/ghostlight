import { describe, expect, it } from 'vitest'
import {
  FUNNEL_EVENTS,
  FunnelAnalytics,
  createInviteLandingUrl,
  createInviteLinkRecord,
  createWorldInviteUrl,
  isAttributionId,
  isInviteToken
} from '../src/server/analytics'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-15T12:00:00.000Z')
const eventId = (value: number) => `evt_${value.toString(16).padStart(32, '0')}`
const inviteToken = (value: number) => `inv_${value.toString(16).padStart(32, '0')}`

describe('landing-link click attribution', () => {
  it('accepts bounded aggregate identifiers and rejects unsafe or address-shaped values', () => {
    expect(isAttributionId('season-zero')).toBe(true)
    expect(isAttributionId('creator_07')).toBe(true)
    expect(isAttributionId('a'.repeat(48))).toBe(true)
    expect(isAttributionId('')).toBe(false)
    expect(isAttributionId('a'.repeat(49))).toBe(false)
    expect(isAttributionId('Creator 07')).toBe(false)
    expect(isAttributionId('creator@example.com')).toBe(false)
    expect(isAttributionId(`0x${'a'.repeat(40)}`)).toBe(false)
    expect(isAttributionId(7)).toBe(false)
  })

  it('keeps the final Decentraland destination plain and attribution on an owned landing link', () => {
    const token = inviteToken(1)
    const record = createInviteLinkRecord({
      token,
      worldName: 'ghostlight.dcl.eth',
      campaign: 'Season-Zero',
      source: 'Creator_07',
      createdAt: NOW
    })

    expect(record).toEqual({
      token,
      campaign: 'season-zero',
      source: 'creator_07',
      destinationUrl: 'https://decentraland.org/jump/?realm=ghostlight.dcl.eth',
      createdAt: NOW
    })
    expect(createWorldInviteUrl('ghostlight.dcl.eth')).toBe(record.destinationUrl)
    expect(createInviteLandingUrl('https://ghostlight.example', token)).toBe(
      `https://ghostlight.example/invite/${token}`
    )
    expect(record.destinationUrl).not.toMatch(/utm_|campaign|source/u)
  })

  it('requires opaque invite tokens and safe HTTPS landing origins', () => {
    expect(isInviteToken(inviteToken(7))).toBe(true)
    expect(isInviteToken('inv_alice')).toBe(false)
    expect(isInviteToken(`0x${'1'.repeat(40)}`)).toBe(false)
    expect(() => createInviteLandingUrl('http://ghostlight.example', inviteToken(1))).toThrow(TypeError)
    expect(() => createInviteLandingUrl('https://user@ghostlight.example', inviteToken(1))).toThrow(TypeError)
    expect(() => createInviteLandingUrl('https://ghostlight.example/path', inviteToken(1))).toThrow(TypeError)
    expect(() =>
      createInviteLinkRecord({
        token: 'inv_alice',
        worldName: 'ghostlight.dcl.eth',
        campaign: 'season-zero',
        source: 'creator-07',
        createdAt: NOW
      })
    ).toThrow(TypeError)
  })
})

describe('privacy-safe aggregates', () => {
  it('exports in-world funnel counts without campaign or source attribution', () => {
    const analytics = new FunnelAnalytics({ retentionDays: 14, maxEventIds: 100 })

    FUNNEL_EVENTS.forEach((event, index) => {
      expect(analytics.record({ eventId: eventId(index), event, occurredAt: NOW }, NOW)).toBe('recorded')
    })

    expect(analytics.exportFunnelRows(NOW)).toEqual([
      {
        day: '2026-09-15',
        wake: 1,
        ready: 1,
        decode: 1,
        reveal: 1,
        author: 1,
        post: 1,
        invite: 1,
        mail: 1
      }
    ])
    expect(Object.keys(analytics.exportFunnelRows(NOW)[0])).not.toContain('campaign')
    expect(Object.keys(analytics.exportFunnelRows(NOW)[0])).not.toContain('source')
  })

  it('exports landing-link clicks separately by UTC day, campaign, and source', () => {
    const analytics = new FunnelAnalytics()

    for (const id of [eventId(1), eventId(2)]) {
      expect(
        analytics.record(
          {
            eventId: id,
            event: 'click',
            occurredAt: NOW,
            campaign: 'Season-Zero',
            source: 'Creator_07'
          },
          NOW
        )
      ).toBe('recorded')
    }

    expect(analytics.exportClickRows(NOW)).toEqual([
      { day: '2026-09-15', campaign: 'season-zero', source: 'creator_07', clicks: 2 }
    ])
    expect(Object.keys(analytics.exportClickRows(NOW)[0])).not.toContain('wake')
  })

  it('does not accept campaign attribution on in-world events or unattributed click events', () => {
    const analytics = new FunnelAnalytics()

    expect(
      analytics.record(
        { eventId: eventId(1), event: 'wake', occurredAt: NOW, campaign: 'season-zero', source: 'social' },
        NOW
      )
    ).toBe('invalid')
    expect(analytics.record({ eventId: eventId(2), event: 'click', occurredAt: NOW }, NOW)).toBe('invalid')
    expect(analytics.exportFunnelRows(NOW)).toEqual([])
    expect(analytics.exportClickRows(NOW)).toEqual([])
  })

  it('requires opaque server event IDs and rejects obvious personal identifiers', () => {
    const analytics = new FunnelAnalytics()
    const invalidIds = [
      'alice',
      'alice@example.com',
      `0x${'a'.repeat(40)}`,
      'evt_alice',
      `evt_${'a'.repeat(31)}`,
      `evt_${'a'.repeat(33)}`
    ]

    invalidIds.forEach((candidate) => {
      expect(analytics.record({ eventId: candidate, event: 'wake', occurredAt: NOW }, NOW)).toBe('invalid')
    })
    expect(analytics.record({ eventId: eventId(9), event: 'wake', occurredAt: NOW }, NOW)).toBe('recorded')
  })

  it('deduplicates opaque event IDs across click and funnel datasets', () => {
    const analytics = new FunnelAnalytics()
    const id = eventId(5)

    expect(analytics.record({ eventId: id, event: 'wake', occurredAt: NOW }, NOW)).toBe('recorded')
    expect(
      analytics.record({ eventId: id, event: 'click', occurredAt: NOW, campaign: 'other', source: 'other' }, NOW)
    ).toBe('duplicate')
    expect(analytics.exportFunnelRows(NOW)[0].wake).toBe(1)
    expect(analytics.exportClickRows(NOW)).toEqual([])
  })

  it('strictly rejects unknown fields, vocabulary, invalid attribution, and invalid timestamps', () => {
    const analytics = new FunnelAnalytics()
    const valid = { eventId: eventId(1), event: 'wake', occurredAt: NOW }

    expect(analytics.record({ ...valid, address: `0x${'a'.repeat(40)}` }, NOW)).toBe('invalid')
    expect(analytics.record({ ...valid, name: 'Alice' }, NOW)).toBe('invalid')
    expect(analytics.record({ ...valid, event: 'purchase' }, NOW)).toBe('invalid')
    expect(analytics.record({ ...valid, event: 'click', campaign: 'creator@example.com', source: 'social' }, NOW)).toBe(
      'invalid'
    )
    expect(analytics.record({ ...valid, occurredAt: Number.NaN }, NOW)).toBe('invalid')
    expect(analytics.record({ ...valid, occurredAt: NOW + 1 }, NOW)).toBe('future')
  })

  it('sorts separate aggregate exports deterministically', () => {
    const analytics = new FunnelAnalytics()
    const inputs = [
      { eventId: eventId(1), event: 'click' as const, occurredAt: NOW, campaign: 'beta', source: 'social' },
      { eventId: eventId(2), event: 'wake' as const, occurredAt: NOW - DAY },
      { eventId: eventId(3), event: 'ready' as const, occurredAt: NOW },
      { eventId: eventId(4), event: 'click' as const, occurredAt: NOW, campaign: 'alpha', source: 'event' }
    ]
    inputs.forEach((input) => expect(analytics.record(input, NOW)).toBe('recorded'))

    expect(analytics.exportFunnelRows(NOW).map(({ day }) => day)).toEqual(['2026-09-14', '2026-09-15'])
    expect(analytics.exportClickRows(NOW).map(({ campaign }) => campaign)).toEqual(['alpha', 'beta'])
  })

  it('prunes both aggregate datasets and deduplication state outside the retention window', () => {
    const analytics = new FunnelAnalytics({ retentionDays: 2, maxEventIds: 10 })
    const reusedId = eventId(1)

    expect(analytics.record({ eventId: reusedId, event: 'wake', occurredAt: NOW - DAY }, NOW)).toBe('recorded')
    expect(
      analytics.record(
        { eventId: eventId(2), event: 'click', occurredAt: NOW - 2 * DAY, campaign: 'old', source: 'old' },
        NOW
      )
    ).toBe('expired')
    expect(analytics.exportFunnelRows(NOW + DAY)).toEqual([])
    expect(analytics.exportClickRows(NOW + DAY)).toEqual([])
    expect(analytics.record({ eventId: reusedId, event: 'ready', occurredAt: NOW + DAY }, NOW + DAY)).toBe('recorded')
  })

  it('fails closed at deduplication capacity and validates constructor bounds', () => {
    const analytics = new FunnelAnalytics({ retentionDays: 2, maxEventIds: 2 })

    expect(analytics.record({ eventId: eventId(1), event: 'wake', occurredAt: NOW }, NOW)).toBe('recorded')
    expect(analytics.record({ eventId: eventId(2), event: 'wake', occurredAt: NOW }, NOW)).toBe('recorded')
    expect(analytics.record({ eventId: eventId(3), event: 'wake', occurredAt: NOW }, NOW)).toBe('capacity')
    expect(analytics.exportFunnelRows(NOW)[0].wake).toBe(2)
    expect(() => new FunnelAnalytics({ retentionDays: 0 })).toThrow(RangeError)
    expect(() => new FunnelAnalytics({ retentionDays: 367 })).toThrow(RangeError)
    expect(() => new FunnelAnalytics({ maxEventIds: 0 })).toThrow(RangeError)
    expect(() => new FunnelAnalytics({ maxEventIds: 100_001 })).toThrow(RangeError)
  })
})
