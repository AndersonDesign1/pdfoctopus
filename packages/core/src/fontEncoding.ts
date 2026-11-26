// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Font encodings for text editing: what character each code of a simple font stands for
// (WinAnsi, MacRoman, Standard, Differences with glyph names), and ToUnicode CMaps. Pure
// functions, no MuPDF.

import { ContentStreamError, type Operand, parseContent } from "./contentStream";

export type BaseEncoding = "WinAnsiEncoding" | "MacRomanEncoding" | "StandardEncoding";

/** 256 entries: the character for each code, or "" where the encoding has none. */
export type CodeTable = readonly string[];

function decoderTable(label: string, undefinedCodes: readonly number[] = []): string[] {
  const decoder = new TextDecoder(label);
  const table: string[] = [];
  for (let code = 0; code < 256; code++) {
    if (code < 32 || code === 127 || undefinedCodes.includes(code)) {
      table.push("");
      continue;
    }
    table.push(decoder.decode(Uint8Array.of(code)));
  }
  return table;
}

let winAnsi: string[] | undefined;
let macRoman: string[] | undefined;
let standard: string[] | undefined;

/** Windows code page 1252, as PDF's WinAnsiEncoding uses it (five codes are unused). */
export function winAnsiTable(): CodeTable {
  winAnsi ??= decoderTable("windows-1252", [0x81, 0x8d, 0x8f, 0x90, 0x9d]);
  return winAnsi;
}

export function macRomanTable(): CodeTable {
  macRoman ??= decoderTable("macintosh");
  return macRoman;
}

/** Adobe StandardEncoding: ASCII with curly quotes, and its own upper half. */
export function standardTable(): CodeTable {
  if (!standard) {
    const t: string[] = [];
    for (let code = 0; code < 256; code++) {
      t.push(code >= 32 && code < 127 ? String.fromCharCode(code) : "");
    }
    t[0x27] = "’";
    t[0x60] = "‘";
    const upper: Record<number, string> = {
      161: "¡",
      162: "¢",
      163: "£",
      164: "⁄",
      165: "¥",
      166: "ƒ",
      167: "§",
      168: "¤",
      169: "'",
      170: "“",
      171: "«",
      172: "‹",
      173: "›",
      174: "ﬁ",
      175: "ﬂ",
      177: "–",
      178: "†",
      179: "‡",
      180: "·",
      182: "¶",
      183: "•",
      184: "‚",
      185: "„",
      186: "”",
      187: "»",
      188: "…",
      189: "‰",
      191: "¿",
      193: "`",
      194: "´",
      195: "ˆ",
      196: "˜",
      197: "¯",
      198: "˘",
      199: "˙",
      200: "¨",
      202: "˚",
      203: "¸",
      205: "˝",
      206: "˛",
      207: "ˇ",
      208: "—",
      225: "Æ",
      227: "ª",
      232: "Ł",
      233: "Ø",
      234: "Œ",
      235: "º",
      241: "æ",
      245: "ı",
      248: "ł",
      249: "ø",
      250: "œ",
      251: "ß",
    };
    for (const [code, ch] of Object.entries(upper)) t[Number(code)] = ch;
    standard = t;
  }
  return standard;
}

export function baseTable(name: string): CodeTable | null {
  if (name === "WinAnsiEncoding") return winAnsiTable();
  if (name === "MacRomanEncoding") return macRomanTable();
  if (name === "StandardEncoding") return standardTable();
  return null;
}

// Glyph names (Adobe Glyph List) for the characters of the Latin encodings above. Names not
// listed are read from "uniXXXX" and "uXXXX" forms, or not at all.
const LATIN1_UPPER =
  "space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine " +
  "guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior " +
  "acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter " +
  "onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE " +
  "Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde " +
  "Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis " +
  "Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave " +
  "eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute " +
  "ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn " +
  "ydieresis";
const ASCII_NAMES =
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright " +
  "asterisk plus comma hyphen period slash zero one two three four five six seven eight nine " +
  "colon semicolon less equal greater question at";
