import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const TUNNEL_ADAPTER =
  /(vpn|tun|tap|tailscale|zerotier|hamachi|wireguard|proton|warp|mullvad|nord|openvpn|anyconnect|globalprotect|fortinet|wsl|hyper-v|vethernet|docker|podman|virtualbox|vmware|vbox)/i
const PHYSICAL_ADAPTER = /^(wi-?fi|wireless|wlan|ethernet|eth\d|en\d|enp|eno|ens|wlp)/i

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function parseIpv4(address) {
  if (typeof address !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return null
  const octets = address.split('.').map(Number)
  if (octets.some((octet) => octet > 255) || octets.join('.') !== address) return null
  return octets
}

function rejectedAddressReason(address) {
  const octets = parseIpv4(address)
  if (!octets) return 'not a canonical IPv4 address'
  if (octets[0] === 0) return 'unspecified IPv4 range'
  if (octets[0] === 127) return 'loopback IPv4 range'
  if (octets[0] === 169 && octets[1] === 254) return 'link-local IPv4 range'
  if (octets[0] >= 224) return 'multicast or reserved IPv4 range'
  return null
}

export function classifyPreviewInterfaces(interfaces) {
  const classified = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const details of addresses ?? []) {
      if (details.family !== 'IPv4' && details.family !== 4) continue
      let reason = rejectedAddressReason(details.address)
      if (!reason && details.internal) reason = 'internal interface'
      if (!reason && TUNNEL_ADAPTER.test(name)) reason = 'tunnel or virtual adapter'
      classified.push({
        name,
        address: details.address,
        cidr: details.cidr ?? null,
        eligible: reason === null,
        automatic: reason === null && PHYSICAL_ADAPTER.test(name),
        reason
      })
    }
  }
  return classified
}

export function selectPreviewHost(interfaces, requestedHost) {
  const classified = classifyPreviewInterfaces(interfaces)
  if (requestedHost !== undefined) {
    if (!parseIpv4(requestedHost))
      throw new Error(`--host must be a canonical IPv4 address; received "${requestedHost}"`)
    const matches = classified.filter((candidate) => candidate.address === requestedHost)
    if (matches.length === 0) {
      throw new Error(`Host ${requestedHost} is not assigned to a local IPv4 interface`)
    }
    const selected = matches.find((candidate) => candidate.eligible)
    if (!selected) {
      throw new Error(`Host ${requestedHost} is rejected on ${matches[0].name}: ${matches[0].reason}`)
    }
    return selected
  }

  const eligibleByAddress = new Map()
  for (const candidate of classified) {
    if (candidate.eligible && !eligibleByAddress.has(candidate.address)) {
      eligibleByAddress.set(candidate.address, candidate)
    }
  }
  const eligible = [...eligibleByAddress.values()]
  if (eligible.length === 0) {
    throw new Error('No eligible physical LAN IPv4 interface was found; connect this computer to the phone network')
  }
  if (eligible.length > 1) {
    const choices = eligible.map((candidate) => `${candidate.name}=${candidate.address}`).join(', ')
    throw new Error(
      `Multiple eligible LAN interfaces found (${choices}); rerun with --host set to the phone-reachable one`
    )
  }
  if (!eligible[0].automatic) {
    throw new Error(
      `Interface ${eligible[0].name}=${eligible[0].address} cannot be identified as physical; verify it and rerun with --host ${eligible[0].address}`
    )
  }
  return eligible[0]
}

function parsePort(rawPort) {
  const text = String(rawPort)
  if (!/^\d+$/.test(text)) throw new Error(`--port must be an integer from 1 to 65535; received "${text}"`)
  const port = Number(text)
  if (port < 1 || port > 65_535) {
    throw new Error(`--port must be an integer from 1 to 65535; received "${text}"`)
  }
  return port
}

function validatePosition(position) {
  if (!/^-?\d+,-?\d+$/.test(position)) {
    throw new Error(`--position must contain integer parcel coordinates in x,y form; received "${position}"`)
  }
  return position
}

export function buildMobilePreviewDeepLink({ host, port, position }) {
  if (!parseIpv4(host) || rejectedAddressReason(host)) {
    throw new Error(`Cannot build a mobile preview link for ineligible host "${host}"`)
  }
  return `decentraland://open?preview=http://${host}:${parsePort(port)}&position=${validatePosition(position)}`
}

