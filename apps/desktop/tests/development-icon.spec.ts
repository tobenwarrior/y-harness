import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DEVELOPMENT_ICON_SOURCE, ICNS_BITMAPS, packIcns, unpackIcns, writeDevelopmentIcon,
  type IcnsEntry } from '../scripts/development-icon.ts'

/** Smallest valid-looking PNG stream: signature plus an IHDR chunk declaring the given edge. */
function pngStub(width: number, height = width): Buffer {
  const png = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12)
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

function iconFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-icon-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

describe('development application icon', () => {
  it('packs PNG representations into an ICNS container and reads them back', () => {
    const entries: IcnsEntry[] = [
      { type: 'ic07', size: 128, png: pngStub(128) },
      { type: 'ic10', size: 1024, png: pngStub(1024) },
    ]
    const icns = packIcns(entries)
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    expect(icns.subarray(8, 12).toString('ascii')).toBe('ic07')
    expect(icns.readUInt32BE(12)).toBe(8 + entries[0]!.png.length)
    expect(unpackIcns(icns)).toEqual(entries)
  })

  it('rejects mismatched bitmaps, unknown or malformed representations, and truncated files', () => {
    expect(() => packIcns([{ type: 'ic07', size: 128, png: pngStub(256) }])).toThrow('representation ic07 is 256x256, expected 128')
    expect(() => packIcns([{ type: 'ico7x', size: 128, png: pngStub(128) }])).toThrow('unsupported representation type')
    expect(() => packIcns([{ type: 'ic07', size: 128, png: Buffer.from('not a png stream, long enough to be read') }])).toThrow('not a PNG stream')
    expect(() => unpackIcns(Buffer.from('not an icns file, long enough to be read'))).toThrow('not an ICNS file')

    const miscounted = packIcns([{ type: 'ic07', size: 128, png: pngStub(128) }])
    miscounted.writeUInt32BE(miscounted.length + 8, 4)
    expect(() => unpackIcns(miscounted)).toThrow(`file declares ${String(miscounted.length + 8)} bytes`)

    const truncated = Buffer.from(packIcns([{ type: 'ic07', size: 128, png: pngStub(128) }]).subarray(0, 12))
    truncated.writeUInt32BE(truncated.length, 4)
    expect(() => unpackIcns(truncated)).toThrow('truncated representation header')

    const oversized = packIcns([{ type: 'ic07', size: 128, png: pngStub(128) }])
    oversized.writeUInt32BE(4096, 12)
    expect(() => unpackIcns(oversized)).toThrow('representation ic07 declares 4096 bytes')

    const unknown = packIcns([{ type: 'ic07', size: 128, png: pngStub(128) }])
    unknown.write('ic99', 8, 'ascii')
    expect(() => unpackIcns(unknown)).toThrow('unknown representation type "ic99"')

    // The declared edge comes from the representation type, not from the PNG itself.
    const foreign = packIcns([{ type: 'icp5', size: 32, png: pngStub(32) }])
    foreign.write('ic07', 8, 'ascii')
    expect(() => unpackIcns(foreign)).toThrow('representation ic07 declares 128 but holds 32x32')
  })

  it('rasterizes the release artwork at every representation macOS reads', async () => {
    const icns = join(iconFixture(), 'electron.icns')
    await writeDevelopmentIcon(DEVELOPMENT_ICON_SOURCE, icns)
    const entries = unpackIcns(readFileSync(icns))
    expect(entries.map(entry => `${entry.type}:${String(entry.size)}`))
      .toEqual(ICNS_BITMAPS.map(({ type, size }) => `${type}:${String(size)}`))
    for (const entry of entries) expect(entry.png.length).toBeGreaterThan(100)
  })

  it.skipIf(process.platform !== 'darwin')('writes a container macOS unpacks into the standard iconset', async () => {
    const root = iconFixture()
    const icns = join(root, 'electron.icns')
    await writeDevelopmentIcon(DEVELOPMENT_ICON_SOURCE, icns)
    const iconset = join(root, 'icon.iconset')
    execFileSync('/usr/bin/iconutil', ['-c', 'iconset', icns, '-o', iconset], { stdio: 'pipe' })
    expect(readdirSync(iconset).sort()).toEqual([
      'icon_128x128.png', 'icon_128x128@2x.png', 'icon_16x16.png', 'icon_16x16@2x.png',
      'icon_256x256.png', 'icon_256x256@2x.png', 'icon_32x32.png', 'icon_32x32@2x.png',
      'icon_512x512.png', 'icon_512x512@2x.png',
    ])
  })
})
