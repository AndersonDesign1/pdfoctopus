// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fonts as text editing needs them: each code's width and character, and which code draws a
// given character, so a new line of text can be written in a page's own font. Also the
// standard fonts used when the page's font doesn't have the characters needed.

import * as mupdf from "mupdf";
import {
  baseTable,
  type CodeTable,
  parseToUnicode,
  simpleEncoding,
  standardTable,
  trueTypeGlyphs,
  type UnicodeMap,
  winAnsiTable,
} from "./fontEncoding";

export interface FontStyle {
  serif: boolean;
  mono: boolean;
  bold: boolean;
  italic: boolean;
}

export interface FontInfo {
  /** BaseFont, e.g. "ABCDEF+DejaVuSans-Bold". */
  baseFont: string;
  /** Why text in this font can't be edited, or null. */
  problem: string | null;
  /** Whether glyph widths are known (even when the font can't be edited), to follow the text. */
  measurable: boolean;
  /** Two-byte codes (a composite font with Identity-H), or one byte per code. */
  twoByte: boolean;
  /** Width of a code in 1/1000 of the font size. */
  width(code: number): number;
  /** The text a code stands for ("" if unknown). */
  unicode(code: number): string;
  /** A code that draws this character with a glyph the font is known to have, or null. */
  encode(ch: string): number | null;
  style: FontStyle;
  embedded: boolean;
  /** Whether its ToUnicode map gives joined Arabic letter forms (Presentation Forms). */
  arabicForms?: boolean;
}

const SUBSET = /^[A-Z]{6}\+/;
const MAX_WIDTHS = 70_000;

/** BaseFont without a subset prefix, e.g. "DejaVuSans-Bold". */
export function plainFontName(baseFont: string): string {
  return baseFont.replace(SUBSET, "");
}

/** A font name as people would say it: "DejaVu Sans Bold" from "ABCDEF+DejaVuSans-Bold". */
export function readableFontName(baseFont: string): string {
  const plain = plainFontName(baseFont)
    .replace(/(MT|PSMT|PS)$/, "")
    .replace(/[-,_]+/g, " ")
    // Only before the usual style words, so "DejaVuSans" becomes "DejaVu Sans", not "Deja Vu".
    .replace(
      /(?<=[a-z])(?=Sans|Serif|Mono|Bold|Italic|Regular|Light|Medium|Oblique|Condensed|Roman|Black|Semibold|New)/g,
      " ",
    )
    .trim();
  return plain || "the font";
}

const STANDARD_ALIASES: Record<string, string> = {
  Arial: "Helvetica",
  ArialMT: "Helvetica",
  "Arial-BoldMT": "Helvetica-Bold",
  "Arial-ItalicMT": "Helvetica-Oblique",
  "Arial-BoldItalicMT": "Helvetica-BoldOblique",
  "Arial,Bold": "Helvetica-Bold",
  "Arial,Italic": "Helvetica-Oblique",
  "Arial,BoldItalic": "Helvetica-BoldOblique",
  TimesNewRoman: "Times-Roman",
  TimesNewRomanPSMT: "Times-Roman",
  "TimesNewRoman,Bold": "Times-Bold",
  "TimesNewRomanPS-BoldMT": "Times-Bold",
  "TimesNewRoman,Italic": "Times-Italic",
  "TimesNewRomanPS-ItalicMT": "Times-Italic",
  "TimesNewRoman,BoldItalic": "Times-BoldItalic",
  "TimesNewRomanPS-BoldItalicMT": "Times-BoldItalic",
  CourierNew: "Courier",
  CourierNewPSMT: "Courier",
  "CourierNew,Bold": "Courier-Bold",
  "CourierNewPS-BoldMT": "Courier-Bold",
};

export const STANDARD_FONTS = [
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
] as const;
export type StandardFont = (typeof STANDARD_FONTS)[number];

const STANDARD_14 = new Set<string>([...STANDARD_FONTS, "Symbol", "ZapfDingbats"]);

function standardName(baseFont: string): string | null {
  const plain = plainFontName(baseFont);
  if (STANDARD_14.has(plain)) return plain;
  return STANDARD_ALIASES[plain] ?? null;
}

const metricFonts = new Map<string, mupdf.Font>();

