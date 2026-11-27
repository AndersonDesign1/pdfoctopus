// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Refusing files whose objects nest arrays or dictionaries absurdly deeply, before MuPDF reads
// them. MuPDF parses a nested array or dictionary by calling itself, and in the WebAssembly
// build about 190 levels overflow its stack (fewer when it's already deep in other work).
// That doesn't stop with an error: it silently overwrites part of MuPDF's memory, and a
// later, perfectly good file then crashes the engine or comes out wrong. The fuzzer found it
// with a 2 KB file. Real PDFs nest a handful of levels, so anything past MAX_OBJECT_NESTING
// is refused.
//
// The file's own bytes are read token by token (names, strings, hex strings and comments are
// skipped whole, so a name like /stream can't hide anything, and stream data is skipped), and
// so is every object stream, decompressed, since the objects packed in one are parsed the same
// way. Object streams are decompressed within strict limits; a file past them is refused
// rather than opened unchecked.

import * as mupdf from "mupdf";

/** Deepest nesting of arrays and dictionaries allowed in an object. */
export const MAX_OBJECT_NESTING = 64;

/** Most object streams checked (real files have a few hundred at most). */
const MAX_OBJECT_STREAMS = 10_000;

/**
 * Largest object stream checked, compressed: real ones are a few kilobytes. With one filter
 * this keeps what a decompression bomb can make to a few hundred megabytes, briefly.
 */
export const MAX_OBJECT_STREAM_BYTES = 256 * 1024;

/** And at most this much compressed object-stream data in all, per file. */
const MAX_OBJECT_STREAM_TOTAL = 32 * 1024 * 1024;

/** Filters an object stream may use, one at a time (chains multiply a bomb's ratio). */
const OBJECT_STREAM_FILTERS = new Set([
  "FlateDecode",
  "LZWDecode",
  "ASCIIHexDecode",
  "ASCII85Decode",
  "RunLengthDecode",
]);

export const TOO_DEEP_MESSAGE =
  "This file can't be opened safely: its objects are nested too deeply (it may be damaged, or made to crash PDF readers)";

export const TOO_COMPLEX_MESSAGE =
  "This file can't be opened safely: its compressed objects are too large or unusual to check (it may be damaged, or made to crash PDF readers)";

const WHITESPACE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WHITESPACE[c] = 1;
const DELIMITER = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIMITER[c.charCodeAt(0)] = 1;
const isRegular = (c: number) => !WHITESPACE[c] && !DELIMITER[c];

const ASCII = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const STREAM = ASCII("stream");
const ENDSTREAM = ASCII("endstream");

function matchesAt(bytes: Uint8Array, at: number, word: number[]): boolean {
  if (at + word.length > bytes.length) return false;
  for (let i = 0; i < word.length; i++) if (bytes[at + i] !== word[i]) return false;
  return true;
}

function indexOf(bytes: Uint8Array, word: number[], from: number): number {
  const first = word[0] as number;
  for (let i = bytes.indexOf(first, from); i >= 0; i = bytes.indexOf(first, i + 1)) {
    if (matchesAt(bytes, i, word)) return i;
  }
  return -1;
}

/** Where the literal string starting at `at` (its "(") ends, just after its ")". */
function skipString(bytes: Uint8Array, at: number): number {
  let parens = 0;
  let i = at;
  for (; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x5c /* \ */) i++;
    else if (c === 0x28) parens++;
    else if (c === 0x29 && --parens === 0) return i + 1;
  }
  return i;
}

/**
 * The deepest nesting of arrays and dictionaries in PDF object syntax. The bytes are read
 * token by token: comments, strings (with escapes and nested brackets), hex strings and names
 * are skipped whole, and only a whole "stream" or "endobj" keyword counts as one. Stream data
 * is skipped up to "endstream"; with no "endstream" after it, reading carries on right after
 * "stream", so nothing after it goes unchecked. Each object ("endobj") starts again from zero.
 * Stops early, returning more than `limit`, once it's past `limit`.
 */
export function objectNesting(bytes: Uint8Array, limit = MAX_OBJECT_NESTING): number {
  const n = bytes.length;
  let depth = 0;
  let deepest = 0;
  let i = 0;
  while (i < n && deepest <= limit) {
    const c = bytes[i] as number;
    if (WHITESPACE[c]) {
      i++;
    } else if (c === 0x25 /* % */) {
      while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
    } else if (c === 0x28 /* ( */) {
      i = skipString(bytes, i);
    } else if (c === 0x3c /* < */) {
      if (bytes[i + 1] === 0x3c) {
        i += 2;
        deepest = Math.max(deepest, ++depth);
      } else {
        while (i < n && bytes[i] !== 0x3e) i++;
        i++;
      }
    } else if (c === 0x3e /* > */) {
      i += bytes[i + 1] === 0x3e ? 2 : 1;
      if (depth > 0) depth--;
    } else if (c === 0x5b /* [ */) {
      i++;
      deepest = Math.max(deepest, ++depth);
    } else if (c === 0x5d /* ] */) {
      i++;
      if (depth > 0) depth--;
    } else if (c === 0x2f /* / */) {
      // A name: everything up to the next delimiter, whatever it spells.
      i++;
      while (i < n && isRegular(bytes[i] as number)) i++;
    } else if (DELIMITER[c]) {
      // "{" or "}": not object syntax, a single character.
      i++;
    } else {
      // A keyword or a number: the whole token.
      const start = i;
      while (i < n && isRegular(bytes[i] as number)) i++;
      const length = i - start;
      if (length === STREAM.length && matchesAt(bytes, start, STREAM)) {
        const end = indexOf(bytes, ENDSTREAM, i);
        if (end >= 0) {
          i = end + ENDSTREAM.length;
          depth = 0;
        }
      } else if (length === 6 && matchesAt(bytes, start, ASCII("endobj"))) {
        depth = 0;
      }
    }
  }
  return deepest;
}

