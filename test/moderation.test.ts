import { describe, expect, it } from 'vitest'
import {
  BoundedAuditLog,
  MAX_MODERATION_CONTENT_BYTES,
  ModerationAuthorizationError,
  ModerationCapacityError,
  ModerationRegistry,
  createReport,
  filterProfileName,
  normalizeDuplicateText,
  type ModerationRegistryOptions,
  type PublishInput
} from '../src/server/moderation'

const moderator = `0x${'1'.repeat(40)}`
const author = `0x${'a'.repeat(40)}`
const viewer = `0x${'b'.repeat(40)}`

function registry(overrides: Partial<ModerationRegistryOptions> = {}) {
  return new ModerationRegistry({
    now: () => 0,
    moderators: new Set([moderator.toUpperCase()]),
    trustedCreators: new Set([author.toUpperCase()]),
    auditCapacity: 50,
    contentCapacity: 20,
    fingerprintCapacity: 20,
    reportCapacity: 20,
    shadowHiddenCapacity: 20,
    publishRate: { limit: 10, windowMs: 1_000, maxAddresses: 20 },
    reportRate: { limit: 10, windowMs: 1_000, maxAddresses: 20 },
    ...overrides
  })
}

function publishInput(id: string, overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    id,
    authorAddress: author,
    content: `Performance ${id}`,
    source: 'curated',
    touringConsent: false,
    createdAt: 100,
    ...overrides
  }
}

describe('authenticated moderation boundary', () => {
  it('keeps authenticated publishing identity outside the exact request payload', () => {
    const moderation = registry()
    expect(moderation.publish(moderator, publishInput('curated'))).toMatchObject({ accepted: true })
    expect(() =>
      moderation.publish(moderator, { ...publishInput('spoofed'), actorAddress: moderator } as PublishInput)
    ).toThrow('Invalid publish input')
  })

  it('derives report identity from the principal and rejects payload identity fields', () => {
    const moderation = registry()
    moderation.publish(moderator, publishInput('ghost'))
    expect(moderation.report(viewer, { id: 'report', contentId: 'ghost', reason: 'abuse', createdAt: 1 })).toBe(
      'reported'
    )
    expect(moderation.reports()[0].reporterAddress).toBe(viewer)
    expect(() =>
      moderation.report(viewer, {
        id: 'spoofed',
        contentId: 'ghost',
        reporterAddress: author,
        reason: 'abuse',
        createdAt: 2
      })
    ).toThrow('Invalid moderation report')
  })

  it('keys publish admission by principal before authorization, duplicate, and capacity decisions', () => {
    const moderation = registry({
      auditCapacity: 2,
      publishRate: { limit: 2, windowMs: 1_000, maxAddresses: 20 }
    })
    expect(moderation.publish(viewer, publishInput('unauthorized-one'))).toEqual({
      accepted: false,
      reason: 'unauthorized'
    })
    expect(moderation.publish(viewer, publishInput('unauthorized-two'))).toEqual({
      accepted: false,
      reason: 'unauthorized'
    })
    expect(moderation.auditEntries().map((entry) => entry.action)).toEqual(['publish-rejected', 'publish-rejected'])
    expect(moderation.publish(viewer, publishInput('exhausted'))).toEqual({
      accepted: false,
      reason: 'rate-limited'
    })
    expect(moderation.auditEntries()).toHaveLength(2)
  })

  it('prevents curated multi-author rate bypass and creator principal mismatch', () => {
    const moderation = registry({ publishRate: { limit: 1, windowMs: 1_000, maxAddresses: 20 } })
    expect(moderation.publish(moderator, publishInput('first', { authorAddress: author }))).toMatchObject({
      accepted: true
    })
    expect(moderation.publish(moderator, publishInput('second', { authorAddress: viewer }))).toEqual({
      accepted: false,
      reason: 'rate-limited'
    })

    const creators = registry()
    expect(creators.publish(viewer, publishInput('mismatch', { source: 'creator', authorAddress: author }))).toEqual({
      accepted: false,
      reason: 'unauthorized'
    })
  })
})