/** MuPDF's built-in font for a standard font name (metric-compatible with the original). */
function metricFont(name: string): mupdf.Font {
  let font = metricFonts.get(name);
  if (!font) {
    font = new mupdf.Font(name);
    metricFonts.set(name, font);
  }
  return font;
}

/** Width in 1/1000 em of a character in a standard font, or null if it has no glyph. */
export function standardWidth(name: string, ch: string): number | null {
  const font = metricFont(name);
  const gid = font.encodeCharacter(ch);
  if (gid <= 0) return null;
  return font.advanceGlyph(gid) * 1000;
}

function numberAt(array: mupdf.PDFObject, i: number): number {
  const v = array.get(i);
  return v.isNumber() ? v.asNumber() : 0;
}

function styleOf(baseFont: string, descriptor: mupdf.PDFObject): FontStyle {
  const flags = descriptor.isDictionary() ? descriptor.get("Flags") : null;
  const f = flags?.isNumber() ? flags.asNumber() : 0;
  const weight = descriptor.isDictionary() ? descriptor.get("FontWeight") : null;
  const name = plainFontName(baseFont);
  return {
    mono: (f & 1) !== 0 || /courier|mono|consol/i.test(name),
    serif:
      (f & 2) !== 0 ||
      /times|serif|georgia|garamond|roman|cambria|minion|palatino|book/i.test(
        name.replace(/sans/i, ""),
      ),
    italic: (f & 64) !== 0 || /italic|oblique/i.test(name),
    bold:
      (f & 262144) !== 0 ||
      (weight?.isNumber() === true && weight.asNumber() >= 600) ||
      /bold|black|heavy|semibold|demi/i.test(name),
  };
}

function isEmbedded(descriptor: mupdf.PDFObject): boolean {
  if (!descriptor.isDictionary()) return false;
  return ["FontFile", "FontFile2", "FontFile3"].some((k) => descriptor.get(k).isStream());
}

/**
 * The font program embedded for a font, loaded with MuPDF, to check which glyphs it really
 * has. Null if it isn't embedded or can't be loaded.
 */
function embeddedProgram(baseFont: string, descriptor: mupdf.PDFObject): mupdf.Font | null {
  if (!descriptor.isDictionary()) return null;
  for (const key of ["FontFile2", "FontFile3", "FontFile"]) {
    const file = descriptor.get(key);
    if (!file.isStream()) continue;
    try {
      const buffer = file.readStream();
      try {
        // Copied: MuPDF's memory can move during the next call.
        const bytes = buffer.asUint8Array().slice();
        return new mupdf.Font(plainFontName(baseFont) || "font", bytes);
      } finally {
        buffer.destroy();
      }
    } catch {
      return null;
    }
  }
  return null;
}

function readToUnicode(font: mupdf.PDFObject): UnicodeMap | null {
  const stream = font.get("ToUnicode");
  if (!stream.isStream()) return null;
  try {
    const buffer = stream.readStream();
    try {
      return parseToUnicode(buffer.asUint8Array().slice());
    } finally {
      buffer.destroy();
    }
  } catch {
    return null;
  }
}

/** Read a font resource. Never throws: a font it can't use comes back with a `problem`. */
export function loadFont(object: mupdf.PDFObject): FontInfo {
  const font = object.resolve();
  const baseFontObj = font.get("BaseFont");
  const baseFont = baseFontObj.isName() ? baseFontObj.asName() : "";
  const subtype = font.get("Subtype").isName() ? font.get("Subtype").asName() : "";
  try {
    if (subtype === "Type0") return loadType0(font, baseFont);
    if (subtype === "Type1" || subtype === "MMType1" || subtype === "TrueType") {
      return loadSimple(font, baseFont);
    }
    if (subtype === "Type3") {
      return {
        ...unusable(baseFont, "This text uses a drawn (Type 3) font, which can't be edited."),
        ...type3Widths(font),
      };
    }
  } catch {
    // Fall through: anything unexpected in the font means it isn't used.
  }
  return unusable(baseFont, "This text's font can't be read for editing.");
}

