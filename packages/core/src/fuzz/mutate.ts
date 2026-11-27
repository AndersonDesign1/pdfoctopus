// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ways to damage a PDF: blind byte-level damage (flipped bytes, truncation, deleted and
// duplicated ranges) and damage aimed at the structure a reader relies on (cross-reference
// offsets, stream lengths, object numbers, references, nesting, sizes, filters, encryption,
// fonts and images). Every mutation is deterministic for a given random generator.

import type { Rng } from "./random";

export type Mutator = (bytes: Uint8Array, rng: Rng) => Uint8Array;

const decoder = new TextDecoder("latin1");
const toText = (bytes: Uint8Array) => decoder.decode(bytes);
const toBytes = (text: string) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Every match of a regular expression (with the g flag) in the text. */
function matches(text: string, pattern: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m && out.length < 100_000; m = pattern.exec(text)) {
    out.push(m);
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return out;
}

/** Replace one randomly chosen match of `pattern` with `replace(match)`. */
function replaceOne(
  bytes: Uint8Array,
  rng: Rng,
  pattern: RegExp,
  replace: (m: RegExpExecArray) => string,
): Uint8Array {
  const text = toText(bytes);
  const found = matches(text, pattern);
  if (found.length === 0) return flipBytes(bytes, rng);
  const m = rng.pick(found);
  return toBytes(text.slice(0, m.index) + replace(m) + text.slice(m.index + m[0].length));
}

/** Numbers that tend to break readers. */
const EVIL_NUMBERS = [
  "0",
  "-1",
  "1",
  "-2147483648",
  "2147483647",
  "4294967295",
  "9007199254740993",
  "1e30",
  "-1e30",
  "1e-30",
  "99999999999999999999",
  "3.5",
  "-0",
  ".",
  "--5",
  "65536",
  "255",
  "256",
];

function evilNumber(rng: Rng, original?: number): string {
  if (original !== undefined && rng.chance(0.4)) {
    const delta = rng.pick([1, -1, 2, -7, 100, -100, 4096]);
    return String(original + delta);
  }
  return rng.pick(EVIL_NUMBERS);
}

// ---- Blind byte damage ------------------------------------------------------------------

export const flipBytes: Mutator = (bytes, rng) => {
  if (bytes.length === 0) return Uint8Array.of(rng.int(256));
  const out = bytes.slice();
  const count = rng.range(1, 32);
  for (let i = 0; i < count; i++) {
    const at = rng.int(out.length);
    out[at] = rng.chance(0.5) ? (out[at] as number) ^ (1 << rng.int(8)) : rng.int(256);
  }
  return out;
};

export const truncate: Mutator = (bytes, rng) => bytes.slice(0, rng.int(bytes.length));

export const deleteRange: Mutator = (bytes, rng) => {
  if (bytes.length < 2) return bytes.slice();
  const start = rng.int(bytes.length);
  const length = rng.range(
    1,
    Math.max(1, Math.min(bytes.length - start, rng.chance(0.5) ? 64 : 8192)),
  );
  return concat(bytes.subarray(0, start), bytes.subarray(start + length));
};

export const duplicateRange: Mutator = (bytes, rng) => {
  if (bytes.length < 2) return bytes.slice();
  const start = rng.int(bytes.length);
  const length = rng.range(1, Math.max(1, Math.min(bytes.length - start, 4096)));
  const at = rng.int(bytes.length);
  const copy = bytes.slice(start, start + length);
  const times = rng.chance(0.2) ? rng.range(2, 50) : 1;
  return concat(bytes.subarray(0, at), ...Array<Uint8Array>(times).fill(copy), bytes.subarray(at));
};

/** Overwrite a run of bytes with one value (a run of zeros, spaces or 0xFF). */
export const smearRange: Mutator = (bytes, rng) => {
  if (bytes.length === 0) return bytes.slice();
  const out = bytes.slice();
  const start = rng.int(out.length);
  out.fill(rng.pick([0, 0x20, 0xff, 0x28, 0x5b]), start, start + rng.range(1, 512));
  return out;
};

// ---- Structure-aware damage -------------------------------------------------------------

export const breakStartxref: Mutator = (bytes, rng) =>
  replaceOne(
    bytes,
    rng,
    /startxref\s+(\d+)/g,
    (m) => `startxref\n${evilNumber(rng, Number(m[1]))}`,
  );