describe('moderation publishing boundary', () => {
  it('derives curated and creator authority from configured identities', () => {
    const moderation = registry()
    expect(moderation.publish(moderator, publishInput('curated'))).toMatchObject({
      accepted: true,
      record: { channel: 'curated' }
    })
    expect(moderation.publish(author, publishInput('trusted', { source: 'creator', createdAt: 101 }))).toMatchObject({
      accepted: true,
      record: { channel: 'trusted' }
    })
    expect(
      moderation.publish(
        viewer,
        publishInput('untrusted', { source: 'creator', authorAddress: viewer, createdAt: 102 })
      )
    ).toEqual({ accepted: false, reason: 'untrusted-creator' })
    expect(moderation.publish(viewer, publishInput('spoofed', { source: 'creator', createdAt: 103 }))).toEqual({
      accepted: false,
      reason: 'unauthorized'
    })
    expect(moderation.publish(viewer, publishInput('not-curator', { createdAt: 104 }))).toEqual({
      accepted: false,
      reason: 'unauthorized'
    })
  })

  it('normalizes equivalent content through a bounded fingerprint index', () => {
    expect(normalizeDuplicateText('  The\tGHOST—Bows! ')).toBe('the ghost bows')
    expect(normalizeDuplicateText('ＴＨＥ ghost bows')).toBe('the ghost bows')
    const moderation = registry()
    expect(moderation.publish(moderator, publishInput('one', { content: 'The Ghost Bows!' }))).toMatchObject({
      accepted: true
    })
    expect(moderation.publish(moderator, publishInput('two', { content: ' the ghost—bows ', createdAt: 101 }))).toEqual(
      {
        accepted: false,
        reason: 'duplicate',
        duplicateOf: 'one'
      }
    )
  })

  it('rejects content whose duplicate fingerprint contains no letters or numbers', () => {
    const moderation = registry()

    expect(() => moderation.publish(moderator, publishInput('punctuation', { content: '!!!' }))).toThrow(
      'Content must contain letters or numbers'
    )
    expect(() => moderation.publish(moderator, publishInput('emoji', { content: '😀😀😀' }))).toThrow(
      'Content must contain letters or numbers'
    )
    expect(moderation.get('punctuation')).toBeNull()
    expect(moderation.get('emoji')).toBeNull()
  })

  it('applies the existing profile-name policy', () => {
    expect(filterProfileName('  Alice\tExample  ')).toBe('AliceExample')
    expect(filterProfileName('Al\u200bice\u2060')).toBe('Alice')
    expect(filterProfileName('HOUSE\u202e GHOST\u202c')).toBeNull()
    expect(filterProfileName('Visitor')).toBeNull()
    expect(filterProfileName('😀'.repeat(20))).toBe('😀'.repeat(8))
  })
})

describe('moderation reports', () => {
  it('runtime-validates exact unknown input and returns a frozen normalized report', () => {
    const report = createReport(author.toUpperCase(), {
      id: 'report-1',
      contentId: 'ghost-1',
      reason: 'abuse',
      createdAt: 100,
      status: 'open'
    })
    expect(report).toEqual({
      id: 'report-1',
      contentId: 'ghost-1',
      reporterAddress: author,
      reason: 'abuse',
      createdAt: 100,
      status: 'open'
    })
    expect(Object.isFrozen(report)).toBe(true)

    for (const malformed of [
      null,
      { id: 'r', contentId: 'c', reason: 'invented', createdAt: 1 },
      { id: 'r', contentId: 'c', reason: 'abuse', createdAt: 1, extra: true },
      { id: 'r', contentId: 'c', reason: 'abuse', createdAt: -1 },
      { id: 'r', contentId: 'c', reason: 'abuse', createdAt: 1, status: undefined },
      { id: 'r', contentId: 'c', reason: 'abuse', createdAt: 1, status: 'closed' }
    ]) {
      expect(() => createReport(author, malformed)).toThrow('Invalid moderation report')
    }
  })

  it('stores a frozen copy and rejects malformed input without mutation or rate consumption', () => {
    const moderation = registry({ reportRate: { limit: 1, windowMs: 1_000, maxAddresses: 20 } })
    moderation.publish(moderator, publishInput('ghost-1'))
    const beforeAudit = moderation.auditEntries()
    expect(() => moderation.report(viewer, { id: 'bad', contentId: 'ghost-1', reason: 'bad', createdAt: 101 })).toThrow(
      'Invalid moderation report'
    )
    expect(moderation.reports()).toEqual([])
    expect(moderation.auditEntries()).toEqual(beforeAudit)

    const input = { id: 'report-1', contentId: 'ghost-1', reason: 'abuse', createdAt: 102 }
    expect(moderation.report(viewer, input)).toBe('reported')
    input.id = 'mutated'
    expect(moderation.reports()[0].id).toBe('report-1')
    expect(Object.isFrozen(moderation.reports()[0])).toBe(true)
  })
})