const ASCII_NAMES_2 = "bracketleft backslash bracketright asciicircum underscore grave";
const ASCII_NAMES_3 = "braceleft bar braceright asciitilde";
const EXTRA_NAMES: Record<string, string> = {
  Euro: "€",
  quotesinglbase: "‚",
  florin: "ƒ",
  quotedblbase: "„",
  ellipsis: "…",
  dagger: "†",
  daggerdbl: "‡",
  circumflex: "ˆ",
  perthousand: "‰",
  Scaron: "Š",
  scaron: "š",
  guilsinglleft: "‹",
  guilsinglright: "›",
  OE: "Œ",
  oe: "œ",
  Zcaron: "Ž",
  zcaron: "ž",
  quoteleft: "‘",
  quoteright: "’",
  quotedblleft: "“",
  quotedblright: "”",
  bullet: "•",
  endash: "–",
  emdash: "—",
  tilde: "˜",
  trademark: "™",
  Ydieresis: "Ÿ",
  dotlessi: "ı",
  Lslash: "Ł",
  lslash: "ł",
  fraction: "⁄",
  caron: "ˇ",
  breve: "˘",
  dotaccent: "˙",
  ring: "˚",
  ogonek: "˛",
  hungarumlaut: "˝",
  minus: "−",
  nbspace: "\u00a0",
  sfthyphen: "\u00ad",
  fi: "fi",
  fl: "fl",
  ff: "ff",
  ffi: "ffi",
  ffl: "ffl",
};

let glyphNames: Map<string, string> | undefined;

function glyphNameTable(): Map<string, string> {
  if (glyphNames) return glyphNames;
  const map = new Map<string, string>();
  for (const [i, name] of ASCII_NAMES.split(" ").entries())
    map.set(name, String.fromCharCode(32 + i));
  for (const [i, name] of ASCII_NAMES_2.split(" ").entries())
    map.set(name, String.fromCharCode(91 + i));
  for (const [i, name] of ASCII_NAMES_3.split(" ").entries())
    map.set(name, String.fromCharCode(123 + i));
  for (let i = 0; i < 26; i++) {
    map.set(String.fromCharCode(65 + i), String.fromCharCode(65 + i));
    map.set(String.fromCharCode(97 + i), String.fromCharCode(97 + i));
  }
  LATIN1_UPPER.split(" ").forEach((name, i) => {
    if (i > 0) map.set(name, String.fromCharCode(0xa0 + i));
  });
  for (const [name, ch] of Object.entries(EXTRA_NAMES)) map.set(name, ch);
  glyphNames = map;
  return map;
}

/** The text a glyph name stands for, e.g. "eacute" → "é", "uni20AC" → "€"; "" if unknown. */
export function glyphNameToUnicode(name: string): string {
  const known = glyphNameTable().get(name);
  if (known !== undefined) return known;
  // "a.sc", "f_i" and the like: only the simple forms are read.
  let m = /^uni([0-9A-F]{4})$/.exec(name);
  if (m) return fromCodePoint(Number.parseInt(m[1] as string, 16));
  m = /^u([0-9A-F]{4,6})$/.exec(name);
  if (m) return fromCodePoint(Number.parseInt(m[1] as string, 16));
  return "";
}

function fromCodePoint(cp: number): string {
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
  return String.fromCodePoint(cp);
}

/**
 * A simple font's code table: a base encoding with /Differences applied. `differences` is
 * the array as read: a code, then glyph names for it and the codes after it.
 */
export function simpleEncoding(
  base: CodeTable | null,
  differences: readonly (number | string)[] = [],
): { table: string[]; fromDifferences: Set<number> } {
  const table = base ? [...base] : new Array<string>(256).fill("");
  const fromDifferences = new Set<number>();
  let code = -1;
  for (const item of differences) {
    if (typeof item === "number") {
      code = Number.isInteger(item) ? item : -1;
      continue;
    }
    if (code >= 0 && code < 256) {
      table[code] = glyphNameToUnicode(item);
      fromDifferences.add(code);
    }
    if (code >= 0) code++;
  }
  return { table, fromDifferences };
}

// ---------------------------------------------------------------------------------------------
// ToUnicode CMaps

export interface UnicodeMap {
  /** The text for a code (as its bytes read big-endian), or undefined. */
  lookup(code: number, bytes: number): string | undefined;
  /** A code (and its length in bytes) that maps to exactly this text, or null. */
  find(text: string): { code: number; bytes: number } | null;
}

const MAX_CMAP_ENTRIES = 100_000;

interface Range {
  lo: number;
  hi: number;
  bytes: number;
  /** Either a starting UTF-16 string whose last unit counts up, or one string per code. */
  start?: number[];
  list?: string[];
}