/** An object stream found in the file's bytes: its dictionary's text and its raw data. */
interface RawObjectStream {
  dict: string;
  data: Uint8Array;
}

/**
 * The object streams in the file, found by their "/ObjStm" in the file's own bytes, where
 * every object stream's dictionary is. Null when there are more than can be checked.
 */
function objectStreams(bytes: Uint8Array): RawObjectStream[] | null {
  const out: RawObjectStream[] = [];
  const marker = ASCII("/ObjStm");
  for (let at = indexOf(bytes, marker, 0); at >= 0; at = indexOf(bytes, marker, at + 1)) {
    if (out.length >= MAX_OBJECT_STREAMS) return null;
    const start = indexOf(bytes, STREAM, at);
    if (start < 0) break;
    // The dictionary: back from the marker to its "<<".
    let open = at;
    const floor = Math.max(0, at - 4096);
    while (open > floor && !(bytes[open] === 0x3c && bytes[open + 1] === 0x3c)) open--;
    let dict = "";
    for (let i = open; i < start; i++) dict += String.fromCharCode(bytes[i] as number);
    let dataStart = start + STREAM.length;
    if (bytes[dataStart] === 13) dataStart++;
    if (bytes[dataStart] === 10) dataStart++;
    let end = indexOf(bytes, ENDSTREAM, dataStart);
    if (end < 0) end = bytes.length;
    out.push({ dict: dict.trim(), data: bytes.subarray(dataStart, end) });
    at = end;
  }
  return out;
}

/** The filters a stream dictionary's text names, or null if they can't be read plainly. */
function filtersOf(dict: string): string[] | null {
  const match = /\/Filter\s*(\[[^\]]*\]|\/[^\s/<>[\]()]+|\d+\s+\d+\s+R)?/.exec(dict);
  if (!match) return [];
  const value = match[1] ?? "";
  if (/R$/.test(value) || value === "") return null;
  return [...value.matchAll(/\/([^\s/<>[\]()]+)/g)].map((m) => m[1] as string);
}

/**
 * How deeply an object stream's objects nest, decompressed by MuPDF (from a one-object file),
 * or null when MuPDF can't decompress it (encrypted or broken: then it can't read the objects
 * in it either).
 */
function decompressedNesting(dict: string, data: Uint8Array): number | null {
  const cleaned = dict
    .replace(/\/Length\s+\d+\s+\d+\s+R/, "")
    .replace(/\/Length\s+\d+/, "")
    .replace(/>>\s*$/, ` /Length ${data.length}>>`);
  // With a correct cross-reference table, so MuPDF doesn't have to repair the file to read it.
  const head = `%PDF-1.7\n1 0 obj\n${cleaned}\nstream\n`;
  const xref = head.length + data.length + "\nendstream\nendobj\n".length;
  const tail =
    "\nendstream\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n" +
    `trailer\n<</Size 2>>\nstartxref\n${xref}\n%%EOF\n`;
  const file = new Uint8Array(head.length + data.length + tail.length);
  file.set(
    Uint8Array.from(head, (c) => c.charCodeAt(0) & 0xff),
    0,
  );
  file.set(data, head.length);
  file.set(
    Uint8Array.from(tail, (c) => c.charCodeAt(0)),
    head.length + data.length,
  );
  let doc: mupdf.Document | null = null;
  try {
    doc = mupdf.Document.openDocument(file, "application/pdf");
    const pdf = doc.asPDF();
    if (!pdf) return null;
    const buffer = pdf.newIndirect(1).readStream();
    try {
      // Scanned in place, without a copy, before the buffer is freed.
      return objectNesting(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  } catch {
    return null;
  } finally {
    doc?.destroy();
  }
}

/**
 * Why the file can't be opened safely (objects nested too deeply, or object streams too large
 * or unusual to check), or null.
 */
export function nestingProblem(bytes: Uint8Array): string | null {
  if (objectNesting(bytes) > MAX_OBJECT_NESTING) return TOO_DEEP_MESSAGE;
  const streams = objectStreams(bytes);
  if (!streams) return TOO_COMPLEX_MESSAGE;
  let total = 0;
  for (const { dict, data } of streams) {
    if (objectNesting(Uint8Array.from(dict, (c) => c.charCodeAt(0) & 0xff)) > MAX_OBJECT_NESTING) {
      return TOO_DEEP_MESSAGE;
    }
    // Checked before anything is decompressed: a small stream can hold a huge one.
    total += data.length;
    const filters = filtersOf(dict);
    if (
      data.length > MAX_OBJECT_STREAM_BYTES ||
      total > MAX_OBJECT_STREAM_TOTAL ||
      !filters ||
      filters.length > 1 ||
      filters.some((f) => !OBJECT_STREAM_FILTERS.has(f))
    ) {
      return TOO_COMPLEX_MESSAGE;
    }
    const depth = decompressedNesting(dict, data);
    if (depth !== null && depth > MAX_OBJECT_NESTING) return TOO_DEEP_MESSAGE;
  }
  return null;
}