describe('moderation lifecycle and atomicity', () => {
  it('requires moderator authority for every moderation action', () => {
    const moderation = registry()
    moderation.publish(moderator, publishInput('ghost-1', { touringConsent: true }))
    expect(() => moderation.quarantine(viewer, 'ghost-1', 101)).toThrow(ModerationAuthorizationError)
    expect(() => moderation.shadowHide(viewer, author, 101)).toThrow(ModerationAuthorizationError)
    expect(() => moderation.tombstone(viewer, 'ghost-1', 101)).toThrow(ModerationAuthorizationError)
    expect(moderation.get('ghost-1')).toMatchObject({ status: 'published' })
    expect(moderation.isVisible('ghost-1', viewer)).toBe(true)
    expect(moderation.auditEntries()).toHaveLength(1)
  })

  it('validates every audit input before lifecycle mutation', () => {
    const moderation = registry()
    moderation.publish(moderator, publishInput('ghost-1', { touringConsent: true }))
    const beforeAudit = moderation.auditEntries()
    expect(() => moderation.quarantine('', 'ghost-1', 101)).toThrow('Address is required')
    expect(() => moderation.quarantine(moderator, 'ghost-1', -1)).toThrow('Invalid timestamp')
    expect(() => moderation.shadowHide(moderator, viewer, -1)).toThrow('Invalid timestamp')
    expect(() => moderation.tombstone(moderator, 'ghost-1', -1)).toThrow('Invalid timestamp')
    expect(moderation.get('ghost-1')).toMatchObject({ status: 'published' })
    expect(moderation.isVisible('ghost-1', viewer)).toBe(true)
    expect(moderation.auditEntries()).toEqual(beforeAudit)
  })

  it('rejects invalid publish identities, timestamps, and clocks without consuming rate capacity', () => {
    let now = -1
    const moderation = registry({
      now: () => now,
      publishRate: { limit: 1, windowMs: 1_000, maxAddresses: 20 }
    })
    expect(() => moderation.publish('', publishInput('bad-actor'))).toThrow('Address is required')
    expect(() => moderation.publish(moderator, publishInput('bad-clock'))).toThrow('Invalid timestamp')
    expect(moderation.auditEntries()).toEqual([])
    expect(moderation.get('bad-clock')).toBeNull()

    now = 0
    expect(() => moderation.publish(moderator, publishInput('bad-time', { createdAt: -1 }))).toThrow(
      'Invalid timestamp'
    )
    expect(moderation.publish(moderator, publishInput('valid'))).toMatchObject({
      accepted: false,
      reason: 'rate-limited'
    })
  })

  it('quarantines, shadow-hides, tombstones, and keeps repeated actions idempotent', () => {
    const moderation = registry()
    moderation.publish(moderator, publishInput('ghost-1', { touringConsent: true }))
    moderation.shadowHide(moderator, author, 101)
    moderation.shadowHide(moderator, author.toUpperCase(), 102)
    expect(moderation.isVisible('ghost-1', viewer)).toBe(false)
    expect(moderation.isVisible('ghost-1', author)).toBe(true)
    expect(moderation.canTour('ghost-1')).toBe(false)
    moderation.quarantine(moderator, 'ghost-1', 103)
    moderation.quarantine(moderator, 'ghost-1', 104)
    expect(moderation.isVisible('ghost-1', author)).toBe(false)
    moderation.tombstone(moderator, 'ghost-1', 105)
    moderation.tombstone(moderator, 'ghost-1', 106)
    expect(moderation.get('ghost-1')).toMatchObject({ status: 'tombstoned', deletedAt: 105 })
    expect(moderation.auditEntries().map((entry) => entry.action)).toEqual([
      'published',
      'shadow-hidden',
      'quarantined',
      'tombstoned'
    ])
  })

  it('requires affirmative touring consent at authoring time', () => {
    const moderation = registry()
    moderation.publish(moderator, publishInput('opted-in', { touringConsent: true }))
    moderation.publish(moderator, publishInput('defaulted-out', { authorAddress: viewer, createdAt: 101 }))
    expect(moderation.canTour('opted-in')).toBe(true)
    expect(moderation.canTour('defaulted-out')).toBe(false)
  })
})

