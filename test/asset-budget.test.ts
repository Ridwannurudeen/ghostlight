import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORLD_NAME } from '../src/shared/config'

const ROOT = join(import.meta.dirname, '..')
const ASSETS = join(ROOT, 'assets')
const MODELS = join(ASSETS, 'models')
const SOUNDS = join(ASSETS, 'sounds')
const UI = join(ASSETS, 'ui')
const SCENE = join(ROOT, 'scene.json')
const COMPOSITE = join(ASSETS, 'scene', 'main.composite')
const THEATER_SOURCE = join(ROOT, 'src', 'client', 'theater.ts')
const REWARD_SOURCE = join(ROOT, 'src', 'client', 'rewards.ts')

const MODEL_FILES = [
  'chandelier.glb',
  'curtain_left.glb',
  'curtain_right.glb',
  'footlight.glb',
  'foyer_doors.glb',
  'marquee.glb',
  'pedestal.glb',
  'poster_frame.glb',
  'proscenium.glb',
  'prop_mask.glb',
  'prop_tophat.glb',
  'prop_trophy.glb',
  'seat_row.glb',
  'spotlight_cone.glb',
  'stage.glb'
] as const

const SOUND_FILES = [
  'applause.mp3',
  'curtain.mp3',
  'drumroll.mp3',
  'gasp.mp3',
  'hit.mp3',
  'miss.mp3',
  'room_tone.mp3',
  'stamp.mp3',
  'sting.mp3',
  'tick.mp3',
  'unlock.mp3'
] as const

const UI_FILES = [
  'button_disabled.png',
  'button_primary.png',
  'button_secondary.png',
  'card.png',
  'card_selected.png',
  'marquee.png',
  'panel.png',
  'ribbon.png',
  'stamp.png'
] as const

const THEATER_MODEL_INSTANCES: Record<string, number> = {
  'chandelier.glb': 1,
  'curtain_left.glb': 1,
  'curtain_right.glb': 1,
  'footlight.glb': 4,
  'foyer_doors.glb': 1,
  'marquee.glb': 1,
  'pedestal.glb': 1,
  'poster_frame.glb': 2,
  'proscenium.glb': 1,
  'seat_row.glb': 6,
  'spotlight_cone.glb': 1,
  'stage.glb': 1
}

type GlbJson = {
  accessors?: Array<{ count?: number }>
  extensionsRequired?: string[]
  extensionsUsed?: string[]
  materials?: Array<{ name?: string }>
  meshes?: Array<{
    primitives?: Array<{
      attributes?: { POSITION?: number }
      extensions?: Record<string, unknown>
      indices?: number
      mode?: number
    }>
  }>
}

function parseGlb(file: string) {
  const bytes = readFileSync(file)
  expect(bytes.readUInt32LE(0), file).toBe(0x46546c67)
  expect(bytes.readUInt32LE(4), file).toBe(2)
  expect(bytes.readUInt32LE(8), file).toBe(bytes.byteLength)

  let json: GlbJson | null = null
  for (let offset = 12; offset < bytes.byteLength; ) {
    const chunkLength = bytes.readUInt32LE(offset)
    const chunkType = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(
        bytes
          .subarray(start, start + chunkLength)
          .toString('utf8')
          .trim()
      ) as GlbJson
    }
    offset = start + chunkLength
  }
  expect(json, file).not.toBeNull()

  const document = json!
  const triangles = (document.meshes ?? []).reduce(
    (modelTotal, mesh) =>
      modelTotal +
      (mesh.primitives ?? []).reduce((meshTotal, primitive) => {
        expect(primitive.mode ?? 4, file).toBe(4)
        const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION
        expect(accessorIndex, file).toBeTypeOf('number')
        const count = document.accessors?.[accessorIndex!]?.count
        expect(count, file).toBeTypeOf('number')
        expect(count! % 3, file).toBe(0)
        return meshTotal + count! / 3
      }, 0),
    0
  )
  const extensions = new Set([...(document.extensionsUsed ?? []), ...(document.extensionsRequired ?? [])])
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      for (const name of Object.keys(primitive.extensions ?? {})) extensions.add(name)
    }
  }

  return {
    bytes: bytes.byteLength,
    materials: (document.materials ?? []).map((material) => material.name ?? ''),
    triangles,
    usesDraco: extensions.has('KHR_draco_mesh_compression')
  }
}