/** Parse a ToUnicode CMap stream. Returns null if it can't be read. */
export function parseToUnicode(data: Uint8Array): UnicodeMap | null {
  let ops: ReturnType<typeof parseContent>;
  try {
    ops = parseContent(data);
  } catch (err) {
    if (err instanceof ContentStreamError) return null;
    throw err;
  }
  const single = new Map<string, string>(); // `${bytes}:${code}` → text
  const ranges: Range[] = [];
  let count = 0;
  const codeOf = (o: Operand | undefined): { code: number; bytes: number } | null => {
    if (o?.kind !== "string" || o.bytes.length === 0 || o.bytes.length > 4) return null;
    let code = 0;
    for (const b of o.bytes) code = code * 256 + b;
    return { code, bytes: o.bytes.length };
  };
  for (const op of ops) {
    if (op.op === "endbfchar") {
      for (let i = 0; i + 1 < op.operands.length; i += 2) {
        const src = codeOf(op.operands[i]);
        const dst = op.operands[i + 1];
        if (!src || dst?.kind !== "string") continue;
        if (++count > MAX_CMAP_ENTRIES) return null;
        single.set(`${src.bytes}:${src.code}`, utf16(dst.bytes));
      }
    } else if (op.op === "endbfrange") {
      for (let i = 0; i + 2 < op.operands.length; i += 3) {
        const lo = codeOf(op.operands[i]);
        const hi = codeOf(op.operands[i + 1]);
        const dst = op.operands[i + 2];
        if (!lo || !hi || lo.bytes !== hi.bytes || hi.code < lo.code) continue;
        if (++count > MAX_CMAP_ENTRIES) return null;
        if (dst?.kind === "string" && dst.bytes.length >= 2) {
          ranges.push({ lo: lo.code, hi: hi.code, bytes: lo.bytes, start: units(dst.bytes) });
        } else if (dst?.kind === "array") {
          const list = dst.items.map((s) => (s.kind === "string" ? utf16(s.bytes) : ""));
          ranges.push({ lo: lo.code, hi: hi.code, bytes: lo.bytes, list });
        }
      }
    }
  }
  let reverse: Map<string, { code: number; bytes: number }> | undefined;
  return {
    lookup(code, bytes) {
      const s = single.get(`${bytes}:${code}`);
      if (s !== undefined) return s;
      for (const r of ranges) {
        if (r.bytes !== bytes || code < r.lo || code > r.hi) continue;
        if (r.list) return r.list[code - r.lo];
        const u = [...(r.start as number[])];
        u[u.length - 1] = (u[u.length - 1] as number) + (code - r.lo);
        return String.fromCharCode(...u);
      }
      return undefined;
    },
    find(text) {
      if (!reverse) {
        reverse = new Map();
        for (const [key, value] of single) {
          const [bytes, code] = key.split(":").map(Number) as [number, number];
          // The lowest code wins, as a stable choice when several codes map to one character.
          const known = reverse.get(value);
          if (!known || code < known.code) reverse.set(value, { code, bytes });
        }
      }
      const hit = reverse.get(text);
      if (hit) return hit;
      if ([...text].length !== 1) return null;
      const units16 = textUnits(text);
      for (const r of ranges) {
        if (r.list) {
          const i = r.list.indexOf(text);
          if (i >= 0) return { code: r.lo + i, bytes: r.bytes };
          continue;
        }
        const start = r.start as number[];
        if (units16.length !== start.length) continue;
        let same = true;
        for (let k = 0; k < start.length - 1; k++) if (units16[k] !== start[k]) same = false;
        if (!same) continue;
        const delta = (units16[units16.length - 1] as number) - (start[start.length - 1] as number);
        if (delta >= 0 && delta <= r.hi - r.lo) return { code: r.lo + delta, bytes: r.bytes };
      }
      return null;
    },
  };
}

function units(bytes: Uint8Array): number[] {
  const u: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2)
    u.push(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
  return u;
}

function textUnits(text: string): number[] {
  const u: number[] = [];
  for (let i = 0; i < text.length; i++) u.push(text.charCodeAt(i));
  return u;
}

function utf16(bytes: Uint8Array): string {
  if (bytes.length === 1) return String.fromCharCode(bytes[0] as number);
  return String.fromCharCode(...units(bytes));
}