describe('moderation capacities and byte bounds', () => {
  it('enforces content and fingerprint capacities deterministically', () => {
    const contentBound = registry({ contentCapacity: 1, fingerprintCapacity: 2 })
    expect(contentBound.publish(moderator, publishInput('one'))).toMatchObject({ accepted: true })
    expect(contentBound.publish(moderator, publishInput('two', { createdAt: 101 }))).toEqual({
      accepted: false,
      reason: 'content-capacity'
    })
    const fingerprintBound = registry({ contentCapacity: 2, fingerprintCapacity: 1 })
    expect(fingerprintBound.publish(moderator, publishInput('one'))).toMatchObject({ accepted: true })
    expect(fingerprintBound.publish(moderator, publishInput('two', { createdAt: 101 }))).toEqual({
      accepted: false,
      reason: 'fingerprint-capacity'
    })
  })

  it('enforces report and shadow-hidden capacities without partial state', () => {
    const moderation = registry({ reportCapacity: 1, shadowHiddenCapacity: 1 })
    moderation.publish(moderator, publishInput('one'))
    moderation.publish(moderator, publishInput('two', { authorAddress: viewer, createdAt: 101 }))
    expect(moderation.report(author, { id: 'r1', contentId: 'one', reason: 'abuse', createdAt: 102 })).toBe('reported')
    expect(moderation.report(viewer, { id: 'r2', contentId: 'two', reason: 'abuse', createdAt: 103 })).toBe('capacity')
    expect(moderation.reports().map((report) => report.id)).toEqual(['r1'])
    moderation.shadowHide(moderator, author, 104)
    expect(() => moderation.shadowHide(moderator, viewer, 105)).toThrow(ModerationCapacityError)
    expect(moderation.isVisible('two', author)).toBe(true)
  })

  it('measures UTF-8 bytes and rejects overlong boundary values atomically', () => {
    const moderation = registry()
    const beforeAudit = moderation.auditEntries()
    expect(() =>
      moderation.publish(
        moderator,
        publishInput('oversized', { content: '😀'.repeat(MAX_MODERATION_CONTENT_BYTES / 4 + 1) })
      )
    ).toThrow('Content exceeds')
    expect(moderation.get('oversized')).toBeNull()
    expect(moderation.auditEntries()).toEqual(beforeAudit)
    expect(() =>
      createReport(author, { id: '😀'.repeat(33), contentId: 'one', reason: 'other', createdAt: 1 })
    ).toThrow('Invalid moderation report')
  })

  it('rejects invalid and unbounded constructor capacities', () => {
    expect(() => registry({ contentCapacity: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(() => registry({ reportCapacity: 0 })).toThrow(RangeError)
    expect(() => registry({ shadowHiddenCapacity: 100_001 })).toThrow(RangeError)
    expect(() => registry({ fingerprintCapacity: 100_001 })).toThrow(RangeError)
  })
})

describe('moderation rate limits', () => {
  it('rate-limits publishing per address and refills deterministically', () => {
    let now = 1_000
    const moderation = registry({ now: () => now, publishRate: { limit: 1, windowMs: 1_000, maxAddresses: 2 } })
    expect(moderation.publish(moderator, publishInput('one', { createdAt: 1_000 }))).toMatchObject({ accepted: true })
    now = 1_999
    expect(moderation.publish(moderator, publishInput('two', { createdAt: 1_999 }))).toEqual({
      accepted: false,
      reason: 'rate-limited'
    })
    now = 2_000
    expect(moderation.publish(moderator, publishInput('two', { createdAt: 2_000 }))).toMatchObject({ accepted: true })
  })

  it('rate-limits reports and prunes expired address buckets at the bound', () => {
    let now = 1_000
    const moderation = registry({ now: () => now, reportRate: { limit: 1, windowMs: 1_000, maxAddresses: 1 } })
    moderation.publish(moderator, publishInput('one', { createdAt: 1 }))
    moderation.publish(moderator, publishInput('two', { authorAddress: viewer, createdAt: 2 }))
    expect(moderation.report(author, { id: 'r1', contentId: 'one', reason: 'abuse', createdAt: 1_000 })).toBe(
      'reported'
    )
    now = 1_999
    expect(moderation.report(author, { id: 'r2', contentId: 'one', reason: 'abuse', createdAt: 1_999 })).toBe(
      'rate-limited'
    )
    now = 2_000
    expect(moderation.report(viewer, { id: 'r3', contentId: 'two', reason: 'abuse', createdAt: 2_000 })).toBe(
      'reported'
    )
  })
})

describe('bounded audit log', () => {
  it('is failure-atomic, append-only, monotonically sequenced, and bounded', () => {
    const log = new BoundedAuditLog(2)
    expect(() => log.append({ action: 'published', actorAddress: '', subjectId: 'one', createdAt: 1 })).toThrow(
      'Address is required'
    )
    expect(log.entries()).toEqual([])
    const first = log.append({ action: 'published', actorAddress: moderator, subjectId: 'one', createdAt: 1 })
    log.append({ action: 'reported', actorAddress: viewer, subjectId: 'one', createdAt: 2 })
    log.append({ action: 'quarantined', actorAddress: moderator, subjectId: 'one', createdAt: 3 })
    expect(first.sequence).toBe(1)
    expect(log.entries().map((entry) => entry.sequence)).toEqual([2, 3])
    expect(Object.isFrozen(log.entries()[0])).toBe(true)
    const snapshot = log.entries()
    snapshot.pop()
    expect(log.entries()).toHaveLength(2)
  })
})