/** A Type 3 font's widths (its own units, scaled by its matrix), to follow text after it. */
function type3Widths(font: mupdf.PDFObject): Pick<FontInfo, "width" | "measurable"> {
  const matrix = font.get("FontMatrix");
  const widths = font.get("Widths");
  const firstObj = font.get("FirstChar");
  const scale = matrix.isArray() && matrix.get(0).isNumber() ? matrix.get(0).asNumber() * 1000 : 0;
  const skew = [1, 2].some(
    (i) => matrix.isArray() && matrix.get(i).isNumber() && matrix.get(i).asNumber() !== 0,
  );
  if (!widths.isArray() || !firstObj.isNumber() || !(scale > 0) || skew) {
    return { width: () => 0, measurable: false };
  }
  const first = firstObj.asNumber();
  const list: number[] = [];
  for (let i = 0; i < Math.min(widths.length, 256); i++) list.push(numberAt(widths, i) * scale);
  return { width: (code) => list[code - first] ?? 0, measurable: true };
}

function unusable(baseFont: string, problem: string): FontInfo {
  return {
    baseFont,
    problem,
    measurable: false,
    twoByte: false,
    width: () => 0,
    unicode: () => "",
    encode: () => null,
    style: { serif: false, mono: false, bold: false, italic: false },
    embedded: false,
  };
}

function loadSimple(font: mupdf.PDFObject, baseFont: string): FontInfo {
  const descriptor = font.get("FontDescriptor");
  const embedded = isEmbedded(descriptor);
  const standard = standardName(baseFont);
  const widthsObj = font.get("Widths");
  const firstObj = font.get("FirstChar");
  const first = firstObj.isNumber() ? firstObj.asNumber() : 0;
  const missingObj = descriptor.isDictionary() ? descriptor.get("MissingWidth") : null;
  const missing = missingObj?.isNumber() ? missingObj.asNumber() : 0;
  const widths: number[] = [];
  if (widthsObj.isArray()) {
    const n = Math.min(widthsObj.length, 256);
    for (let i = 0; i < n; i++) widths.push(numberAt(widthsObj, i));
  }

  // Encoding: a name, or a dictionary with a base encoding and differences.
  const encoding = font.get("Encoding");
  let base: CodeTable | null = null;
  let explicit = false;
  const differences: (number | string)[] = [];
  if (encoding.isName()) {
    base = baseTable(encoding.asName());
    explicit = base !== null;
  } else if (encoding.isDictionary()) {
    const b = encoding.get("BaseEncoding");
    if (b.isName()) base = baseTable(b.asName());
    explicit = base !== null;
    const diff = encoding.get("Differences");
    if (diff.isArray()) {
      const n = Math.min(diff.length, 1024);
      for (let i = 0; i < n; i++) {
        const item = diff.get(i);
        if (item.isNumber()) differences.push(item.asNumber());
        else if (item.isName()) differences.push(item.asName());
      }
    }
  }
  const flags = descriptor.isDictionary() ? descriptor.get("Flags") : null;
  const symbolic = flags?.isNumber() === true && (flags.asNumber() & 4) !== 0;
  if (!base && !symbolic && subtype(font) !== "TrueType") base = standardTable();
  if (!base && standard && standard !== "Symbol" && standard !== "ZapfDingbats") {
    base = standardTable();
  }
  const { table, fromDifferences } = simpleEncoding(base, differences);
  const toUnicode = readToUnicode(font);

  let width: (code: number) => number;
  if (widths.length > 0) {
    width = (code) => {
      const i = code - first;
      return i >= 0 && i < widths.length ? (widths[i] as number) : missing;
    };
  } else if (standard) {
    const name = standard;
    width = (code) => {
      const ch = table[code] ?? "";
      return ch ? (standardWidth(name, ch) ?? 0) : 0;
    };
  } else {
    return unusable(baseFont, "This text's font has no widths in the file, so it can't be edited.");
  }

  const unicode = (code: number) => toUnicode?.lookup(code, 1) ?? table[code] ?? "";
  let program: mupdf.Font | null | undefined;
  const hasGlyph = (ch: string) => {
    if (!embedded) return true; // Not embedded: the viewer's substitute font is used anyway.
    if (program === undefined) program = embeddedProgram(baseFont, descriptor);
    return program !== null && program.encodeCharacter(ch) > 0;
  };
  const encode = (ch: string): number | null => {
    if (toUnicode) {
      const hit = toUnicode.find(ch);
      if (hit && hit.bytes === 1 && (width(hit.code) > 0 || ch === " ")) return hit.code;
    }
    // From the encoding: a glyph named in /Differences is in the font; one from the base
    // encoding of an embedded font is only trusted if the font program has it.
    let fallback: number | null = null;
    for (let code = 0; code < 256; code++) {
      if (table[code] !== ch) continue;
      if (toUnicode) {
        const mapped = toUnicode.lookup(code, 1);
        if (mapped !== undefined && mapped !== ch) continue;
      }
      if (widths.length > 0 && width(code) <= 0 && ch !== " ") continue;
      if (fromDifferences.has(code)) return code;
      if (fallback === null && (explicit || !embedded)) fallback = code;
    }
    if (fallback !== null && hasGlyph(ch)) return fallback;
    return null;
  };
  return {
    baseFont,
    problem: null,
    measurable: true,
    twoByte: false,
    width,
    unicode,
    encode,
    style: styleOf(baseFont, descriptor),
    embedded,
    arabicForms: toUnicode?.arabicForms ?? false,
  };
}

