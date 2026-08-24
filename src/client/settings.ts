import type { Language } from '../shared/i18n'

export type SoundVolume = 0.5 | 1

export type ClientSettings = Readonly<{
  soundEnabled: boolean
  soundVolume: SoundVolume
  language: Language
  reducedMotion: boolean
  largeText: boolean
}>

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  soundEnabled: true,
  soundVolume: 1,
  language: 'en',
  reducedMotion: false,
  largeText: false
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
    nextSettings.largeText === settings.largeText
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