export const breakXrefEntry: Mutator = (bytes, rng) =>
  replaceOne(bytes, rng, /(\d{10}) (\d{5}) ([nf])/g, (m) => {
    switch (rng.int(4)) {
      case 0:
        return `${String(rng.int(Number(m[1]) * 2 + 10)).padStart(10, "0")} ${m[2]} ${m[3]}`;
      case 1:
        return `${m[1]} ${m[2]} ${m[3] === "n" ? "f" : "n"}`;
      case 2:
        return `9999999999 ${m[2]} n`;
      default:
        return `${m[1]} 65535 ${m[3]}`;
    }
  });

export const breakXrefHeader: Mutator = (bytes, rng) =>
  replaceOne(
    bytes,
    rng,
    /xref\s+(\d+) (\d+)/g,
    () => `xref\n${evilNumber(rng)} ${evilNumber(rng)}`,
  );

export const breakTrailer: Mutator = (bytes, rng) =>
  replaceOne(bytes, rng, /\/(Size|Prev|XRefStm|Root|Info) (\d+)( 0 R)?/g, (m) =>
    rng.chance(0.3)
      ? `/${m[1]} ${rng.int(30)} 0 R`
      : `/${m[1]} ${evilNumber(rng, Number(m[2]))}${m[3] ?? ""}`,
  );

export const corruptLength: Mutator = (bytes, rng) =>
  replaceOne(bytes, rng, /\/Length (\d+)( 0 R)?/g, (m) =>
    rng.chance(0.2) ? `/Length ${rng.int(50)} 0 R` : `/Length ${evilNumber(rng, Number(m[1]))}`,
  );

export const swapObjectNumbers: Mutator = (bytes, rng) => {
  const text = toText(bytes);
  const headers = matches(text, /(?<!\d)(\d{1,10}) (\d{1,5}) obj/g);
  if (headers.length < 2) return flipBytes(bytes, rng);
  const a = rng.pick(headers);
  const b = rng.pick(headers);
  const [first, second] = a.index < b.index ? [a, b] : [b, a];
  if (first === second) return flipBytes(bytes, rng);
  return toBytes(
    text.slice(0, first.index) +
      second[0] +
      text.slice(first.index + first[0].length, second.index) +
      first[0] +
      text.slice(second.index + second[0].length),
  );
};

/** Point a reference at another object (often making a loop) or at none. */
export const redirectReference: Mutator = (bytes, rng) => {
  const text = toText(bytes);
  const objects = matches(text, /(?<!\d)(\d{1,10}) 0 obj/g).map((m) => Number(m[1]));
  return replaceOne(bytes, rng, /(?<!\d)(\d{1,10}) (\d{1,5}) R/g, () => {
    const target =
      objects.length && rng.chance(0.8) ? rng.pick(objects) : rng.pick([0, 999999, 2147483647]);
    return `${target} 0 R`;
  });
};

/** Point a /Parent, /Kids, /First, /Next … at its own object, to make a loop. */
export const makeLoop: Mutator = (bytes, rng) => {
  const text = toText(bytes);
  const headers = matches(text, /(?<!\d)(\d{1,10}) 0 obj/g);
  if (headers.length === 0) return flipBytes(bytes, rng);
  const header = rng.pick(headers);
  const end = text.indexOf("endobj", header.index);
  if (end < 0) return flipBytes(bytes, rng);
  const body = text.slice(header.index, end);
  const self = `${header[1]} 0 R`;
  const keys = [
    "Parent",
    "Kids",
    "First",
    "Next",
    "Last",
    "Prev",
    "Popup",
    "IRT",
    "Dests",
    "Resources",
    "SMask",
    "Encoding",
    "DescendantFonts",
  ];
  const patched = body.replace(
    /<</,
    `<</${rng.pick(keys)} ${rng.chance(0.5) ? `[${self}]` : self} `,
  );
  return toBytes(text.slice(0, header.index) + patched + text.slice(end));
};

