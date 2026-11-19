// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A minimal ZIP writer, for downloading several exported files at once. Files are stored,
// not compressed: pictures (PNG, JPEG) are compressed already, and keeping it simple means no
// dependency. No ZIP64, so the whole archive must stay under 4 GB and 65,535 files.

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** The largest archive written, in bytes (ZIP without ZIP64 counts to 4 GB). */
export const MAX_ZIP_BYTES = 0xffff_fffe;
/** The most files in one archive (without ZIP64). */
export const MAX_ZIP_FILES = 0xffff;

let crcTable: Uint32Array | null = null;

/** CRC-32 (the one ZIP and PNG use). */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (table[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A date and time in MS-DOS format (local time, two-second steps, from 1980). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** A ZIP archive of the files, in order. Names are stored as UTF-8. */
export function zipFiles(entries: readonly ZipEntry[], now = new Date()): Uint8Array {
  if (entries.length > MAX_ZIP_FILES) throw new Error("Too many files for one ZIP archive");
  const encoder = new TextEncoder();
  const names = entries.map((e) => encoder.encode(e.name));
  let total = 22;
  for (const [i, e] of entries.entries()) {
    const n = (names[i] as Uint8Array).length;
    if (n > 0xffff) throw new Error("A file name is too long");
    total += 30 + n + e.bytes.length + 46 + n;
  }
  if (total > MAX_ZIP_BYTES) {
    throw new Error("That's too much for one ZIP archive (4 GB at most): choose fewer pages");
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const { time, date } = dosDateTime(now);
  // Bit 11: the names are UTF-8.
  const FLAGS = 0x0800;
  const offsets: number[] = [];
  const crcs: number[] = [];
  let p = 0;
  for (const [i, e] of entries.entries()) {
    const name = names[i] as Uint8Array;
    const crc = crc32(e.bytes);
    offsets.push(p);
    crcs.push(crc);
    view.setUint32(p, 0x04034b50, true); // local file header
    view.setUint16(p + 4, 20, true); // version needed (2.0)
    view.setUint16(p + 6, FLAGS, true);
    view.setUint16(p + 8, 0, true); // stored
    view.setUint16(p + 10, time, true);
    view.setUint16(p + 12, date, true);
    view.setUint32(p + 14, crc, true);
    view.setUint32(p + 18, e.bytes.length, true);
    view.setUint32(p + 22, e.bytes.length, true);
    view.setUint16(p + 26, name.length, true);
    view.setUint16(p + 28, 0, true);
    out.set(name, p + 30);
    out.set(e.bytes, p + 30 + name.length);
    p += 30 + name.length + e.bytes.length;
  }
  const directory = p;
  for (const [i, e] of entries.entries()) {
    const name = names[i] as Uint8Array;
    view.setUint32(p, 0x02014b50, true); // central directory header
    view.setUint16(p + 4, 20, true); // made by
    view.setUint16(p + 6, 20, true); // version needed
    view.setUint16(p + 8, FLAGS, true);
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, time, true);
    view.setUint16(p + 14, date, true);
    view.setUint32(p + 16, crcs[i] as number, true);
    view.setUint32(p + 20, e.bytes.length, true);
    view.setUint32(p + 24, e.bytes.length, true);
    view.setUint16(p + 28, name.length, true);
    // Extra field, comment, disk number, internal and external attributes: all zero.
    view.setUint32(p + 42, offsets[i] as number, true);
    out.set(name, p + 46);
    p += 46 + name.length;
  }
  view.setUint32(p, 0x06054b50, true); // end of central directory
  view.setUint16(p + 8, entries.length, true);
  view.setUint16(p + 10, entries.length, true);
  view.setUint32(p + 12, p - directory, true);
  view.setUint32(p + 16, directory, true);
  return out;
}
