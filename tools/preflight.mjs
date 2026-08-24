import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PARCEL_SIZE = 16
const OPEN_ANGLE = String.fromCharCode(60)
const CLOSE_ANGLE = String.fromCharCode(62)
const OWNER_WORLD_SLOT = `${OPEN_ANGLE}WORLD LINK${CLOSE_ANGLE}`
const OWNER_MEASURED_SLOT = `${OPEN_ANGLE}MEASURED: ...${CLOSE_ANGLE}`

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasOwn(value, key) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function check(id, label, ok, detail, action) {
  return { id, label, status: ok ? 'PASS' : 'FAIL', detail, action: ok ? undefined : action }
}

function parseParcel(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^(-?\d+),(-?\d+)$/)
  if (!match) return null
  return { x: Number(match[1]), z: Number(match[2]) }
}

function axisExtent(value) {
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0 || values.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    return null
  }
  return { minimum: Math.min(...values), maximum: Math.max(...values) }
}

function samplesAcrossExtent(extent) {
  const coordinates = [extent.minimum, extent.maximum]
  const firstBoundary = Math.ceil(extent.minimum / PARCEL_SIZE) * PARCEL_SIZE
  for (let boundary = firstBoundary; boundary < extent.maximum; boundary += PARCEL_SIZE) {
    if (boundary > extent.minimum) coordinates.push(boundary)
  }
  coordinates.sort((left, right) => left - right)

  const samples = [...coordinates]
  for (let index = 1; index < coordinates.length; index += 1) {
    samples.push((coordinates[index - 1] + coordinates[index]) / 2)
  }
  return samples
}

function spawnIsInsideParcels(spawnPoint, parcels, base) {
  if (!isRecord(spawnPoint) || !isRecord(spawnPoint.position)) return false
  const xExtent = axisExtent(spawnPoint.position.x)
  const yExtent = axisExtent(spawnPoint.position.y)
  const zExtent = axisExtent(spawnPoint.position.z)
  if (!xExtent || !yExtent || !zExtent) return false

  const localParcels = parcels.map((parcel) => ({
    minimumX: (parcel.x - base.x) * PARCEL_SIZE,
    maximumX: (parcel.x - base.x + 1) * PARCEL_SIZE,
    minimumZ: (parcel.z - base.z) * PARCEL_SIZE,
    maximumZ: (parcel.z - base.z + 1) * PARCEL_SIZE
  }))

  for (const x of samplesAcrossExtent(xExtent)) {
    for (const z of samplesAcrossExtent(zExtent)) {
      const inside = localParcels.some(
        (parcel) =>
          x >= parcel.minimumX && x <= parcel.maximumX && z >= parcel.minimumZ && z <= parcel.maximumZ
      )
      if (!inside) return false
    }
  }
  return true
}

function isPlaceholderWorldName(value) {
  if (!nonEmptyString(value)) return true
  const normalized = value.trim().toLowerCase()
  return (
    normalized.includes(OPEN_ANGLE) ||
    normalized.includes(CLOSE_ANGLE) ||
    /(?:placeholder|change[-_ ]?me|your[-_ ]?world|world[-_ ]?name|example)/.test(normalized)
  )
}

