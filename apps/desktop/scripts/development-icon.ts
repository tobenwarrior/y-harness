/**
 * Brand the macOS development bundle icon from the release artwork.
 *
 * macOS reads the Dock, application-switcher, and Finder icon from the ICNS file that
 * the bundle's `CFBundleIconFile` names. The development bundle is a copy of the stock
 * Electron application, so it shows Electron's own artwork until that file is replaced;
 * `resources/icon-macos.png` is the same PNG that electron-builder converts for a
 * packaged build, so both launch modes present the product icon.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Release artwork the development bundle icon is rasterized from. */
export const DEVELOPMENT_ICON_SOURCE = fileURLToPath(new URL('../resources/icon-macos.png', import.meta.url))

/** One ICNS representation: a PNG bitmap stored under its four-character type code. */
export interface IcnsEntry {
  /** Representation type, for example `ic07` for the 128-pixel bitmap. */
  readonly type: string
  /** Square bitmap edge in pixels; the PNG must declare the same edge. */
  readonly size: number
  /** Complete PNG stream at {@link IcnsEntry.size} pixels. */
  readonly png: Buffer
}

/** Representation type and bitmap edge, paired as macOS defines them. */
export interface IcnsBitmap {
  readonly type: string
  readonly size: number
}

/**
 * Representations of the application icon, smallest first: both bitmaps Finder shows for
 * each base size, 16 through 512 pixels at 2x. macOS reads the PNG data in each one
 * directly, so no uncompressed `is32`-style representation is required.
 */
export const ICNS_BITMAPS: readonly IcnsBitmap[] = [
  { type: 'icp4', size: 16 }, { type: 'ic11', size: 32 },
  { type: 'icp5', size: 32 }, { type: 'ic12', size: 64 },
  { type: 'ic07', size: 128 }, { type: 'ic13', size: 256 },
  { type: 'ic08', size: 256 }, { type: 'ic14', size: 512 },
  { type: 'ic09', size: 512 }, { type: 'ic10', size: 1024 },
]

const ICNS_MAGIC = 'icns'
const FILE_HEADER_BYTES = 8
const ENTRY_HEADER_BYTES = 8
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const BITMAP_SIZES = new Map(ICNS_BITMAPS.map(({ type, size }) => [type, size]))

/**
 * Pack PNG bitmaps into one ICNS file.
 * @param entries - Representations in the order they are stored; each PNG must be square with the declared edge.
 * @returns the ICNS bytes.
 */
export function packIcns(entries: readonly IcnsEntry[]): Buffer {
  const chunks = entries.map((entry) => {
    if (entry.type.length !== 4) throw new Error(`application icon: unsupported representation type ${JSON.stringify(entry.type)}`)
    const { width, height } = pngDimensions(entry.png)
    if (width !== entry.size || height !== entry.size) {
      throw new Error(`application icon: representation ${entry.type} is ${String(width)}x${String(height)}, expected ${String(entry.size)}`)
    }
    const header = Buffer.alloc(ENTRY_HEADER_BYTES)
    header.write(entry.type, 0, 'ascii')
    header.writeUInt32BE(entry.png.length + ENTRY_HEADER_BYTES, 4)
    return Buffer.concat([header, entry.png])
  })
  const file = Buffer.alloc(FILE_HEADER_BYTES)
  file.write(ICNS_MAGIC, 0, 'ascii')
  file.writeUInt32BE(FILE_HEADER_BYTES + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  return Buffer.concat([file, ...chunks])
}

/**
 * Read the representations back out of one ICNS file.
 * @param icns - Bytes written by {@link packIcns} or another PNG-representation ICNS producer.
 * @returns representations in file order, each PNG checked against the edge its type declares.
 */
export function unpackIcns(icns: Buffer): IcnsEntry[] {
  if (icns.length < FILE_HEADER_BYTES || icns.subarray(0, 4).toString('ascii') !== ICNS_MAGIC) {
    throw new Error('application icon: not an ICNS file')
  }
  const declared = icns.readUInt32BE(4)
  if (declared !== icns.length) throw new Error(`application icon: file declares ${String(declared)} bytes but holds ${String(icns.length)}`)
  const entries: IcnsEntry[] = []
  let offset = FILE_HEADER_BYTES
  while (offset < icns.length) {
    if (offset + ENTRY_HEADER_BYTES > icns.length) throw new Error('application icon: truncated representation header')
    const type = icns.subarray(offset, offset + 4).toString('ascii')
    const length = icns.readUInt32BE(offset + 4)
    if (length < ENTRY_HEADER_BYTES || offset + length > icns.length) {
      throw new Error(`application icon: representation ${type} declares ${String(length)} bytes`)
    }
    const size = BITMAP_SIZES.get(type)
    if (size === undefined) throw new Error(`application icon: unknown representation type ${JSON.stringify(type)}`)
    const png = icns.subarray(offset + ENTRY_HEADER_BYTES, offset + length)
    const { width, height } = pngDimensions(png)
    if (width !== size || height !== size) {
      throw new Error(`application icon: representation ${type} declares ${String(size)} but holds ${String(width)}x${String(height)}`)
    }
    entries.push({ type, size, png })
    offset += length
  }
  return entries
}

/**
 * Rasterize the icon artwork at every representation size.
 * @param source - PNG artwork at least as large as the largest representation.
 * @param bitmaps - Representation types and edges to produce.
 * @returns representations in the given order, each one resampled from the source rather than from another bitmap.
 */
export async function renderIconEntries(source: Buffer,
  bitmaps: readonly IcnsBitmap[] = ICNS_BITMAPS): Promise<IcnsEntry[]> {
  return Promise.all(bitmaps.map(async ({ type, size }) => ({
    type,
    size,
    png: await sharp(source).resize(size, size).png().toBuffer(),
  })))
}

/**
 * Write the application icon a macOS bundle needs into its Resources directory.
 * @param source - PNG artwork at least as large as the largest representation.
 * @param destination - ICNS file to create or replace, named by the bundle's `CFBundleIconFile`.
 */
export async function writeDevelopmentIcon(source: string, destination: string): Promise<void> {
  await writeFile(destination, packIcns(await renderIconEntries(await readFile(source))))
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('application icon: bitmap is not a PNG stream')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}
