// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whether a page is safe to hand to MuPDF to draw. MuPDF draws a form XObject, tiling pattern,
// soft mask or Type3 glyph by calling itself, and the WebAssembly build has a small stack: a
// page that nests about 30 of them (or a pattern that fills with itself) overflows it, which
// corrupts MuPDF's memory and kills the engine ("Out of bounds memory access"). The fuzzer
// found this with a 1 KB file. So before a page is drawn (shown, searched, exported, its text
// read or redacted), the nesting it can reach is measured here, and a page that nests too
// deeply, or contains itself, is refused with a message instead.
//
// What a content stream uses is read from the names in it (anything written /Name), which is
// quick and never misses a use. A name that only looks used (in a string, say) can only make
// the answer more careful, never less.

import type * as mupdf from "mupdf";

/** Deepest nesting allowed: MuPDF's stack overflows at around 26 patterns or 31 forms. */
export const MAX_DRAWING_DEPTH = 20;

/** At most this many drawings (forms, patterns, glyph procedures) are looked at per page. */
const MAX_NODES = 20_000;

/** Streams bigger than this aren't read: they're assumed to use every resource they have. */
const MAX_SCANNED_STREAM = 8 * 1024 * 1024;

/** And at most this much content is read for one page. */
const MAX_SCANNED_TOTAL = 64 * 1024 * 1024;

const TOO_DEEP =
  "This page can't be shown safely: its drawings are nested too deeply (the file may be damaged or made to crash PDF readers)";
const LOOP =
  "This page can't be shown safely: one of its drawings contains itself (the file may be damaged or made to crash PDF readers)";
const TOO_COMPLEX = "This page can't be shown safely: its drawings are too complex to check";

/** A drawing: content streams with the resources they're drawn with. */
interface Drawing {
  key: string;
  streams: mupdf.PDFObject[];
  resources: mupdf.PDFObject;
}

class Stop extends Error {}

class Checker {
  private nodes = 0;
  private scanned = 0;
  /** Depth reached below each finished drawing (itself included). */
  private readonly depth = new Map<string, number>();
  private readonly onPath = new Set<string>();
  /** Names used by each stream, by object number. */
  private readonly namesOf = new Map<number, Set<string> | null>();

  /** How deep drawing goes from here; throws Stop with the reason when it's too deep. */
  measure(drawing: Drawing, level: number): number {
    if (level > MAX_DRAWING_DEPTH) throw new Stop(TOO_DEEP);
    const known = this.depth.get(drawing.key);
    if (known !== undefined) {
      if (level - 1 + known > MAX_DRAWING_DEPTH) throw new Stop(TOO_DEEP);
      return known;
    }
    if (this.onPath.has(drawing.key)) throw new Stop(LOOP);
    if (++this.nodes > MAX_NODES) throw new Stop(TOO_COMPLEX);
    this.onPath.add(drawing.key);
    let deepest = 0;
    for (const child of this.children(drawing)) {
      deepest = Math.max(deepest, this.measure(child, level + 1));
    }
    this.onPath.delete(drawing.key);
    this.depth.set(drawing.key, deepest + 1);
    return deepest + 1;
  }

  /** The drawings this one draws: the forms, patterns, masks and Type3 fonts it uses. */
  private children(drawing: Drawing): Drawing[] {
    const resources = drawing.resources;
    if (!resources.isDictionary()) return [];
    const used = this.usedNames(drawing.streams);
    const out: Drawing[] = [];
    const each = (category: string, visit: (value: mupdf.PDFObject) => void) => {
      const dict = resources.get(category);
      if (!dict.isDictionary()) return;
      dict.forEach((value, key) => {
        if (used === null || used.has(String(key))) visit(value);
      });
    };
    const resKey = resources.isIndirect() ? `r${resources.asIndirect()}` : drawing.key;
    // A form or glyph with no resources of its own uses those of what draws it.
    const own = (object: mupdf.PDFObject) => {
      const r = object.get("Resources");
      return r.isDictionary() ? r : resources;
    };
    const drawingOf = (object: mupdf.PDFObject, streams: mupdf.PDFObject[], tag: string) => {
      const r = own(object);
      const id = object.isIndirect() ? String(object.asIndirect()) : `${drawing.key}/${tag}`;
      const rk = r === resources ? resKey : r.isIndirect() ? `r${r.asIndirect()}` : id;
      return { key: `${id}@${rk}`, streams, resources: r };
    };
    each("XObject", (x) => {
      if (x.isStream() && x.get("Subtype").asName() === "Form") {
        out.push(drawingOf(x, [x], "x"));
      }
    });
    each("Pattern", (p) => {
      if (p.isStream() && p.get("PatternType").asNumber() === 1) out.push(drawingOf(p, [p], "p"));
    });
    each("ExtGState", (gs) => {
      const g = gs.get("SMask").get("G");
      if (g.isStream()) out.push(drawingOf(g, [g], "g"));
    });
    each("Font", (font) => {
      if (font.get("Subtype").asName() !== "Type3") return;
      const procs: mupdf.PDFObject[] = [];
      const charProcs = font.get("CharProcs");
      if (charProcs.isDictionary()) {
        charProcs.forEach((proc) => {
          if (proc.isStream() && procs.length < 10_000) procs.push(proc);
        });
      }
      out.push(drawingOf(font, procs, "f"));
    });
    return out;
  }