function parsePng(file: string) {
  const bytes = readFileSync(file)
  expect(bytes.subarray(0, 8), file).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(bytes.subarray(12, 16).toString('ascii'), file).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const SAMPLE_RATES = [44_100, 48_000, 32_000]

function parseMp3(file: string) {
  const bytes = readFileSync(file)
  let offset = 0
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
    offset = 10 + size + (bytes[5] & 0x10 ? 10 : 0)
  }

  let frames = 0
  let sampleRate = 0
  let firstFrameOffset = -1
  while (offset + 4 <= bytes.byteLength) {
    if (bytes.subarray(offset, offset + 3).toString('ascii') === 'TAG') break
    const first = bytes[offset]
    const second = bytes[offset + 1]
    const third = bytes[offset + 2]
    const fourth = bytes[offset + 3]
    if (first !== 0xff || (second & 0xe0) !== 0xe0) break

    expect((second >> 3) & 0x3, file).toBe(3)
    expect((second >> 1) & 0x3, file).toBe(1)
    const bitrate = BITRATES_KBPS[third >> 4]
    const rate = SAMPLE_RATES[(third >> 2) & 0x3]
    expect(bitrate, file).toBeGreaterThan(0)
    expect(rate, file).toBe(44_100)
    expect(fourth >> 6, file).toBe(3)

    if (firstFrameOffset < 0) firstFrameOffset = offset
    sampleRate = rate
    const padding = (third >> 1) & 0x1
    offset += Math.floor((144_000 * bitrate) / rate) + padding
    frames += 1
  }

  expect(frames, file).toBeGreaterThan(0)
  const firstHeaderSecond = bytes[firstFrameOffset + 1]
  const firstHeaderFourth = bytes[firstFrameOffset + 3]
  const hasCrc = (firstHeaderSecond & 0x1) === 0
  const sideInfoBytes = firstHeaderFourth >> 6 === 3 ? 17 : 32
  const xingOffset = firstFrameOffset + 4 + (hasCrc ? 2 : 0) + sideInfoBytes
  expect(bytes.subarray(xingOffset, xingOffset + 4).toString('ascii'), file).toMatch(/^(Info|Xing)$/)

  const xingFlags = bytes.readUInt32BE(xingOffset + 4)
  let encoderOffset = xingOffset + 8
  const audioFrames = xingFlags & 0x1 ? bytes.readUInt32BE(encoderOffset) : frames - 1
  if (xingFlags & 0x1) encoderOffset += 4
  if (xingFlags & 0x2) encoderOffset += 4
  if (xingFlags & 0x4) encoderOffset += 100
  if (xingFlags & 0x8) encoderOffset += 4
  expect(bytes.subarray(encoderOffset, encoderOffset + 4).toString('ascii'), file).toMatch(/^(LAME|Lavc)$/)

  const delayAndPadding = bytes.readUIntBE(encoderOffset + 21, 3)
  const encoderDelay = delayAndPadding >> 12
  const endPadding = delayAndPadding & 0xfff
  expect(audioFrames, file).toBe(frames - 1)
  const decodedSamples = audioFrames * 1152 - encoderDelay - endPadding
  expect(decodedSamples, file).toBeGreaterThan(0)

  return {
    bytes: bytes.byteLength,
    decodedSamples,
    durationSeconds: decodedSamples / sampleRate,
    sampleRate
  }
}

function getTheaterSourceInstanceCounts() {
  const source = readFileSync(THEATER_SOURCE, 'utf8')
  const counts: Record<string, number> = {}
  for (const file of Object.keys(THEATER_MODEL_INSTANCES)) {
    counts[file] = source.split(`createModel('${file}'`).length - 1
  }

  const seatLoop = source.match(/for \(const z of \[([^\]]+)\]\) \{\s*createModel\('seat_row\.glb'/)
  const footlightLoop = source.match(
    /for \(const x of \[([^\]]+)\]\) \{\s*const footlight = createModel\('footlight\.glb'/
  )
  expect(seatLoop).not.toBeNull()
  expect(footlightLoop).not.toBeNull()
  counts['seat_row.glb'] = seatLoop![1].split(',').length
  counts['footlight.glb'] = footlightLoop![1].split(',').length
  return counts
}

function directoryBytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name)
    return total + (entry.isDirectory() ? directoryBytes(child) : statSync(child).size)
  }, 0)
}