export async function verifyPreviewEndpoint({ host, port, fetchImpl = globalThis.fetch, timeoutMs = 5_000 }) {
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch')
  const endpoint = `http://${host}:${parsePort(port)}/about`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(endpoint, { signal: controller.signal })
  } catch (error) {
    throw new Error(`Preview endpoint check failed at ${endpoint}: ${errorMessage(error)}`)
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`Preview endpoint check failed at ${endpoint}: HTTP ${response.status}`)

  let about
  try {
    about = await response.json()
  } catch (error) {
    throw new Error(`Preview endpoint check failed at ${endpoint}: invalid JSON (${errorMessage(error)})`)
  }
  const unhealthy = [
    ['healthy', about?.healthy],
    ['acceptingUsers', about?.acceptingUsers],
    ['content.healthy', about?.content?.healthy],
    ['comms.healthy', about?.comms?.healthy],
    ['lambdas.healthy', about?.lambdas?.healthy]
  ].filter(([, value]) => value !== true)
  if (unhealthy.length > 0) {
    throw new Error(`Preview endpoint at ${endpoint} is not ready: ${unhealthy.map(([field]) => field).join(', ')}`)
  }

  const advertisedContentUrl = about.content?.publicUrl
  let advertisedHost
  try {
    advertisedHost = new URL(advertisedContentUrl).hostname
  } catch {
    throw new Error(`Preview endpoint at ${endpoint} returned an invalid content.publicUrl`)
  }
  if (advertisedHost !== host) {
    throw new Error(`Preview endpoint at ${endpoint} advertises content on ${advertisedHost}, not ${host}`)
  }
  return { endpoint, about }
}

async function readScenePosition(cwd) {
  const scenePath = resolve(cwd, 'scene.json')
  let scene
  try {
    scene = JSON.parse(await readFile(scenePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read ${scenePath}: ${errorMessage(error)}`)
  }
  return validatePosition(scene?.scene?.base)
}

async function renderTerminalQr(payload) {
  let sdkCommandsPackage
  try {
    sdkCommandsPackage = require.resolve('@dcl/sdk-commands/package.json')
  } catch {
    throw new Error('Cannot find @dcl/sdk-commands; run npm ci before generating the mobile QR')
  }

  let qrCode
  try {
    qrCode = createRequire(sdkCommandsPackage)('qrcode')
  } catch {
    throw new Error(
      'The installed @dcl/sdk-commands package does not provide qrcode; add qrcode@1.5.4 as a direct devDependency'
    )
  }
  return new Promise((resolveQr, rejectQr) => {
    qrCode.toString(payload, { type: 'terminal', small: true }, (error, qr) => {
      if (error) rejectQr(new Error(`Unable to render the mobile QR: ${errorMessage(error)}`))
      else resolveQr(qr)
    })
  })
}

function optionValue(args, index, name) {
  const argument = args[index]
  const prefix = `${name}=`
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 }
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return { value, consumed: 1 }
}

export function parseMobilePreviewArgs(args) {
  const options = { host: undefined, port: 8000, position: undefined, help: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    const name = ['--host', '--port', '--position'].find(
      (candidate) => argument === candidate || argument.startsWith(`${candidate}=`)
    )
    if (!name) throw new Error(`Unknown option "${argument}"`)
    const parsed = optionValue(args, index, name)
    index += parsed.consumed
    if (name === '--host') options.host = parsed.value
    if (name === '--port') options.port = parsePort(parsed.value)
    if (name === '--position') options.position = validatePosition(parsed.value)
  }
  return options
}

const HELP = `Usage: node tools/mobile-preview.mjs [options]

Options:
  --host <IPv4>       Local Wi-Fi/Ethernet address reachable by the phone
  --port <number>     Preview port (default: 8000)
  --position <x,y>    Initial parcel (default: scene.json base)
  -h, --help          Show this help

Automatic selection is allowed only when exactly one recognized physical LAN IPv4 exists.
Loopback, link-local, and known tunnel, VPN, WSL, Hyper-V, and virtual adapters are rejected.`

export async function runMobilePreviewCli(args, dependencies = {}) {
  const writeOut = dependencies.stdout ?? ((message) => console.log(message))
  const writeError = dependencies.stderr ?? ((message) => console.error(message))
  try {
    const options = parseMobilePreviewArgs(args)
    if (options.help) {
      writeOut(HELP)
      return 0
    }
    const getInterfaces = dependencies.networkInterfaces ?? networkInterfaces
    const selected = selectPreviewHost(getInterfaces(), options.host)
    const position = options.position ?? (await readScenePosition(dependencies.cwd ?? process.cwd()))
    const verification = await verifyPreviewEndpoint({
      host: selected.address,
      port: options.port,
      fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
      timeoutMs: dependencies.timeoutMs ?? 5_000
    })
    const deepLink = buildMobilePreviewDeepLink({ host: selected.address, port: options.port, position })
    const renderQr = dependencies.renderQr ?? renderTerminalQr
    const qr = await renderQr(deepLink)

    writeOut(`Selected preview interface: ${selected.name} (${selected.address})`)
    writeOut(`Verified laptop endpoint: ${verification.endpoint}`)
    writeOut(`QR payload - verify this exact host before scanning:\n${deepLink}`)
    writeOut(`Scan this QR in Decentraland:\n${qr}`)
    writeOut('Phone evidence status: UNVERIFIED. This laptop endpoint check does not prove that a phone connected.')
    return 0
  } catch (error) {
    writeError(`Mobile preview QR failed: ${errorMessage(error)}`)
    return 1
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()
if (invokedDirectly) process.exitCode = await runMobilePreviewCli(process.argv.slice(2))