  /** Every name in the streams, or null when they're too big to read (then all count). */
  private usedNames(streams: mupdf.PDFObject[]): Set<string> | null {
    const all = new Set<string>();
    for (const stream of streams) {
      const num = stream.isIndirect() ? stream.asIndirect() : -1;
      let names = num >= 0 ? this.namesOf.get(num) : undefined;
      if (names === undefined) {
        names = this.readNames(stream);
        if (num >= 0) this.namesOf.set(num, names);
      }
      if (names === null) return null;
      for (const name of names) all.add(name);
    }
    return all;
  }

  private readNames(stream: mupdf.PDFObject): Set<string> | null {
    const length = stream.get("Length").asNumber();
    if (length > MAX_SCANNED_STREAM || this.scanned + length > MAX_SCANNED_TOTAL) return null;
    let bytes: Uint8Array;
    try {
      const buffer = stream.readStream();
      try {
        bytes = buffer.asUint8Array();
        if (bytes.length > MAX_SCANNED_STREAM) return null;
        this.scanned += bytes.length;
        if (this.scanned > MAX_SCANNED_TOTAL) return null;
        return namesIn(bytes);
      } finally {
        buffer.destroy();
      }
    } catch {
      // A stream MuPDF can't decode draws nothing.
      return new Set();
    }
  }
}

const DELIMITER = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) DELIMITER[c] = 1;
for (const c of "()<>[]{}/%") DELIMITER[c.charCodeAt(0)] = 1;

/** Every /Name in the bytes, with #xx escapes decoded. */
export function namesIn(bytes: Uint8Array): Set<string> {
  const names = new Set<string>();
  const n = bytes.length;
  for (let i = 0; i < n; i++) {
    if (bytes[i] !== 0x2f) continue;
    let j = i + 1;
    while (j < n && !DELIMITER[bytes[j] as number]) j++;
    let name = "";
    for (let k = i + 1; k < j; k++) {
      const c = bytes[k] as number;
      if (c === 0x23 && k + 2 < j) {
        const code = Number.parseInt(
          String.fromCharCode(bytes[k + 1] as number, bytes[k + 2] as number),
          16,
        );
        if (!Number.isNaN(code)) {
          name += String.fromCharCode(code);
          k += 2;
          continue;
        }
      }
      name += String.fromCharCode(c);
    }
    names.add(name);
    i = j - 1;
  }
  return names;
}

/** The page's content streams. */
function contentStreams(page: mupdf.PDFObject): mupdf.PDFObject[] {
  const contents = page.get("Contents");
  if (contents.isStream()) return [contents];
  const out: mupdf.PDFObject[] = [];
  if (contents.isArray()) {
    for (let i = 0; i < contents.length && i < 10_000; i++) {
      const item = contents.get(i);
      if (item.isStream()) out.push(item);
    }
  }
  return out;
}

/** The appearance streams of the page's annotations (normal, rollover and down). */
function appearances(page: mupdf.PDFObject): mupdf.PDFObject[] {
  const annots = page.get("Annots");
  const out: mupdf.PDFObject[] = [];
  if (!annots.isArray()) return out;
  for (let i = 0; i < annots.length && out.length < 10_000; i++) {
    const ap = annots.get(i).get("AP");
    if (!ap.isDictionary()) continue;
    for (const kind of ["N", "R", "D"]) {
      const entry = ap.get(kind);
      if (entry.isStream()) out.push(entry);
      else if (entry.isDictionary()) {
        entry.forEach((state) => {
          if (state.isStream() && out.length < 10_000) out.push(state);
        });
      }
    }
  }
  return out;
}

/**
 * Why the page (its object from the page tree) can't be drawn safely, or null if it can.
 * Its content and every annotation's appearance are checked.
 */
export function drawingProblem(page: mupdf.PDFObject): string | null {
  const checker = new Checker();
  const resources = page.getInheritable("Resources");
  const id = page.isIndirect() ? page.asIndirect() : -1;
  try {
    checker.measure({ key: `page${id}`, streams: contentStreams(page), resources }, 1);
    for (const ap of appearances(page)) {
      const own = ap.get("Resources");
      const key = ap.isIndirect() ? `ap${ap.asIndirect()}` : `ap${id}`;
      checker.measure({ key, streams: [ap], resources: own }, 2);
    }
    return null;
  } catch (err) {
    if (err instanceof Stop) return err.message;
    throw err;
  }
}
