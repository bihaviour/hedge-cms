/**
 * Intrinsic pixel dimensions read out of an image's header bytes.
 *
 * Deliberately not an image library. PNG, GIF, WebP and JPEG all carry width and height in their
 * first few dozen bytes — JPEG in the first frame header, which sits behind whatever metadata the
 * camera wrote — and between them they cover essentially everything a CMS receives. Anything else
 * returns null, which is exactly what the `width`/`height` columns already mean.
 *
 * Callers pass the head of the file, not the file: nothing here needs a 20 MB photo in memory to
 * learn it is 3000 pixels wide.
 */
export interface ImageSize {
  width: number
  height: number
}

/** Enough to clear a large EXIF block and reach a JPEG's frame header. */
export const IMAGE_HEAD_BYTES = 64 * 1024

export function readImageSize(bytes: Uint8Array): ImageSize | null {
  return readPng(bytes) ?? readGif(bytes) ?? readWebp(bytes) ?? readJpeg(bytes)
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Compares bytes at `offset` against ASCII `signature`. */
function startsWith(bytes: Uint8Array, signature: string, offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature.charCodeAt(i)) return false
  }
  return true
}

/** `\x89PNG\r\n\x1a\n`, then an IHDR chunk whose first two fields are the dimensions. */
function readPng(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) return null
  if (bytes[0] !== 0x89 || !startsWith(bytes, 'PNG', 1)) return null
  if (!startsWith(bytes, 'IHDR', 12)) return null

  const data = view(bytes)
  return { width: data.getUint32(16), height: data.getUint32(20) }
}

/** `GIF87a` / `GIF89a`, then the logical screen descriptor — little-endian, unlike everything else. */
function readGif(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null
  if (!startsWith(bytes, 'GIF87a') && !startsWith(bytes, 'GIF89a')) return null

  const data = view(bytes)
  return { width: data.getUint16(6, true), height: data.getUint16(8, true) }
}

/**
 * A RIFF container whose first chunk says which of the three WebP encodings this is. All three
 * store dimensions as 14-bit fields, so the masking below is the format, not defensiveness.
 */
function readWebp(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 25) return null
  if (!startsWith(bytes, 'RIFF') || !startsWith(bytes, 'WEBP', 8)) return null

  const data = view(bytes)

  // Extended: an explicit canvas size, one-based and stored as two 24-bit little-endian ints.
  if (startsWith(bytes, 'VP8X', 12)) {
    if (bytes.length < 30) return null
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1
    return { width, height }
  }

  // Lossless: 14 bits of width then 14 of height, packed into one little-endian word.
  if (startsWith(bytes, 'VP8L', 12)) {
    if (bytes[20] !== 0x2f) return null
    const bits = data.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }

  // Lossy: a 3-byte frame tag, the `\x9d\x01\x2a` start code, then the two dimensions.
  if (startsWith(bytes, 'VP8 ', 12)) {
    if (bytes.length < 30) return null
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return {
      width: data.getUint16(26, true) & 0x3fff,
      height: data.getUint16(28, true) & 0x3fff,
    }
  }

  return null
}

/**
 * Markers that open a frame and therefore carry the dimensions. `0xc4` (Huffman tables), `0xc8`
 * (a reserved JPEG extension) and `0xcc` (arithmetic coding conditioning) sit in the same numeric
 * range and are not frames.
 */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

/**
 * Walks the segment chain from `\xff\xd8` to the first frame header. Metadata segments — EXIF,
 * ICC profiles, an embedded thumbnail — come first and can be tens of kilobytes, which is why the
 * head handed in here is generous.
 */
function readJpeg(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  const data = view(bytes)
  let offset = 2

  while (offset + 4 <= bytes.length) {
    // Segments are padded with fill bytes; skip them rather than giving up on the file.
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1]!
    offset += 2
    if (marker === 0xff) {
      offset--
      continue
    }
    // Standalone markers carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
    // Start of scan: past this point is entropy-coded data, not segments.
    if (marker === 0xda) return null

    if (offset + 2 > bytes.length) return null
    const length = data.getUint16(offset)
    if (length < 2) return null

    if (isFrameMarker(marker)) {
      // length, 1 byte of sample precision, then height and width in that order.
      if (offset + 7 > bytes.length) return null
      return { width: data.getUint16(offset + 5), height: data.getUint16(offset + 3) }
    }

    offset += length
  }

  return null
}