function subtype(font: mupdf.PDFObject): string {
  const s = font.get("Subtype");
  return s.isName() ? s.asName() : "";
}

function loadType0(font: mupdf.PDFObject, baseFont: string): FontInfo {
  const encoding = font.get("Encoding");
  const name = encoding.isName() ? encoding.asName() : "";
  if (name === "Identity-V") {
    return unusable(baseFont, "Vertical text can't be edited yet.");
  }
  if (name !== "Identity-H") {
    return unusable(baseFont, "This text's font uses an encoding that can't be edited yet.");
  }
  const descendants = font.get("DescendantFonts");
  const cid = descendants.isArray() ? descendants.get(0).resolve() : null;
  if (!cid?.isDictionary())
    return unusable(baseFont, "This text's font can't be read for editing.");
  const descriptor = cid.get("FontDescriptor");
  const dwObj = cid.get("DW");
  const dw = dwObj.isNumber() ? dwObj.asNumber() : 1000;
  const single = new Map<number, number>();
  const ranges: [number, number, number][] = [];
  const w = cid.get("W");
  if (w.isArray()) {
    const n = Math.min(w.length, MAX_WIDTHS);
    let i = 0;
    while (i < n) {
      const a = w.get(i);
      const b = w.get(i + 1);
      if (!a.isNumber()) break;
      if (b.isArray()) {
        const start = a.asNumber();
        const m = Math.min(b.length, MAX_WIDTHS);
        for (let k = 0; k < m; k++) single.set(start + k, numberAt(b, k));
        i += 2;
      } else if (b.isNumber() && w.get(i + 2).isNumber()) {
        ranges.push([a.asNumber(), b.asNumber(), numberAt(w, i + 2)]);
        i += 3;
      } else {
        break;
      }
    }
  }
  const width = (code: number) => {
    const s = single.get(code);
    if (s !== undefined) return s;
    for (const [lo, hi, v] of ranges) if (code >= lo && code <= hi) return v;
    return dw;
  };
  const toUnicode = readToUnicode(font);
  // Whether the embedded program has a glyph for a code, read when first needed.
  let present: ((code: number) => boolean) | null | undefined;
  const hasGlyph = (code: number) => {
    if (present === undefined) present = cidGlyphs(cid, descriptor);
    return present === null || present(code);
  };
  return {
    baseFont,
    problem: null,
    measurable: true,
    twoByte: true,
    width,
    unicode: (code) => toUnicode?.lookup(code, 2) ?? "",
    encode: (ch) => {
      const hit = toUnicode?.find(ch);
      if (hit?.bytes !== 2) return null;
      if (!(width(hit.code) > 0 || ch === " ")) return null;
      return ch === " " || hasGlyph(hit.code) ? hit.code : null;
    },
    style: styleOf(baseFont, descriptor),
    embedded: isEmbedded(descriptor),
    arabicForms: toUnicode?.arabicForms ?? false,
  };
}

/**
 * For a CIDFont with an embedded TrueType program, whether each code (CID) has a glyph with an
 * outline: subsets often keep every glyph number but leave the unused ones empty. Null when it
 * can't be told (another kind of program, or one that can't be read), so only ToUnicode and the
 * widths are trusted.
 */
