import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../src/shared/config'

describe('foundation', () => {
  it('uses protocol version two', () => {
    expect(PROTOCOL_VERSION).toBe(2)
  })
})
