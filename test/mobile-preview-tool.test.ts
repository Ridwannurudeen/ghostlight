import { describe, expect, it, vi } from 'vitest'
import {
  buildMobilePreviewDeepLink,
  classifyPreviewInterfaces,
  runMobilePreviewCli,
  selectPreviewHost
} from '../tools/mobile-preview.mjs'

const wiFi = {
  'Wi-Fi': [
    {
      address: '192.168.1.149',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: '192.168.1.149/24'
    }
  ]
}

function healthyAbout(host = '192.168.1.149') {
  return new Response(
    JSON.stringify({
      healthy: true,
      acceptingUsers: true,
      content: { healthy: true, publicUrl: `http://${host}:8000/content` },
      comms: { healthy: true },
      lambdas: { healthy: true }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

describe('mobile preview QR tool', () => {
  it('rejects loopback, link-local, VPN, and virtual interfaces while retaining Wi-Fi', () => {
    const classified = classifyPreviewInterfaces({
      ProTUN: [{ address: '10.2.0.2', family: 'IPv4', internal: false, cidr: '10.2.0.2/32' }],
      'Cloudflare WARP': [{ address: '100.64.0.2', family: 'IPv4', internal: false }],
      'Wi-Fi': wiFi['Wi-Fi'],
      'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      'Link Local': [{ address: '169.254.4.2', family: 'IPv4', internal: false }],
      'vEthernet (WSL)': [{ address: '172.25.48.1', family: 'IPv4', internal: false }]
    })

    expect(classified.filter((candidate) => candidate.eligible)).toEqual([
      expect.objectContaining({ name: 'Wi-Fi', address: '192.168.1.149' })
    ])
    expect(classified.find((candidate) => candidate.name === 'ProTUN')?.reason).toBe('tunnel or virtual adapter')
    expect(classified.find((candidate) => candidate.name === 'Cloudflare WARP')?.reason).toBe(
      'tunnel or virtual adapter'
    )
    expect(classified.find((candidate) => candidate.name === 'Link Local')?.reason).toBe('link-local IPv4 range')
    expect(classified.find((candidate) => candidate.name === 'vEthernet (WSL)')?.reason).toBe(
      'tunnel or virtual adapter'
    )
  })

  it('selects the only eligible physical LAN interface', () => {
    expect(
      selectPreviewHost({
        ProTUN: [{ address: '10.2.0.2', family: 'IPv4', internal: false }],
        ...wiFi
      })
    ).toEqual(expect.objectContaining({ name: 'Wi-Fi', address: '192.168.1.149' }))
  })

  it('requires an explicit host when eligible LAN interfaces are ambiguous', async () => {
    const fetchImpl = vi.fn()
    const errors: string[] = []
    const status = await runMobilePreviewCli(['--position', '0,0'], {
      networkInterfaces: () => ({
        ...wiFi,
        Ethernet: [{ address: '192.168.50.10', family: 'IPv4', internal: false }]
      }),
      fetchImpl,
      renderQr: vi.fn(),
      stdout: vi.fn(),
      stderr: (message: string) => errors.push(message)
    })

    expect(status).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(errors.join('\n')).toContain('Multiple eligible LAN interfaces found')
    expect(errors.join('\n')).toContain('--host')
  })

  it('accepts only an explicit host assigned to an eligible local interface', () => {
    const interfaces = {
      ProTUN: [{ address: '10.2.0.2', family: 'IPv4', internal: false }],
      ...wiFi
    }

    expect(selectPreviewHost(interfaces, '192.168.1.149').name).toBe('Wi-Fi')
    expect(() => selectPreviewHost(interfaces, '10.2.0.2')).toThrow('tunnel or virtual adapter')
    expect(() => selectPreviewHost(interfaces, '192.168.1.200')).toThrow('not assigned')
  })

  it('requires explicit verification for an unrecognized adapter name', () => {
    const interfaces = {
      'Local connection': [{ address: '192.168.20.5', family: 'IPv4', internal: false }]
    }

    expect(() => selectPreviewHost(interfaces)).toThrow('cannot be identified as physical')
    expect(selectPreviewHost(interfaces, '192.168.20.5').address).toBe('192.168.20.5')
  })

  it('builds the exact Decentraland phone-preview payload', () => {
    expect(buildMobilePreviewDeepLink({ host: '192.168.1.149', port: 8000, position: '0,0' })).toBe(
      'decentraland://open?preview=http://192.168.1.149:8000&position=0,0'
    )
  })

  it('returns a nonzero CLI status when /about is unhealthy', async () => {
    const errors: string[] = []
    const renderQr = vi.fn()
    const status = await runMobilePreviewCli(['--host', '192.168.1.149', '--position', '0,0'], {
      networkInterfaces: () => wiFi,
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ healthy: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      ),
      renderQr,
      stdout: vi.fn(),
      stderr: (message: string) => errors.push(message)
    })

    expect(status).toBe(1)
    expect(renderQr).not.toHaveBeenCalled()
    expect(errors.join('\n')).toContain('is not ready')
  })

  it('returns a nonzero CLI status when /about advertises another host', async () => {
    const errors: string[] = []
    const status = await runMobilePreviewCli(['--host', '192.168.1.149', '--position', '0,0'], {
      networkInterfaces: () => wiFi,
      fetchImpl: vi.fn(async () => healthyAbout('10.2.0.2')),
      renderQr: vi.fn(),
      stdout: vi.fn(),
      stderr: (message: string) => errors.push(message)
    })

    expect(status).toBe(1)
    expect(errors.join('\n')).toContain('advertises content on 10.2.0.2, not 192.168.1.149')
  })

  it('prints only the verified host payload and keeps phone evidence unverified', async () => {
    const output: string[] = []
    const renderQr = vi.fn(async (payload: string) => `QR:${payload}`)
    const fetchImpl = vi.fn(async () => healthyAbout())
    const status = await runMobilePreviewCli(['--host=192.168.1.149', '--position=0,0'], {
      networkInterfaces: () => wiFi,
      fetchImpl,
      renderQr,
      stdout: (message: string) => output.push(message),
      stderr: vi.fn()
    })

    const deepLink = 'decentraland://open?preview=http://192.168.1.149:8000&position=0,0'
    expect(status).toBe(0)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://192.168.1.149:8000/about',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(renderQr).toHaveBeenCalledWith(deepLink)
    expect(output.join('\n')).toContain(deepLink)
    expect(output.join('\n')).toContain('Phone evidence status: UNVERIFIED')
    expect(output.join('\n')).not.toContain('10.2.0.2')
  })
})