describe('generated asset budget', () => {
  it('keeps every generated GLB within the mobile geometry and material budget', () => {
    expect(
      readdirSync(MODELS)
        .filter((file) => file.endsWith('.glb'))
        .sort()
    ).toEqual([...MODEL_FILES].sort())

    const uniqueMaterials = new Set<string>()
    const metrics = new Map<string, ReturnType<typeof parseGlb>>()
    let totalTriangles = 0
    for (const file of MODEL_FILES) {
      const model = parseGlb(join(MODELS, file))
      metrics.set(file, model)
      expect(model.triangles, file).toBeLessThanOrEqual(3_000)
      expect(model.materials.length, file).toBeLessThanOrEqual(3)
      expect(model.usesDraco, file).toBe(false)
      model.materials.forEach((material) => uniqueMaterials.add(material))
      totalTriangles += model.triangles
    }

    expect(totalTriangles).toBeLessThanOrEqual(40_000)
    expect(uniqueMaterials.size).toBeLessThanOrEqual(12)

    const manifest = JSON.parse(readFileSync(join(MODELS, 'manifest.json'), 'utf8')) as {
      models: Array<{ file: string; triangles: number; materials: string[]; bytes: number }>
      totals: { triangles: number; materials: string[]; bytes: number }
    }
    expect(manifest.models.map((model) => model.file).sort()).toEqual([...MODEL_FILES].sort())
    for (const entry of manifest.models) {
      const model = metrics.get(entry.file)!
      expect(entry, entry.file).toEqual({
        file: entry.file,
        triangles: model.triangles,
        materials: model.materials,
        bytes: model.bytes
      })
    }
    expect(manifest.totals).toEqual({
      triangles: totalTriangles,
      materials: [...uniqueMaterials].sort(),
      bytes: [...metrics.values()].reduce((total, model) => total + model.bytes, 0)
    })
  })

  it('keeps every generated UI texture power-of-two and at most 1024 pixels per side', () => {
    expect(
      readdirSync(UI)
        .filter((file) => file.endsWith('.png'))
        .sort()
    ).toEqual([...UI_FILES].sort())
    for (const file of UI_FILES) {
      const { width, height } = parsePng(join(UI, file))
      expect(width & (width - 1), file).toBe(0)
      expect(height & (height - 1), file).toBe(0)
      expect(width, file).toBeLessThanOrEqual(1024)
      expect(height, file).toBeLessThanOrEqual(1024)
    }
  })

  it('keeps generated sounds mono at 44.1 kHz and inside duration and byte budgets', () => {
    expect(
      readdirSync(SOUNDS)
        .filter((file) => file.endsWith('.mp3'))
        .sort()
    ).toEqual([...SOUND_FILES].sort())
    let totalSoundBytes = 0
    const metrics = new Map<string, ReturnType<typeof parseMp3>>()
    for (const file of SOUND_FILES) {
      const sound = parseMp3(join(SOUNDS, file))
      metrics.set(file, sound)
      const limit = file === 'room_tone.mp3' ? 15.1 : 3.1
      expect(sound.durationSeconds, file).toBeLessThanOrEqual(limit)
      totalSoundBytes += sound.bytes
    }
    expect(totalSoundBytes).toBeLessThan(2 * 1024 * 1024)

    const manifest = JSON.parse(readFileSync(join(SOUNDS, 'manifest.json'), 'utf8')) as {
      sounds: Array<{
        file: string
        durationSeconds: number
        decodedSamples: number
        sampleRate: number
        channels: number
        peakDbfs: number
        bytes: number
        loopBoundaryDeltaDbfs?: number
        loopBoundaryP99Ratio?: number
      }>
      totals: { bytes: number }
    }
    expect(manifest.sounds.map((sound) => sound.file).sort()).toEqual([...SOUND_FILES].sort())
    for (const entry of manifest.sounds) {
      const sound = metrics.get(entry.file)!
      expect(entry.decodedSamples, entry.file).toBe(sound.decodedSamples)
      expect(entry.durationSeconds, entry.file).toBeCloseTo(sound.durationSeconds, 3)
      expect(entry.sampleRate, entry.file).toBe(sound.sampleRate)
      expect(entry.channels, entry.file).toBe(1)
      expect(entry.peakDbfs, entry.file).toBeGreaterThan(-3)
      expect(entry.peakDbfs, entry.file).toBeLessThan(-1)
      expect(entry.bytes, entry.file).toBe(sound.bytes)
    }
    expect(new Set(manifest.sounds.map((sound) => sound.peakDbfs)).size).toBeGreaterThan(1)
    expect(manifest.totals.bytes).toBe(totalSoundBytes)

    const roomTone = manifest.sounds.find((sound) => sound.file === 'room_tone.mp3')!
    expect(roomTone.loopBoundaryDeltaDbfs).toBeLessThanOrEqual(-30)
    expect(roomTone.loopBoundaryP99Ratio).toBeLessThanOrEqual(1)
  })

  it('keeps instantiated theater geometry inside the declared parcel budget', () => {
    expect(getTheaterSourceInstanceCounts()).toEqual(THEATER_MODEL_INSTANCES)

    const scene = JSON.parse(readFileSync(SCENE, 'utf8')) as {
      authoritativeMultiplayer?: boolean
      display?: { favicon?: string }
      contact?: { email?: string }
      scene: { base: string; parcels: string[] }
      spawnPoints: Array<{ position: { x: number[]; y: number[]; z: number[] } }>
      worldConfiguration?: { name?: string; fixedAdapter?: string; placesConfig?: { optOut?: boolean } }
    }
    const manifest = JSON.parse(readFileSync(join(MODELS, 'manifest.json'), 'utf8')) as {
      models: Array<{ file: string; triangles: number }>
    }
    const triangles = new Map(manifest.models.map((model) => [model.file, model.triangles]))
    const instantiatedTriangles = Object.entries(THEATER_MODEL_INSTANCES).reduce(
      (total, [file, instances]) => total + triangles.get(file)! * instances,
      0
    )
    const rewardSource = readFileSync(REWARD_SOURCE, 'utf8')
    const rewardCapMatch = rewardSource.match(/export const MAX_VISIBLE_REWARD_PROPS = (\d+)/)
    expect(rewardCapMatch).not.toBeNull()
    const visibleRewardCap = Number(rewardCapMatch![1])
    const maxRewardTriangles = Math.max(
      triangles.get('prop_tophat.glb')!,
      triangles.get('prop_mask.glb')!,
      triangles.get('prop_trophy.glb')!
    )
    const maxRewardInstances = visibleRewardCap + 1
    const peakTriangles = instantiatedTriangles + maxRewardInstances * maxRewardTriangles
    const peakEntities = 45 + maxRewardInstances * 2

    expect(instantiatedTriangles).toBe(11_664)
    expect(visibleRewardCap).toBe(16)
    expect(peakTriangles).toBe(16_492)
    expect(peakEntities).toBe(79)
    expect(instantiatedTriangles).toBeLessThanOrEqual(scene.scene.parcels.length * 10_000)
    expect(peakTriangles).toBeLessThanOrEqual(scene.scene.parcels.length * 10_000)
    expect(peakEntities).toBeLessThanOrEqual(scene.scene.parcels.length * 200)
    expect(scene.scene.parcels).toEqual(['0,0', '1,0'])
    expect(scene.authoritativeMultiplayer).toBe(true)
    expect(scene.worldConfiguration).toEqual({ name: WORLD_NAME })
    expect(scene.worldConfiguration?.fixedAdapter).toBeUndefined()
    expect(scene.worldConfiguration?.placesConfig?.optOut).toBeUndefined()
    expect(scene.display?.favicon).toBeUndefined()
    expect(scene.contact?.email).toBeUndefined()

    const spawn = scene.spawnPoints[0].position
    for (const x of spawn.x) {
      for (const z of spawn.z) {
        const distanceSquared = (x - 8) ** 2 + (z - 3.6) ** 2
        expect(distanceSquared, `spawn corner (${x}, ${z})`).toBeLessThanOrEqual(6.1 ** 2)
      }
    }

    const composite = JSON.parse(readFileSync(COMPOSITE, 'utf8')) as {
      components: Array<{ name: string; data?: Record<string, { json: Record<string, unknown> }> }>
    }
    const metadata = composite.components.find((component) => component.name === 'inspector::SceneMetadata')
      ?.data?.['0'].json as {
      email?: string
      layout: { base: { x: number; y: number }; parcels: Array<{ x: number; y: number }> }
      spawnPoints: Array<{
        position: Record<'x' | 'y' | 'z', { $case: string; value: number[] }>
      }>
    }
    expect(metadata.email).toBeUndefined()
    expect(metadata.layout).toEqual({
      base: { x: 0, y: 0 },
      parcels: [
        { x: 0, y: 0 },
        { x: 1, y: 0 }
      ]
    })
    expect(metadata.spawnPoints[0].position.x.value).toEqual(spawn.x)
    expect(metadata.spawnPoints[0].position.y.value).toEqual(spawn.y)
    expect(metadata.spawnPoints[0].position.z.value).toEqual(spawn.z)
  })

  it('keeps the complete assets directory below 25 MB', () => {
    expect(directoryBytes(ASSETS)).toBeLessThan(25 * 1024 * 1024)
  })
})