export function validateScene(scene) {
  const root = isRecord(scene) ? scene : {}
  const worldConfiguration = isRecord(root.worldConfiguration) ? root.worldConfiguration : {}
  const sceneParcels = isRecord(root.scene) ? root.scene : {}
  const parcelValues = Array.isArray(sceneParcels.parcels) ? sceneParcels.parcels : []
  const parcels = parcelValues.map(parseParcel)
  const base = parseParcel(sceneParcels.base)
  const parcelsValid =
    parcelValues.length > 0 &&
    parcels.every((parcel) => parcel !== null) &&
    new Set(parcelValues).size === parcelValues.length &&
    base !== null &&
    parcelValues.includes(sceneParcels.base)
  const spawnPoints = Array.isArray(root.spawnPoints) ? root.spawnPoints : []
  const spawnPointsValid =
    parcelsValid && spawnPoints.every((spawnPoint) => spawnIsInsideParcels(spawnPoint, parcels, base))
  const display = isRecord(root.display) ? root.display : {}

  return [
    check(
      'world-name',
      'World name',
      !isPlaceholderWorldName(worldConfiguration.name),
      nonEmptyString(worldConfiguration.name)
        ? `worldConfiguration.name=${JSON.stringify(worldConfiguration.name)}`
        : 'worldConfiguration.name is missing',
      'Set scene.json worldConfiguration.name to the owned, production World name.'
    ),
    check(
      'authoritative-multiplayer',
      'Authoritative multiplayer',
      root.authoritativeMultiplayer === true,
      `authoritativeMultiplayer=${JSON.stringify(root.authoritativeMultiplayer)}`,
      'Set scene.json authoritativeMultiplayer to true.'
    ),
    check(
      'fixed-adapter',
      'Fixed adapter absent',
      !hasOwn(worldConfiguration, 'fixedAdapter'),
      hasOwn(worldConfiguration, 'fixedAdapter') ? 'worldConfiguration.fixedAdapter is present' : 'not configured',
      'Remove worldConfiguration.fixedAdapter from scene.json.'
    ),
    check(
      'places-opt-out',
      'Places opt-out absent',
      !isRecord(worldConfiguration.placesConfig) || !hasOwn(worldConfiguration.placesConfig, 'optOut'),
      isRecord(worldConfiguration.placesConfig) && hasOwn(worldConfiguration.placesConfig, 'optOut')
        ? 'worldConfiguration.placesConfig.optOut is present'
        : 'not configured',
      'Remove worldConfiguration.placesConfig.optOut from scene.json.'
    ),
    check(
      'parcels',
      'Declared parcels',
      parcelsValid,
      parcelsValid ? `${parcelValues.length} parcel(s), base ${sceneParcels.base}` : 'parcels/base are missing or invalid',
      'Declare unique scene parcels and a base parcel that belongs to the declaration.'
    ),
    check(
      'spawn-points',
      'Spawn points inside parcels',
      spawnPointsValid,
      spawnPointsValid
        ? `${spawnPoints.length} spawn point(s) contained by the declared parcels`
        : 'at least one spawn range extends outside the declared parcels or is invalid',
      'Move every scene.json spawn-point range fully inside the declared parcel footprint.'
    ),
    check(
      'display-metadata',
      'Display metadata',
      nonEmptyString(display.title) && nonEmptyString(display.description) && nonEmptyString(display.navmapThumbnail),
      `title=${nonEmptyString(display.title) ? 'set' : 'missing'}, description=${nonEmptyString(display.description) ? 'set' : 'missing'}, thumbnail=${nonEmptyString(display.navmapThumbnail) ? 'set' : 'missing'}`,
      'Set scene.json display.title, display.description, and display.navmapThumbnail.'
    )
  ]
}

