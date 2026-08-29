import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../src/shared/config'

describe('foundation', () => {
  it('uses protocol version four', () => {
    expect(PROTOCOL_VERSION).toBe(4)
  })
})
