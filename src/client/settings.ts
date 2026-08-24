import type { Language } from '../shared/i18n'
import { DIAGNOSTICS_DEFAULT_ENABLED } from '../shared/config'

export type SoundVolume = 0.5 | 1

export type ClientSettings = Readonly<{
  soundEnabled: boolean
  soundVolume: SoundVolume
  language: Language
  reducedMotion: boolean
  largeText: boolean
  diagnosticsEnabled: boolean
}>

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  soundEnabled: true,
  soundVolume: 1,
  language: 'en',
  reducedMotion: false,
  largeText: false,
  diagnosticsEnabled: DIAGNOSTICS_DEFAULT_ENABLED
}

type SettingsListener = (settings: ClientSettings) => void

let settings = DEFAULT_CLIENT_SETTINGS
const listeners = new Set<SettingsListener>()

export function getClientSettings() {
  return settings
}

export function updateClientSettings(patch: Partial<ClientSettings>) {
  const nextSettings = { ...settings, ...patch }
  if (
    nextSettings.soundEnabled === settings.soundEnabled &&
    nextSettings.soundVolume === settings.soundVolume &&
    nextSettings.language === settings.language &&
    nextSettings.reducedMotion === settings.reducedMotion &&
    nextSettings.largeText === settings.largeText &&
    nextSettings.diagnosticsEnabled === settings.diagnosticsEnabled
  ) {
    return settings
  }

  settings = nextSettings
  for (const listener of listeners) listener(settings)
  return settings
}

export function subscribeClientSettings(listener: SettingsListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
