import { describe, expect, it } from 'vitest'
import { extractWorldName, npmInvocation, validateConfigWorldName, validateScene } from '../tools/preflight.mjs'

function goodScene() {
  return {
    display: {
      title: 'Ghostlight',
      description: 'A social charades World.',
      navmapThumbnail: 'images/scene-thumbnail.png'
    },
    scene: {
      base: '0,0',
      parcels: ['0,0', '1,0']
    },
    spawnPoints: [
      {
        position: {
          x: [6, 10],
          y: [0, 0],
          z: [1, 3]
        }
      }
    ],
    worldConfiguration: {
      name: 'ghostlight.dcl.eth'
    },
    authoritativeMultiplayer: true
  }
}

function resultsById(scene: unknown) {
  return new Map(validateScene(scene).map((result) => [result.id, result]))
}

describe('deploy preflight validation', () => {
  it('runs npm through the CLI entrypoint supplied by npm', () => {
    expect(npmInvocation(['test'], 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js', 'node.exe')).toEqual({
      command: 'node.exe',
      args: ['C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js', 'test']
    })
  })

  it('accepts a complete scene fixture', () => {
    expect(validateScene(goodScene()).every((result) => result.status === 'PASS')).toBe(true)
  })

  it('rejects bad World, multiplayer, adapter, places, parcel, spawn, and display values', () => {
    const scene = goodScene()
    scene.worldConfiguration = {
      name: '<' + 'WORLD NAME' + '>',
      fixedAdapter: 'ws-room:example',
      placesConfig: { optOut: false }
    } as typeof scene.worldConfiguration
    scene.authoritativeMultiplayer = false
    scene.scene.parcels = ['0,0']
    scene.spawnPoints[0].position.x = [20, 24]
    scene.display.title = ' '
    scene.display.description = ''
    scene.display.navmapThumbnail = ''

    const results = resultsById(scene)
    expect(
      [
        'world-name',
        'authoritative-multiplayer',
        'fixed-adapter',
        'places-opt-out',
        'spawn-points',
        'display-metadata'
      ].map((id) => results.get(id)?.status)
    ).toEqual(['FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL'])
  })

  it('rejects missing and malformed parcel declarations', () => {
    const missing = goodScene()
    missing.scene.parcels = []
    expect(resultsById(missing).get('parcels')?.status).toBe('FAIL')

    const malformed = goodScene()
    malformed.scene.parcels = ['0,0', 'not-a-parcel']
    expect(resultsById(malformed).get('parcels')?.status).toBe('FAIL')
  })

  it('rejects a spawn range that crosses a missing parcel in the footprint', () => {
    const scene = goodScene()
    scene.scene.parcels = ['0,0', '1,0', '0,1']
    scene.spawnPoints[0].position.x = [1, 31]
    scene.spawnPoints[0].position.z = [1, 31]

    expect(resultsById(scene).get('spawn-points')?.status).toBe('FAIL')
  })

  it('extracts and matches a literal WORLD_NAME exactly', () => {
    const scene = goodScene()
    const source = "export const WORLD_NAME = 'ghostlight.dcl.eth'\n"

    expect(extractWorldName(source)).toBe('ghostlight.dcl.eth')
    expect(validateConfigWorldName(scene, source).status).toBe('PASS')
    expect(validateConfigWorldName(scene, "export const WORLD_NAME = 'other.dcl.eth'\n").status).toBe('FAIL')
  })

  it('rejects a computed or missing WORLD_NAME', () => {
    const scene = goodScene()

    expect(extractWorldName("export const WORLD_NAME = prefix + '.dcl.eth'\n")).toBeNull()
    expect(validateConfigWorldName(scene, "export const WORLD_NAME = prefix + '.dcl.eth'\n").status).toBe('FAIL')
    expect(validateConfigWorldName(scene, '').status).toBe('FAIL')
  })
})