export const deepNesting: Mutator = (bytes, rng) => {
  const text = toText(bytes);
  const spots = matches(text, /<<|\[/g);
  const at = spots.length ? rng.pick(spots).index : rng.int(text.length);
  const depth = rng.pick([100, 1_000, 10_000, 100_000]);
  const [open, close] = rng.chance(0.5) ? ["[", "]"] : ["<</A ", ">>"];
  const insertion = `/Deep ${open.repeat(depth)}1${rng.chance(0.7) ? close.repeat(depth) : ""} `;
  const offset = text.startsWith("<<", at) ? at + 2 : at + 1;
  return toBytes(text.slice(0, offset) + insertion + text.slice(offset));
};

export const hugeNumber: Mutator = (bytes, rng) =>
  replaceOne(
    bytes,
    rng,
    /\/(Count|Width|Height|W|H|BitsPerComponent|BPC|Columns|Rows|Colors|Predictor|N|First|Size|Rotate|FirstChar|LastChar|St|K|Length1|Length2|MaxLen|Ff|Q|HiVal|DW|UserUnit) (-?\d+(\.\d+)?)/g,
    (m) => `/${m[1]} ${evilNumber(rng, Number(m[2]))}`,
  );

export const breakBox: Mutator = (bytes, rng) =>
  replaceOne(
    bytes,
    rng,
    /\/(MediaBox|CropBox|BBox|Rect|FontBBox|Matrix|FontMatrix) ?\[[^\]]*\]/g,
    (m) => {
      const values = Array.from({ length: rng.pick([0, 2, 4, 4, 4, 6, 9]) }, () => evilNumber(rng));
      return `/${m[1]} [${values.join(" ")}]`;
    },
  );

const FILTERS = [
  "/FlateDecode",
  "/LZWDecode",
  "/ASCIIHexDecode",
  "/ASCII85Decode",
  "/RunLengthDecode",
  "/CCITTFaxDecode",
  "/DCTDecode",
  "/JPXDecode",
  "/JBIG2Decode",
  "/Crypt",
  "/BrotliDecode",
  "/NoSuchDecode",
];

export const badFilter: Mutator = (bytes, rng) => {
  const text = toText(bytes);
  const filters = matches(text, /\/Filter ?(\/\w+|\[[^\]]*\])/g);
  const streams = matches(text, />>\s*stream\r?\n/g);
  const params = `/DecodeParms <</Predictor ${rng.pick(["2", "10", "15", "99", "-1"])} /Columns ${evilNumber(rng)} /Colors ${evilNumber(rng)} /BitsPerComponent ${rng.pick(["1", "3", "16", "0", "64"])} /EarlyChange ${rng.pick(["0", "1", "7"])}>>`;
  if (filters.length && rng.chance(0.6)) {
    const m = rng.pick(filters);
    const replacement = rng.chance(0.3)
      ? `/Filter [${Array.from({ length: rng.range(2, 6) }, () => rng.pick(FILTERS)).join(" ")}]`
      : `/Filter ${rng.pick(FILTERS)}${rng.chance(0.5) ? ` ${params}` : ""}`;
    return toBytes(text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length));
  }
  if (streams.length === 0) return flipBytes(bytes, rng);
  // Just before the stream dictionary's closing ">>".
  const m = rng.pick(streams);
  const insertion = ` /Filter ${rng.pick(FILTERS)} ${rng.chance(0.5) ? params : ""}`;
  return toBytes(text.slice(0, m.index) + insertion + text.slice(m.index));
};

export const breakEncryption: Mutator = (bytes, rng) =>
  replaceOne(
    bytes,
    rng,
    /\/(V|R|Length|P|O|U|OE|UE|Perms|CFM|StmF|StrF|EncryptMetadata) ?(-?\d+|<[0-9a-fA-F]*>|\([^)]*\)|\/\w+|true|false)/g,
    (m) => {
      const values = [
        "<>",
        "<00>",
        `<${"ff".repeat(rng.range(1, 64))}>`,
        "/None",
        "/AESV3",
        "/V2",
        "true",
        "(x)",
        evilNumber(rng),
      ];
      return `/${m[1]} ${rng.pick(values)}`;
    },
  );

