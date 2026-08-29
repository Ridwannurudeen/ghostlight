import { describe, expect, it } from 'vitest'
import {
  FUNNEL_EVENTS,
  parseAnalyticsEvent,
  parseModerationDecision,
  parseModerationReport,
  parsePublishSubject,
  normalizeAddress
} from '../src/contracts.js'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const eventId = (value: number) => `evt_${value.toString(16).padStart(32, '0')}`
const moderator = `0x${'1'.repeat(40)}`

describe('analytics contracts', () => {
  it('keeps click attribution separate from unattributed in-world funnel events', () => {
    expect(
      parseAnalyticsEvent({
        eventId: eventId(1),
        event: 'click',
        occurredAt: NOW,
        campaign: 'Season-Zero',
        source: 'Creator_07'
      })
    ).toEqual({
      eventId: eventId(1),
      event: 'click',
      occurredAt: NOW,
      campaign: 'season-zero',
      source: 'creator_07',
      kind: 'click'
    })

    for (const event of FUNNEL_EVENTS) {
      expect(
        parseAnalyticsEvent({ eventId: eventId(FUNNEL_EVENTS.indexOf(event) + 2), event, occurredAt: NOW })
      ).toEqual({ eventId: eventId(FUNNEL_EVENTS.indexOf(event) + 2), event, occurredAt: NOW, kind: 'funnel' })
    }
    expect(() =>
      parseAnalyticsEvent({
        eventId: eventId(20),
        event: 'wake',
        occurredAt: NOW,
        campaign: 'season-zero',
        source: 'creator-07'
      })
    ).toThrow('Invalid analytics event')
  })

  it('requires exact opaque IDs, timestamps, aggregate tags, and own fields', () => {
    for (const malformed of [
      { eventId: 'alice', event: 'wake', occurredAt: NOW },
      { eventId: `0x${'a'.repeat(40)}`, event: 'wake', occurredAt: NOW },
      { eventId: eventId(1), event: 'purchase', occurredAt: NOW },
      { eventId: eventId(1), event: 'click', occurredAt: NOW },
      { eventId: eventId(1), event: 'click', occurredAt: NOW, campaign: 'person@example.com', source: 'social' },
      { eventId: eventId(1), event: 'wake', occurredAt: -1 },
      { eventId: eventId(1), event: 'wake', occurredAt: NOW, actorAddress: moderator }
    ]) {
      expect(() => parseAnalyticsEvent(malformed)).toThrow('Invalid analytics event')
    }
  })
})

describe('moderation contracts', () => {
  it('normalizes only exact Ethereum-shaped authenticated addresses', () => {
    expect(normalizeAddress(moderator.toUpperCase())).toBe(moderator)
    for (const malformed of ['alice', `0x${'1'.repeat(39)}`, `0x${'1'.repeat(41)}`, ` ${moderator}`]) {
      expect(() => normalizeAddress(malformed)).toThrow('Invalid address')
    }
  })

  it('normalizes a strict wallet-authored subject without accepting actor identity in the body', () => {
    expect(
      parsePublishSubject({
        id: ' performance-1 ',
        content: '  The ghost bows.  ',
        touringConsent: true,
        createdAt: NOW
      })
    ).toEqual({
      id: 'performance-1',
      content: 'The ghost bows.',
      channel: 'untrusted',
      touringConsent: true,
      createdAt: NOW
    })
    expect(() =>
      parsePublishSubject({
        id: 'performance-1',
        authorAddress: moderator,
        content: 'The ghost bows.',
        touringConsent: true,
        createdAt: NOW
      })
    ).toThrow('Invalid publish subject')
    for (const assertedProvenance of [
      { source: 'curated' },
      { source: 'trusted' },
      { channel: 'curated' },
      { channel: 'trusted' }
    ]) {
      expect(() =>
        parsePublishSubject({
          id: 'performance-1',
          content: 'The ghost bows.',
          touringConsent: true,
          createdAt: NOW,
          ...assertedProvenance
        })
      ).toThrow('Invalid publish subject')
    }
  })

  it('enforces exact UTF-8 byte, type, and timestamp rules on subjects and reports', () => {
    expect(() =>
      parsePublishSubject({
        id: 'performance-1',
        content: '😀'.repeat(1_025),
        touringConsent: false,
        createdAt: NOW
      })
    ).toThrow('4096 UTF-8 bytes')
    expect(
      parseModerationReport({ id: 'report-1', contentId: 'performance-1', reason: 'abuse', createdAt: NOW })
    ).toEqual({ id: 'report-1', contentId: 'performance-1', reason: 'abuse', createdAt: NOW, status: 'open' })
    expect(() =>
      parseModerationReport({
        id: 'report-1',
        contentId: 'performance-1',
        reporterAddress: moderator,
        reason: 'abuse',
        createdAt: NOW
      })
    ).toThrow('Invalid moderation report')
  })

  it('accepts only bounded moderator decisions and keeps the authenticated moderator out of the body', () => {
    expect(
      parseModerationDecision({
        id: 'decision-1',
        subjectId: 'performance-1',
        action: 'quarantined',
        reason: 'Confirmed abuse report',
        createdAt: NOW
      })
    ).toEqual({
      id: 'decision-1',
      subjectId: 'performance-1',
      action: 'quarantined',
      reason: 'Confirmed abuse report',
      createdAt: NOW
    })
    expect(() =>
      parseModerationDecision({
        id: 'decision-1',
        subjectId: 'performance-1',
        action: 'quarantined',
        reason: 'Confirmed abuse report',
        actorAddress: moderator,
        createdAt: NOW
      })
    ).toThrow('Invalid moderation decision')
  })
})