const MAX_CID_MAP = 2 * 65536;
function cidGlyphs(
  cid: mupdf.PDFObject,
  descriptor: mupdf.PDFObject,
): ((code: number) => boolean) | null {
  if (!descriptor.isDictionary()) return null;
  const file = descriptor.get("FontFile2");
  if (!file.isStream()) return null;
  try {
    const map = cid.get("CIDToGIDMap");
    let toGid: (code: number) => number = (code) => code;
    if (map.isStream()) {
      const buffer = map.readStream();
      let bytes: Uint8Array;
      try {
        bytes = buffer.asUint8Array().slice(0, MAX_CID_MAP);
      } finally {
        buffer.destroy();
      }
      toGid = (code) =>
        2 * code + 1 < bytes.length
          ? ((bytes[2 * code] as number) << 8) | (bytes[2 * code + 1] as number)
          : 0;
    } else if (!(map.isNull() || (map.isName() && map.asName() === "Identity"))) {
      return null;
    }
    const buffer = file.readStream();
    let program: Uint8Array;
    try {
      program = buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
    const glyphs = trueTypeGlyphs(program);
    if (!glyphs) return null;
    return (code) => {
      const gid = toGid(code);
      return gid > 0 && glyphs(gid);
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Standard fonts for characters a page's font doesn't have

const WIN_ANSI_CODES = new Map<string, number>();

/** The WinAnsiEncoding code for a character, or null. */
export function winAnsiCode(ch: string): number | null {
  if (WIN_ANSI_CODES.size === 0) {
    const table = winAnsiTable();
    for (let code = 32; code < 256; code++) {
      const c = table[code];
      if (c && !WIN_ANSI_CODES.has(c)) WIN_ANSI_CODES.set(c, code);
    }
    WIN_ANSI_CODES.set("\u00a0", 32);
  }
  return WIN_ANSI_CODES.get(ch) ?? null;
}

/** A standard font as a FontInfo, written with WinAnsiEncoding. */
export function standardFontInfo(name: StandardFont): FontInfo {
  const table = winAnsiTable();
  const widths = new Map<number, number>();
  const width = (code: number) => {
    let w = widths.get(code);
    if (w === undefined) {
      const ch = table[code];
      w = ch ? (standardWidth(name, ch) ?? 0) : 0;
      widths.set(code, w);
    }
    return w;
  };
  return {
    baseFont: name,
    problem: null,
    measurable: true,
    twoByte: false,
    width,
    unicode: (code) => table[code] ?? "",
    encode: (ch) => {
      const code = winAnsiCode(ch);
      return code !== null && width(code) > 0 ? code : null;
    },
    style: {
      serif: name.startsWith("Times"),
      mono: name.startsWith("Courier"),
      bold: name.includes("Bold"),
      italic: name.includes("Italic") || name.includes("Oblique"),
    },
    embedded: false,
  };
}

/** The standard font with a style: Helvetica, Times or Courier, bold and italic to match. */
export function standardFontFor(
  family: "Helvetica" | "Times" | "Courier",
  style: FontStyle,
): StandardFont {
  const { bold, italic } = style;
  if (family === "Times") {
    if (bold && italic) return "Times-BoldItalic";
    if (bold) return "Times-Bold";
    if (italic) return "Times-Italic";
    return "Times-Roman";
  }
  if (bold && italic) return `${family}-BoldOblique`;
  if (bold) return `${family}-Bold`;
  if (italic) return `${family}-Oblique`;
  return family;
}

/** A font dictionary for a standard font, with its widths so every viewer spaces it the same. */
export function standardFontObject(pdf: mupdf.PDFDocument, name: StandardFont): mupdf.PDFObject {
  const info = standardFontInfo(name);
  const dict = pdf.newDictionary();
  dict.put("Type", pdf.newName("Font"));
  dict.put("Subtype", pdf.newName("Type1"));
  dict.put("BaseFont", pdf.newName(name));
  dict.put("Encoding", pdf.newName("WinAnsiEncoding"));
  dict.put("FirstChar", 32);
  dict.put("LastChar", 255);
  const widths = pdf.newArray();
  for (let code = 32; code <= 255; code++) widths.push(Math.round(info.width(code)));
  dict.put("Widths", widths);
  return pdf.addObject(dict);
}
