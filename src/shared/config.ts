export const WORLD_NAME = 'ghostlight.dcl.eth'
export const INVITE_URL = 'https://decentraland.org/jump/?realm=' + WORLD_NAME

export const EMOTE_STEP_SECONDS = 2.5
export const MAX_GHOSTS = 8
export const AUDIENCE_SEATS = 6
export const HEARTBEAT_SECONDS = 2
export const FLUSH_SECONDS = 30
export const AUTHOR_COOLDOWN_SECONDS = 60
export const HYDRATION_DAYS = 14
export const PROTOCOL_VERSION = 6
export const WIRE_INT_MAX = 2_147_483_647
export const DIAGNOSTICS_DEFAULT_ENABLED = false

export const THEMES = [
  { id: 'everyday', label: 'Everyday Escapades', accent: { r: 0.06, g: 0.88, b: 1 } },
  { id: 'feelings', label: 'Big Feelings', accent: { r: 0.96, g: 0.36, b: 0.52 } },
  { id: 'food', label: 'Kitchen Capers', accent: { r: 1, g: 0.65, b: 0.18 } },
  { id: 'dcl-life', label: 'Decentraland Life', accent: { r: 0.46, g: 0.86, b: 0.5 } },
  { id: 'pop', label: 'Pop Spectacles', accent: { r: 0.7, g: 0.48, b: 1 } },
  { id: 'awkward', label: 'Awkward Moments', accent: { r: 1, g: 0.82, b: 0.3 } }
] as const

export type ThemeId = (typeof THEMES)[number]['id']

export const TITLES = ['Understudy', 'Scene Stealer', 'Ghostlight Legend'] as const

export type PlayerTitle = '' | (typeof TITLES)[number]

export const REWARD_PROPS: Record<Exclude<PlayerTitle, ''>, string> = {
  Understudy: 'assets/models/prop_tophat.glb',
  'Scene Stealer': 'assets/models/prop_mask.glb',
  'Ghostlight Legend': 'assets/models/prop_trophy.glb'
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000

export function themeForTimestamp(timestamp: number) {
  const dayIndex = Math.floor(timestamp / DAY_MILLISECONDS)
  return THEMES[((dayIndex % THEMES.length) + THEMES.length) % THEMES.length]
}