export const breakFont: Mutator = (bytes, rng) =>
  replaceOne(
    bytes,
    rng,
    /\/(Subtype|BaseFont|Encoding|FontFile2?3?|ToUnicode|DescendantFonts|Widths|W|CIDToGIDMap) ?(\/[\w+#-]+|\d+ 0 R|\[[^\]]*\])/g,
    (m) => {
      const values = [
        "/Type0",
        "/Type3",
        "/TrueType",
        "/Identity-V",
        "/Junk",
        "[]",
        "[1 2 (x)]",
        "1 0 R",
        "/Identity",
        `${rng.int(40)} 0 R`,
      ];
      return `/${m[1]} ${rng.pick(values)}`;
    },
  );

export const breakImage: Mutator = (bytes, rng) =>
  replaceOne(
    bytes,
    rng,
    /\/(ColorSpace|CS|BitsPerComponent|BPC|ImageMask|Decode|SMask|Mask|Interpolate|Intent) ?(\/\w+|-?\d+|\[[^\]]*\]|\d+ 0 R|true|false)/g,
    (m) => {
      const values = [
        "/DeviceCMYK",
        "/Pattern",
        "[/Indexed /DeviceRGB 255 <00>]",
        "[/ICCBased 1 0 R]",
        "[/Separation /A /DeviceRGB 1 0 R]",
        "[/DeviceN [/A /B] /DeviceGray 1 0 R]",
        "true",
        "[1 0]",
        "/Lab",
        "3",
        "16",
        "0",
      ];
      return `/${m[1]} ${rng.pick(values)}`;
    },
  );

/** Garble a run of bytes inside a stream (content, font program or image data). */
export const garbleStream: Mutator = (bytes, rng) => {
  const text = toText(bytes);
  const streams = matches(text, /stream\r?\n/g);
  if (streams.length === 0) return flipBytes(bytes, rng);
  const m = rng.pick(streams);
  const start = m.index + m[0].length;
  const end = text.indexOf("endstream", start);
  if (end <= start) return flipBytes(bytes, rng);
  const out = bytes.slice();
  const count = rng.range(1, 64);
  for (let i = 0; i < count; i++) out[start + rng.int(end - start)] = rng.int(256);
  return out;
};

/** Content-stream operators with wrong operands, deep q nesting or bogus inline images. */
export const breakContent: Mutator = (bytes, rng) => {
  const text = toText(bytes);
  const streams = matches(text, /stream\r?\n/g);
  if (streams.length === 0) return flipBytes(bytes, rng);
  const m = rng.pick(streams);
  const start = m.index + m[0].length;
  const junk = rng.pick([
    `${"q ".repeat(rng.range(10, 5000))}`,
    "Q Q Q Q ET ET EMC EMC ",
    "BT /F1 1e30 Tf 1e30 1e30 Td (x) Tj ET ",
    "/NoSuchFont 12 Tf (x) Tj ",
    "BI /W 99999 /H 99999 /BPC 8 /CS /RGB ID \x00 EI ",
    "/X0 Do /Nope Do /Pattern cs /P0 scn 0 0 1 1 re f ",
    "1 2 3 4 5 6 7 8 9 cm 0 0 0 0 0 0 cm 0 0 m 1e38 1e38 l S ",
    "[1 2 3] 0 d 1e30 w 0 J 9 j ",
    "/GS0 gs /Sh0 sh /Fm0 Do ",
    "(unterminated string ",
    "<abc ",
    "[[[[[[[[[[[[ ",
  ]);
  return toBytes(text.slice(0, start) + junk + text.slice(start));
};

export const MUTATORS: Record<string, Mutator> = {
  flipBytes,
  truncate,
  deleteRange,
  duplicateRange,
  smearRange,
  breakStartxref,
  breakXrefEntry,
  breakXrefHeader,
  breakTrailer,
  corruptLength,
  swapObjectNumbers,
  redirectReference,
  makeLoop,
  deepNesting,
  hugeNumber,
  breakBox,
  badFilter,
  breakEncryption,
  breakFont,
  breakImage,
  garbleStream,
  breakContent,
};

export const MUTATOR_NAMES = Object.keys(MUTATORS);

/**
 * Apply one to three mutations, chosen by `rng`. Returns the damaged bytes and the names of
 * the mutations, for the report.
 */
export function mutate(bytes: Uint8Array, rng: Rng): { bytes: Uint8Array; steps: string[] } {
  let out = bytes;
  const steps: string[] = [];
  const count = rng.chance(0.6) ? 1 : rng.range(2, 3);
  for (let i = 0; i < count; i++) {
    const name = rng.pick(MUTATOR_NAMES);
    out = (MUTATORS[name] as Mutator)(out, rng);
    steps.push(name);
  }
  return { bytes: out, steps };
}
