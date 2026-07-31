import { describe, expect, test } from 'bun:test'
import { readImageSize } from './image-size'

/** Builds a header rather than a whole file — the reader only ever sees the head anyway. */
function bytes(...parts: (number | number[] | string)[]): Uint8Array {
  const flat: number[] = []
  for (const part of parts) {
    if (typeof part === 'string') for (const char of part) flat.push(char.charCodeAt(0))
    else if (Array.isArray(part)) flat.push(...part)
    else flat.push(part)
  }
  return new Uint8Array(flat)
}

const u16be = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const u16le = (value: number) => [value & 0xff, (value >> 8) & 0xff]
const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
]

describe('readImageSize', () => {
  test('reads a PNG IHDR', () => {
    const png = bytes(
      0x89,
      'PNG',
      [0x0d, 0x0a, 0x1a, 0x0a],
      u32be(13),
      'IHDR',
      u32be(1920),
      u32be(1080),
    )
    expect(readImageSize(png)).toEqual({ width: 1920, height: 1080 })
  })

  test('reads a GIF screen descriptor, which is little-endian', () => {
    expect(readImageSize(bytes('GIF89a', u16le(640), u16le(480), 0x00, 0x00))).toEqual({
      width: 640,
      height: 480,
    })
    expect(readImageSize(bytes('GIF87a', u16le(16), u16le(16), 0x00, 0x00))).toEqual({
      width: 16,
      height: 16,
    })
  })

  test('reads all three WebP encodings', () => {
    const lossy = bytes(
      'RIFF',
      u32be(0),
      'WEBP',
      'VP8 ',
      u32be(0),
      [0x00, 0x00, 0x00],
      [0x9d, 0x01, 0x2a],
      u16le(800),
      u16le(600),
    )
    expect(readImageSize(lossy)).toEqual({ width: 800, height: 600 })

    // Lossless packs width-1 and height-1 into 14 bits each, low bits first.
    const packed = (300 - 1) | ((200 - 1) << 14)
    const lossless = bytes('RIFF', u32be(0), 'WEBP', 'VP8L', u32be(0), 0x2f, [
      packed & 0xff,
      (packed >> 8) & 0xff,
      (packed >> 16) & 0xff,
      (packed >>> 24) & 0xff,
    ])
    expect(readImageSize(lossless)).toEqual({ width: 300, height: 200 })

    const extended = bytes(
      'RIFF',
      u32be(0),
      'WEBP',
      'VP8X',
      u32be(10),
      [0x00, 0x00, 0x00, 0x00],
      [(4000 - 1) & 0xff, ((4000 - 1) >> 8) & 0xff, 0x00],
      [(3000 - 1) & 0xff, ((3000 - 1) >> 8) & 0xff, 0x00],
    )
    expect(readImageSize(extended)).toEqual({ width: 4000, height: 3000 })
  })

  test('reads a JPEG frame header past a metadata segment', () => {
    const exif = bytes(0xff, 0xe1, u16be(2 + 6), 'Exif', [0x00, 0x00])
    const sof0 = bytes(0xff, 0xc0, u16be(2 + 6), 0x08, u16be(768), u16be(1024), 0x03)
    const jpeg = bytes([0xff, 0xd8], [...exif], [...sof0])
    expect(readImageSize(jpeg)).toEqual({ width: 1024, height: 768 })
  })

  test('reads a progressive JPEG, whose frame marker is 0xc2', () => {
    const jpeg = bytes([0xff, 0xd8], [0xff, 0xc2], u16be(2 + 6), 0x08, u16be(200), u16be(400), 0x03)
    expect(readImageSize(jpeg)).toEqual({ width: 400, height: 200 })
  })

  test('does not mistake a Huffman table for a frame', () => {
    const dht = bytes(0xff, 0xc4, u16be(2 + 4), [0x00, 0x01, 0x02, 0x03])
    const sof0 = bytes(0xff, 0xc0, u16be(2 + 6), 0x08, u16be(10), u16be(20), 0x03)
    expect(readImageSize(bytes([0xff, 0xd8], [...dht], [...sof0]))).toEqual({
      width: 20,
      height: 10,
    })
  })

  test('gives up rather than guessing on formats it does not know', () => {
    expect(readImageSize(bytes('%PDF-1.7', [0x0a, 0x25]))).toBeNull()
    expect(readImageSize(bytes('<svg viewBox="0 0 24 24">'))).toBeNull()
    expect(readImageSize(new Uint8Array(0))).toBeNull()
    // Truncated PNG: the signature matches but IHDR never arrives.
    expect(readImageSize(bytes(0x89, 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull()
  })

  test('stops at the start of scan instead of reading compressed data as a segment', () => {
    const jpeg = bytes([0xff, 0xd8], [0xff, 0xda], u16be(2 + 2), [0x00, 0x00, 0xff, 0xc0])
    expect(readImageSize(jpeg)).toBeNull()
  })
})
