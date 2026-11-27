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
// The file's own bytes are scanned (skipping strings, comments and stream data), and so is
// every object stream, decompressed, since the objects packed in one are parsed the same way.

import * as mupdf from "mupdf";

/** Deepest nesting of arrays and dictionaries allowed in an object. */
export const MAX_OBJECT_NESTING = 64;

/** At most this many object streams are opened to check (a file has a few dozen at most). */
const MAX_OBJECT_STREAMS = 10_000;

export const TOO_DEEP_MESSAGE =
  "This file can't be opened safely: its objects are nested too deeply (it may be damaged, or made to crash PDF readers)";

const WHITESPACE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WHITESPACE[c] = 1;

const ASCII = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const STREAM = ASCII("stream");
const ENDSTREAM = ASCII("endstream");
const ENDOBJ = ASCII("endobj");

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

/**
 * The deepest nesting of arrays and dictionaries in PDF object syntax, outside strings,
 * comments and stream data. Each object ("endobj") starts again from zero. Stops early,
 * returning more than `limit`, once it's past `limit`.
 */
export function objectNesting(bytes: Uint8Array, limit = MAX_OBJECT_NESTING): number {
  const n = bytes.length;
  let depth = 0;
  let deepest = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i] as number;
    switch (c) {
      case 0x25 /* % */:
        while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
        break;
      case 0x28 /* ( */:
        {
          let parens = 1;
          for (i++; i < n && parens > 0; i++) {
            const s = bytes[i];
            if (s === 0x5c /* \ */) i++;
            else if (s === 0x28) parens++;
            else if (s === 0x29) parens--;
          }
          i--;
          break;
        }
      case 0x3c /* < */:
        if (bytes[i + 1] === 0x3c) {
          i++;
          if (++depth > deepest) deepest = depth;
        } else {
          while (i < n && bytes[i] !== 0x3e) i++;
        }
        break;
      case 0x3e /* > */:
        if (bytes[i + 1] === 0x3e) {
          i++;
          if (depth > 0) depth--;
        }
        break;
      case 0x5b /* [ */:
        if (++depth > deepest) deepest = depth;
        break;
      case 0x5d /* ] */:
        if (depth > 0) depth--;
        break;
      case 0x73 /* s */:
        // "stream" as a keyword: skip its data, up to "endstream".
        if (matchesAt(bytes, i, STREAM) && (i === 0 || !isRegular(bytes[i - 1] as number))) {
          const end = indexOf(bytes, ENDSTREAM, i + STREAM.length);
          if (end < 0) return deepest;
          i = end + ENDSTREAM.length - 1;
          depth = 0;
        }
        break;
      case 0x65 /* e */:
        if (matchesAt(bytes, i, ENDOBJ)) depth = 0;
        break;
    }
    if (deepest > limit) return deepest;
  }
  return deepest;
}

function isRegular(c: number): boolean {
  return !WHITESPACE[c] && !"()<>[]{}/%".includes(String.fromCharCode(c));
}

/**
 * The object streams in the file, as raw dictionary text and data. Found by their
 * "/Type /ObjStm" in the file's own bytes, where every object stream's dictionary is.
 */
function objectStreams(bytes: Uint8Array): { dict: string; data: Uint8Array }[] {
  const out: { dict: string; data: Uint8Array }[] = [];
  const marker = ASCII("/ObjStm");
  for (let at = indexOf(bytes, marker, 0); at >= 0; at = indexOf(bytes, marker, at + 1)) {
    if (out.length >= MAX_OBJECT_STREAMS) break;
    const start = indexOf(bytes, STREAM, at);
    if (start < 0) break;
    // The dictionary: back from the marker to "obj".
    let open = at;
    const floor = Math.max(0, at - 4096);
    while (open > floor && !(bytes[open] === 0x3c && bytes[open + 1] === 0x3c)) open--;
    let dict = "";
    for (let i = open; i < start; i++) dict += String.fromCharCode(bytes[i] as number);
    let dataStart = start + STREAM.length;
    if (bytes[dataStart] === 13) dataStart++;
    if (bytes[dataStart] === 10) dataStart++;
    const end = indexOf(bytes, ENDSTREAM, dataStart);
    if (end < 0) break;
    out.push({ dict: dict.trim(), data: bytes.subarray(dataStart, end) });
    at = end;
  }
  return out;
}

/** An object stream's data decompressed by MuPDF (from a one-object file), or null. */
function decompress(dict: string, data: Uint8Array): Uint8Array | null {
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
      return buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
  } catch {
    // Encrypted or broken: MuPDF won't be able to read the objects in it either.
    return null;
  } finally {
    doc?.destroy();
  }
}

/** Why the file can't be opened safely (objects nested too deeply), or null. */
export function nestingProblem(bytes: Uint8Array): string | null {
  if (objectNesting(bytes) > MAX_OBJECT_NESTING) return TOO_DEEP_MESSAGE;
  for (const { dict, data } of objectStreams(bytes)) {
    if (objectNesting(Uint8Array.from(dict, (c) => c.charCodeAt(0) & 0xff)) > MAX_OBJECT_NESTING) {
      return TOO_DEEP_MESSAGE;
    }
    const plain = decompress(dict, data);
    if (plain && objectNesting(plain) > MAX_OBJECT_NESTING) return TOO_DEEP_MESSAGE;
  }
  return null;
}
