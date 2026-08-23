import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const ASSETS = join(ROOT, 'assets')
const MODELS = join(ASSETS, 'models')
const SOUNDS = join(ASSETS, 'sounds')
const UI = join(ASSETS, 'ui')

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

    sampleRate = rate
    const padding = (third >> 1) & 0x1
    offset += Math.floor((144_000 * bitrate) / rate) + padding
    frames += 1
  }

  expect(frames, file).toBeGreaterThan(0)
  return { bytes: bytes.byteLength, durationSeconds: (frames * 1152) / sampleRate }
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
    for (const file of SOUND_FILES) {
      const sound = parseMp3(join(SOUNDS, file))
      const limit = file === 'room_tone.mp3' ? 15.1 : 3.1
      expect(sound.durationSeconds, file).toBeLessThanOrEqual(limit)
      totalSoundBytes += sound.bytes
    }
    expect(totalSoundBytes).toBeLessThan(2 * 1024 * 1024)
  })

  it('keeps the complete assets directory below 25 MB', () => {
    expect(directoryBytes(ASSETS)).toBeLessThan(25 * 1024 * 1024)
  })
})
