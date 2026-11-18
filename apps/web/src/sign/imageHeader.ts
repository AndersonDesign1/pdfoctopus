// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What kind of picture a file is, and how many pixels it has, read from its first bytes
// without decoding it. A small file can claim billions of pixels; decoding it would exhaust
// the browser's memory, so pictures are checked before they're decoded.

export type PictureFormat = "png" | "gif" | "jpeg" | "webp" | "bmp" | "avif";

export interface PictureHeader {
  format: PictureFormat;
  /** Size in pixels, when the header gives it (null if it couldn't be found in the bytes read). */
  width: number | null;
  height: number | null;
}

/** How many leading bytes to read: enough to get past a JPEG's camera data to its size. */
export const HEADER_BYTES = 1024 * 1024;

const ascii = (b: Uint8Array, at: number, text: string) =>
  [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));

/** The format and size from a picture's first bytes, or null if it isn't a format we know. */
export function readPictureHeader(b: Uint8Array): PictureHeader | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const has = (n: number) => b.length >= n;

  if (has(24) && b[0] === 0x89 && ascii(b, 1, "PNG")) {
    return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (has(10) && ascii(b, 0, "GIF8")) {
    return { format: "gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (has(26) && ascii(b, 0, "BM")) {
    // The old OS/2 header (12 bytes) has 16-bit sizes; every later one has 32-bit sizes.
    if (view.getUint32(14, true) === 12) {
      return { format: "bmp", width: view.getUint16(18, true), height: view.getUint16(20, true) };
    }
    return {
      format: "bmp",
      width: Math.abs(view.getInt32(18, true)),
      height: Math.abs(view.getInt32(22, true)),
    };
  }
  if (has(30) && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
    if (ascii(b, 12, "VP8 ")) {
      return {
        format: "webp",
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (ascii(b, 12, "VP8L")) {
      const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]] as number[] as [
        number,
        number,
        number,
        number,
      ];
      return {
        format: "webp",
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (ascii(b, 12, "VP8X")) {
      const u24 = (at: number) =>
        (b[at] as number) | ((b[at + 1] as number) << 8) | ((b[at + 2] as number) << 16);
      return { format: "webp", width: 1 + u24(24), height: 1 + u24(27) };
    }
    return { format: "webp", width: null, height: null };
  }
  if (has(4) && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the markers to the frame header (SOF0–SOF15, except DHT, JPG and DAC).
    let i = 2;
    while (i + 9 <= b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1] as number;
      if (marker === 0xff) {
        i++; // padding
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) {
        return { format: "jpeg", width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // markers with no length
        continue;
      }
      i += 2 + view.getUint16(i + 2);
    }
    return { format: "jpeg", width: null, height: null };
  }
  if (has(12) && ascii(b, 4, "ftyp") && (ascii(b, 8, "avif") || ascii(b, 8, "avis"))) {
    // The image's size is in its "ispe" property: 4 bytes of version and flags, then
    // width and height.
    for (let i = 12; i + 16 <= b.length; i++) {
      if (ascii(b, i, "ispe")) {
        return { format: "avif", width: view.getUint32(i + 8), height: view.getUint32(i + 12) };
      }
    }
    return { format: "avif", width: null, height: null };
  }
  return null;
}