export function extractWorldName(configSource) {
  if (typeof configSource !== 'string') return null
  const match = configSource.match(/^\s*export\s+const\s+WORLD_NAME\s*=\s*(['"])([^'"\r\n]+)\1\s*(?:as\s+const)?\s*$/m)
  return match?.[2] ?? null
}

export function validateConfigWorldName(scene, configSource) {
  const sceneName = isRecord(scene) && isRecord(scene.worldConfiguration) ? scene.worldConfiguration.name : undefined
  const configName = extractWorldName(configSource)
  const matches = nonEmptyString(sceneName) && configName !== null && configName === sceneName
  return check(
    'config-world-name',
    'Config World name',
    matches,
    `scene.json=${JSON.stringify(sceneName)}, config.ts=${JSON.stringify(configName)}`,
    'Set src/shared/config.ts WORLD_NAME to the exact scene.json worldConfiguration.name literal.'
  )
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  })
  return {
    ok: result.status === 0 && !result.error,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    error: result.error?.message
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function npmInvocation(args, npmExecPath = process.env.npm_execpath, nodeExecPath = process.execPath) {
  return nonEmptyString(npmExecPath)
    ? { command: nodeExecPath, args: [npmExecPath, ...args] }
    : { command: npmCommand(), args }
}

function git(args) {
  return run('git', args)
}

function trackedFiles() {
  const result = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (!result.ok) return { error: result.output || result.error || 'git ls-files failed', files: [] }
  return { files: result.output.split('\0').filter(Boolean) }
}

function lineNumberAt(content, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

export function findPlaceholders(files) {
  const ownerSlots = new Set()
  const unexpected = []

  for (const file of files) {
    const content = file.content
    let cursor = 0
    while (cursor < content.length) {
      const start = content.indexOf(OPEN_ANGLE, cursor)
      if (start < 0) break
      const end = content.indexOf(CLOSE_ANGLE, start + 1)
      const newline = content.indexOf('\n', start + 1)
      if (end < 0 || (newline >= 0 && newline < end) || end - start > 200) {
        cursor = start + 1
        continue
      }

      const token = content.slice(start, end + 1)
      const inner = content.slice(start + 1, end).trim()
      if (inner === 'WORLD LINK') {
        ownerSlots.add(OWNER_WORLD_SLOT)
      } else if (inner.startsWith('MEASURED:')) {
        ownerSlots.add(OWNER_MEASURED_SLOT)
      } else if (/\b(?:LINK|URL|MEASURED|PLACEHOLDER|TODO|TBD|FIXME|CHANGEME|REPLACE\s+ME|FILL\s+ME)\b/i.test(inner)) {
        unexpected.push({ path: file.path, line: lineNumberAt(content, start), token })
      }
      cursor = end + 1
    }

    const lines = content.split(/\r?\n/)
    lines.forEach((line, index) => {
      const marker = line.match(/^\s*(?:(?:\/\/|#|<!--)\s*)?(TODO|TBD|FIXME|CHANGEME)\s*[:=-]/i)
      if (marker) unexpected.push({ path: file.path, line: index + 1, token: marker[0].trim() })
    })
  }

  return { ownerSlots: [...ownerSlots], unexpected }
}

function scanRepositoryPlaceholders() {
  const listed = trackedFiles()
  if (listed.error) return { error: listed.error, ownerSlots: [], unexpected: [] }

  const files = []
  for (const path of listed.files) {
    const absolutePath = join(ROOT, path)
    try {
      const bytes = readFileSync(absolutePath)
      if (bytes.includes(0)) continue
      files.push({ path: path.replaceAll('\\', '/'), content: bytes.toString('utf8') })
    } catch (error) {
      return { error: `cannot read ${path}: ${error.message}`, ownerSlots: [], unexpected: [] }
    }
  }
  return findPlaceholders(files)
}

export function parseGitHubRepository(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null
  const trimmed = remoteUrl.trim().replace(/\.git$/, '')
  const match = trimmed.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+)$/i)
  return match ? `${match[1]}/${match[2]}` : null
}

async function githubVisibility(repository) {
  const cli = run(process.platform === 'win32' ? 'gh.exe' : 'gh', [
    'repo',
    'view',
    repository,
    '--json',
    'visibility',
    '--jq',
    '.visibility'
  ])
  const cliVisibility = cli.output.split(/\r?\n/).at(-1)?.trim().toUpperCase()
  if (cli.ok && ['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(cliVisibility)) {
    return { visibility: cliVisibility, source: 'GitHub CLI' }
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${repository}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ghostlight-preflight' },
      signal: AbortSignal.timeout(10_000)
    })
    if (response.ok) {
      const data = await response.json()
      if (typeof data.private === 'boolean') {
        return { visibility: data.private ? 'PRIVATE' : 'PUBLIC', source: 'GitHub API' }
      }
    }
    return {
      visibility: 'UNKNOWN',
      source: `GitHub CLI failed; API returned HTTP ${response.status}`
    }
  } catch (error) {
    return { visibility: 'UNKNOWN', source: `GitHub CLI/API unavailable: ${error.message}` }
  }
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: error.message }
  }
}

function printCommandFailure(output) {
  if (!output) return
  console.log(output)
}

function printResult(result) {
  console.log(`[${result.status}] ${result.label} - ${result.detail}`)
}

function commandCheck(id, label, command, args, successDetail, action) {
  console.log(`\nRunning ${label}...`)
  const result = run(command, args)
  if (!result.ok) printCommandFailure(result.output || result.error)
  return check(id, label, result.ok, result.ok ? successDetail : `command failed: ${command} ${args.join(' ')}`, action)
}

function npmCommandCheck(id, label, args, successDetail, action) {
  const invocation = npmInvocation(args)
  return commandCheck(id, label, invocation.command, invocation.args, successDetail, action)
}

function addWarning(results, id, label, detail, action) {
  results.push({ id, label, status: 'WARN', detail, action })
}

function normalizedPath(path) {
  const absolute = isAbsolute(path) ? path : resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export async function main() {
  const results = []
  console.log('Ghostlight deploy preflight\n')

  const sceneFile = readJson(join(ROOT, 'scene.json'))
  const scene = sceneFile.value
  if (sceneFile.error) {
    results.push(
      check(
        'scene-json',
        'scene.json readable',
        false,
        sceneFile.error,
        'Fix scene.json so it is valid JSON before deploying.'
      )
    )
  }
  results.push(...validateScene(scene))

  let configSource = null
  try {
    configSource = readFileSync(join(ROOT, 'src', 'shared', 'config.ts'), 'utf8')
  } catch (error) {
    configSource = null
  }
  results.push(validateConfigWorldName(scene, configSource))

  const thumbnail = isRecord(scene) && isRecord(scene.display) ? scene.display.navmapThumbnail : null
  if (nonEmptyString(thumbnail)) {
    const thumbnailPath = join(ROOT, thumbnail)
    results.push(
      check(
        'thumbnail-file',
        'Thumbnail file',
        existsSync(thumbnailPath),
        existsSync(thumbnailPath) ? relative(ROOT, thumbnailPath) : `${thumbnail} does not exist`,
        'Add the scene.json display.navmapThumbnail file at the configured path.'
      )
    )
  }

  const placeholders = scanRepositoryPlaceholders()
  results.push(
    check(
      'placeholders',
      'Unexpected placeholders',
      !placeholders.error && placeholders.unexpected.length === 0,
      placeholders.error
        ? placeholders.error
        : placeholders.unexpected.length === 0
          ? 'none found'
          : placeholders.unexpected.map((item) => `${item.path}:${item.line} ${item.token}`).join('; '),
      'Replace every unexpected placeholder listed by the preflight.'
    )
  )
  if (placeholders.ownerSlots.length > 0) {
    addWarning(
      results,
      'owner-slots',
      'Owner slots still unfilled',
      placeholders.ownerSlots.join(', '),
      `Fill the remaining owner slots: ${placeholders.ownerSlots.join(', ')}.`
    )
  } else {
    results.push({ id: 'owner-slots', label: 'Owner slots', status: 'PASS', detail: 'all filled' })
  }

  const status = git(['status', '--porcelain=v1'])
  results.push(
    check(
      'git-clean',
      'Clean working tree',
      status.ok && status.output.length === 0,
      status.ok ? (status.output.length === 0 ? 'clean' : status.output.replaceAll('\n', '; ')) : status.output,
      'Commit or intentionally remove every working-tree change, then rerun preflight.'
    )
  )

  const remotes = git(['remote'])
  const remoteNames = remotes.ok ? remotes.output.split(/\r?\n/).filter(Boolean) : []
  results.push(
    check(
      'git-remote',
      'Git remote',
      remoteNames.length > 0,
      remoteNames.length > 0 ? remoteNames.join(', ') : 'none configured',
      'Configure the GitHub repository as a git remote.'
    )
  )

  const branch = git(['branch', '--show-current'])
  const head = git(['rev-parse', '--short=12', 'HEAD'])
  results.push(
    check(
      'git-revision',
      'Git revision',
      branch.ok && head.ok,
      `branch=${branch.output || '(detached)'}, HEAD=${head.output || '(unknown)'}`,
      'Restore a valid git branch and HEAD before deploying.'
    )
  )

  let githubRepository = null
  for (const remoteName of ['origin', ...remoteNames.filter((name) => name !== 'origin')]) {
    if (!remoteNames.includes(remoteName)) continue
    const remoteUrl = git(['remote', 'get-url', remoteName])
    githubRepository = remoteUrl.ok ? parseGitHubRepository(remoteUrl.output) : null
    if (githubRepository) break
  }

  if (!githubRepository) {
    results.push(
      check(
        'github-visibility',
        'GitHub visibility',
        false,
        'no GitHub remote could be identified',
        'Configure a github.com repository remote so visibility can be verified.'
      )
    )
  } else {
    const visibility = await githubVisibility(githubRepository)
    if (visibility.visibility === 'UNKNOWN') {
      results.push(
        check(
          'github-visibility',
          'GitHub visibility',
          false,
          `${githubRepository}: unknown (${visibility.source})`,
          'Authenticate GitHub CLI or restore GitHub API access, then rerun preflight.'
        )
      )
    } else if (visibility.visibility === 'PUBLIC') {
      results.push({
        id: 'github-visibility',
        label: 'GitHub visibility',
        status: 'PASS',
        detail: `${githubRepository}: PUBLIC (${visibility.source})`
      })
    } else {
      addWarning(
        results,
        'github-visibility',
        'GitHub visibility',
        `${githubRepository}: ${visibility.visibility} (${visibility.source})`,
        `Make ${githubRepository} PUBLIC before submission.`
      )
    }
  }

  results.push(
    npmCommandCheck(
      'asset-budgets',
      'Asset budgets',
      ['test', '--', 'test/asset-budget.test.ts'],
      'test/asset-budget.test.ts passed',
      'Fix the reported asset-budget failure before deploying.'
    )
  )
  results.push(
    npmCommandCheck(
      'build',
      'Production build',
      ['run', 'build'],
      'npm run build passed',
      'Fix the production build before deploying.'
    )
  )
  results.push(
    npmCommandCheck(
      'tests',
      'Test suite',
      ['test'],
      'npm test passed',
      'Fix the test suite before deploying.'
    )
  )

  console.log('\nResults')
  results.forEach(printResult)

  const outstanding = []
  for (const result of results) {
    if (result.status !== 'PASS' && result.action && !outstanding.includes(result.action)) {
      outstanding.push(result.action)
    }
  }
  console.log('\nBefore you deploy')
  if (outstanding.length === 0) {
    console.log('1. No outstanding preflight items.')
  } else {
    outstanding.forEach((action, index) => console.log(`${index + 1}. ${action}`))
  }

  const failed = results.filter((result) => result.status === 'FAIL')
  console.log(`\nPreflight ${failed.length === 0 ? 'PASSED' : `FAILED (${failed.length} check(s))`}.`)
  if (failed.length > 0) process.exitCode = 1
  return results
}

if (process.argv[1] && normalizedPath(process.argv[1]) === normalizedPath(fileURLToPath(import.meta.url))) {
  await main()
}
