import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CLIENT_SETTINGS,
  getClientSettings,
  subscribeClientSettings,
  updateClientSettings
} from '../src/client/settings'

describe('client settings', () => {
  beforeEach(() => {
    updateClientSettings(DEFAULT_CLIENT_SETTINGS)
  })

  it('updates session settings and notifies subscribers only when a value changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeClientSettings(listener)

    updateClientSettings({
      soundEnabled: false,
      soundVolume: 0.5,
      language: 'es',
      reducedMotion: true,
      largeText: true
    })
    updateClientSettings({ largeText: true })

    expect(getClientSettings()).toEqual({
      soundEnabled: false,
      soundVolume: 0.5,
      language: 'es',
      reducedMotion: true,
      largeText: true
    })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    updateClientSettings(DEFAULT_CLIENT_SETTINGS)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
